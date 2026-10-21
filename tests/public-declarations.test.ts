import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

const root = process.cwd()
const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

interface PackageManifest {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

async function declarationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.d.mts'))
    .map(entry => join(entry.parentPath, entry.name))
}

function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

// A bare specifier in a published declaration resolves for a consumer only
// when the package declares that module as an installed dependency. A bundled
// dependency such as `icebird` is absent from consumer installs, so a leaked
// `icebird/...` specifier silently degrades the type to `any`.
function unresolvableSpecifiers(source: string, manifest: PackageManifest): string[] {
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const builtins = new Set(builtinModules)
  const specifiers = ts.preProcessFile(source, true, false).importedFiles.map(file => file.fileName)
  return specifiers.filter((specifier) => {
    if (specifier.startsWith('.') || specifier.startsWith('node:'))
      return false
    const name = packageName(specifier)
    return !builtins.has(name) && !declared.has(name) && !declared.has(`@types/${name}`)
  })
}

const packageDirs = existsSync(join(root, 'packages'))
  ? (await readdir(join(root, 'packages'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'dist')))
      .map(entry => join(root, 'packages', entry.name))
  : []

describe.skipIf(packageDirs.length === 0)('published declarations', () => {
  it('import only modules that consumers install', async () => {
    const leaks: string[] = []
    for (const packageDir of packageDirs) {
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as PackageManifest
      if (manifest.private)
        continue
      for (const file of await declarationFiles(join(packageDir, 'dist'))) {
        for (const specifier of unresolvableSpecifiers(await readFile(file, 'utf8'), manifest))
          leaks.push(`${relative(root, file)}: ${specifier}`)
      }
    }
    expect(leaks).toEqual([])
  })
})

const lakehouseDir = join(root, 'packages/lakehouse')

describe.skipIf(!existsSync(join(lakehouseDir, 'dist/index.d.mts')))('@gscdump/lakehouse consumer types', () => {
  it('types IcebergConnection.resolver without icebird installed', async () => {
    const consumerDir = await mkdtemp(join(tmpdir(), 'gscdump-lakehouse-consumer-'))
    temporaryDirectories.push(consumerDir)
    // Copy the package so its own `node_modules` (which holds icebird) stays
    // unreachable, as in a consumer install.
    const installedDir = join(consumerDir, 'node_modules/@gscdump/lakehouse')
    await mkdir(installedDir, { recursive: true })
    await cp(join(lakehouseDir, 'package.json'), join(installedDir, 'package.json'))
    await cp(join(lakehouseDir, 'dist'), join(installedDir, 'dist'), { recursive: true })
    const consumerFile = join(consumerDir, 'consumer.ts')
    await writeFile(consumerFile, [
      `import type { IcebergConnection } from '@gscdump/lakehouse'`,
      `type IsAny<T> = 0 extends 1 & T ? true : false`,
      `export const resolverIsAny: IsAny<IcebergConnection['resolver']> = false`,
      '',
    ].join('\n'))

    const program = ts.createProgram([consumerFile], {
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ['node'],
      typeRoots: [join(lakehouseDir, 'node_modules/@types')],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    )
    expect(diagnostics).toEqual([])
  })
})
