import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPackageTreeShaking } from '../scripts/build-config'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('shared package build config', () => {
  it('accepts a bin-only package without importable exports', async () => {
    const packageDir = await mkdtemp(join(tmpdir(), 'gscdump-bin-only-'))
    temporaryDirectories.push(packageDir)

    const result = await checkPackageTreeShaking({
      pkg: {
        name: 'bin-only-fixture',
        sideEffects: false,
        exports: {},
        bin: {
          fixture: './bin/fixture.mjs',
        },
      },
      pkgDir: packageDir,
    })

    expect(result._tag).toBe('TreeShakable')
  })

  it('detects import-time effects even when package metadata declares none', async () => {
    const packageDir = await mkdtemp(join(tmpdir(), 'gscdump-tree-shake-'))
    temporaryDirectories.push(packageDir)
    await mkdir(join(packageDir, 'dist'))
    await writeFile(
      join(packageDir, 'dist/index.mjs'),
      'globalThis.gscdumpBuildConfigTest = true\nexport const value = 1\n',
    )

    const result = await checkPackageTreeShaking({
      pkg: {
        name: 'side-effect-fixture',
        sideEffects: false,
        exports: {
          '.': {
            import: './dist/index.mjs',
          },
        },
      },
      pkgDir: packageDir,
    })

    expect(result._tag).toBe('TreeShakeError')
  })

  it.each(['native', 'slashes', 'relative'])('resolves a package using %s paths before checking effects', async (format) => {
    const packageDir = await mkdtemp(join(tmpdir(), 'gscdump build paths '))
    temporaryDirectories.push(packageDir)
    await mkdir(join(packageDir, 'dist'))
    await writeFile(join(packageDir, 'dist/index.mjs'), 'export const value = 1\n')
    const pkgDir = format === 'relative'
      ? relative(process.cwd(), packageDir)
      : format === 'slashes' ? packageDir.replaceAll('\\', '/') : packageDir

    const result = await checkPackageTreeShaking({
      pkg: { name: 'pure-fixture', sideEffects: false, exports: { '.': './dist/index.mjs' } },
      pkgDir,
    })

    expect(result).toEqual({ _tag: 'TreeShakable' })
  })
})
