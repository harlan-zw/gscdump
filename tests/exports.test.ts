import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { getPackageExportsManifest } from 'vitest-package-exports'

function runtimeExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string')
    return value.endsWith('.mjs') ? value : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  return Object.values(value as Record<string, unknown>)
    .map(runtimeExportTarget)
    .find(target => target !== undefined)
}

describe('exports-snapshot', async () => {
  const packageDirs = await readdir(join(process.cwd(), 'packages'), { withFileTypes: true })
  const packages = await Promise.all(
    packageDirs
      .filter(entry => entry.isDirectory())
      .map(async (entry) => {
        const path = join(process.cwd(), 'packages', entry.name)
        if (!existsSync(join(path, 'package.json')))
          return null
        const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
        return {
          name: pkg.name as string,
          path,
          private: pkg.private as boolean | undefined,
          runtimeExport: runtimeExportTarget(pkg.exports),
        }
      }),
  )

  for (const pkg of packages.filter(pkg => pkg !== null)) {
    if (pkg.private)
      continue
    const hasBuild = pkg.runtimeExport !== undefined
      && existsSync(join(pkg.path, pkg.runtimeExport))
    it.skipIf(!hasBuild)(`${pkg.name}`, async () => {
      const manifest = await getPackageExportsManifest({
        importMode: 'dist',
        cwd: pkg.path,
      })
      await expect(dump(manifest.exports, { sortKeys: (a, b) => a.localeCompare(b) }))
        .toMatchFileSnapshot(`./exports/${pkg.name.split('/').pop()}.yaml`)
    })
    if (!hasBuild) {
      console.warn(`[exports-snapshot] skipping ${pkg.name} — no built export. Run \`pnpm -r run build\` to exercise this test.`)
    }
  }
})
