import type { BuildConfig } from 'obuild/config'
import { Buffer } from 'node:buffer'
import { relative, resolve } from 'node:path'
import { rolldown } from 'rolldown'

export interface TreeShakeBuildContext {
  pkg: {
    name?: string
    sideEffects?: unknown
    exports?: unknown
  }
  pkgDir: string
}

type TreeShakeCheckResult
  = | { _tag: 'TreeShakable' }
    | { _tag: 'TreeShakeError', details: string }

function runtimeExportTarget(value: unknown): string | null {
  if (typeof value === 'string')
    return value.endsWith('.mjs') ? value : null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null

  const conditions = value as Record<string, unknown>
  return runtimeExportTarget(conditions.import) ?? runtimeExportTarget(conditions.default)
}

function runtimeExportTargets(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return []

  return [...new Set(
    Object.values(value as Record<string, unknown>)
      .map(runtimeExportTarget)
      .filter((target): target is string => target !== null),
  )]
}

async function emittedSideEffects(packageDir: string, target: string): Promise<{
  bytes: number
  modules: string[]
}> {
  const entry = resolve(packageDir, target)
  const bundle = await rolldown({
    cwd: packageDir,
    input: '#side-effect-entry',
    logLevel: 'silent',
    platform: 'neutral',
    external: id => id[0] !== '.' && !id.startsWith(packageDir),
    plugins: [{
      name: 'side-effect-entry',
      resolveId(id) {
        if (id === '#side-effect-entry')
          return id
      },
      load(id) {
        if (id === '#side-effect-entry')
          return `import ${JSON.stringify(entry)}`
      },
    }],
  })
  const { output } = await bundle.generate({ codeSplitting: false })
    .finally(() => bundle.close())
  const chunks = output.filter(item => item.type === 'chunk')

  return {
    bytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code.trim()), 0),
    modules: [...new Set(chunks.flatMap(chunk =>
      Object.entries(chunk.modules)
        .filter(([, module]) => module.renderedLength > 0)
        .map(([id]) => relative(packageDir, id)),
    ))].sort(),
  }
}

export async function checkPackageTreeShaking(ctx: TreeShakeBuildContext): Promise<TreeShakeCheckResult> {
  const packageName = ctx.pkg.name ?? ctx.pkgDir

  if (ctx.pkg.sideEffects !== false) {
    return {
      _tag: 'TreeShakeError',
      details: `${packageName}: package.json must declare "sideEffects": false`,
    }
  }

  const targets = runtimeExportTargets(ctx.pkg.exports)
  if (targets.length === 0) {
    return {
      _tag: 'TreeShakeError',
      details: `${packageName}: package.json has no ESM export targets`,
    }
  }

  const results = await Promise.all(targets.map(async target => ({
    ...await emittedSideEffects(ctx.pkgDir, target),
    target,
  })))
  const failures = results.filter(result => result.bytes > 0)
  if (failures.length > 0) {
    return {
      _tag: 'TreeShakeError',
      details: failures.map((failure) => {
        const listedModules = failure.modules.slice(0, 8).join(', ')
        const remainingModules = failure.modules.length - 8
        const moduleSummary = remainingModules > 0
          ? `${listedModules}, +${remainingModules} more`
          : listedModules
        return `${packageName} ${failure.target}: ${failure.bytes} side-effect bytes (${moduleSummary})`
      }).join('\n'),
    }
  }

  return { _tag: 'TreeShakable' }
}

export function defineBuildConfig(config: BuildConfig): BuildConfig {
  const configuredOutput = config.hooks?.rolldownOutput
  const configuredEnd = config.hooks?.end

  return {
    ...config,
    hooks: {
      ...config.hooks,
      async rolldownOutput(output, build, ctx) {
        await configuredOutput?.(output, build, ctx)
        output.preserveModules = true
        output.preserveModulesRoot = resolve(ctx.pkgDir, 'src')
        delete output.codeSplitting
      },
      async end(ctx) {
        await configuredEnd?.(ctx)
        const result = await checkPackageTreeShaking(ctx)
        if (result._tag === 'TreeShakeError')
          throw new Error(result.details)
      },
    },
  }
}
