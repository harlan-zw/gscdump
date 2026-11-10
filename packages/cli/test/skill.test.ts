import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { createCliRuntime } from '../src/runtime'
import { inspectSkillInstallation, installSkill, skillDestination, skillSourceDirectory } from '../src/skill'

const scratch: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gscdump-skill-'))
  scratch.push(dir)
  return dir
}

describe('installSkill', () => {
  it('preserves the working installation when the replacement artifact is invalid', async () => {
    const home = await tmpDir()
    const source = await tmpDir()
    const invalid = await tmpDir()
    await writeFile(path.join(source, 'SKILL.md'), 'Use retained evidence.')
    await installSkill({ agent: 'codex', homeDirectory: home, sourceDirectory: source })
    await cp(source, invalid, { recursive: true })
    await symlink(path.join(source, 'SKILL.md'), path.join(invalid, 'invalid-reference'))
    await expect(installSkill({ agent: 'codex', homeDirectory: home, sourceDirectory: invalid })).resolves.toMatchObject({ _tag: 'Err' })
    await expect(inspectSkillInstallation({ agent: 'codex', homeDirectory: home, sourceDirectory: source })).resolves.toMatchObject({ state: 'current' })
  })
  it('detects changed skill references even when the declared version stays the same', async () => {
    const home = await tmpDir()
    const source = await tmpDir()
    await mkdir(path.join(source, 'references'))
    await writeFile(path.join(source, 'SKILL.md'), '---\nversion: 7.12.0\n---\nRead references/commands.md.')
    await writeFile(path.join(source, 'references/commands.md'), 'Read retained evidence.')
    await installSkill({ agent: 'codex', homeDirectory: home, sourceDirectory: source })
    await expect(inspectSkillInstallation({ agent: 'codex', homeDirectory: home, sourceDirectory: source })).resolves.toMatchObject({ state: 'current' })
    await writeFile(path.join(source, 'references/commands.md'), 'Read retained evidence. Report the request ID.')
    await expect(inspectSkillInstallation({ agent: 'codex', homeDirectory: home, sourceDirectory: source })).resolves.toMatchObject({ state: 'stale' })
    await installSkill({ agent: 'codex', homeDirectory: home, sourceDirectory: source })
    await expect(inspectSkillInstallation({ agent: 'codex', homeDirectory: home, sourceDirectory: source })).resolves.toMatchObject({ state: 'current' })
  })
  it('copies the packaged SKILL.md into the agent home directory', async () => {
    const home = await tmpDir()
    const result = await installSkill({ agent: 'claude', homeDirectory: home })
    expect(result._tag).toBe('Ok')
    if (result._tag !== 'Ok')
      return
    expect(result.installation.destination).toBe(skillDestination(home, 'claude'))
    const skill = await readFile(path.join(result.installation.destination, 'SKILL.md'), 'utf8')
    expect(skill).toMatch(/^---\nname: gscdump\n/)
  })

  it('writes under --target when given', async () => {
    const target = await tmpDir()
    const result = await installSkill({ agent: 'codex', homeDirectory: '/nowhere', target })
    expect(result._tag).toBe('Ok')
    if (result._tag === 'Ok')
      expect(result.installation.destination).toBe(path.join(target, 'gscdump'))
  })

  it('reports a missing packaged skill instead of throwing', async () => {
    const home = await tmpDir()
    const result = await installSkill({ agent: 'claude', homeDirectory: home, sourceDirectory: path.join(home, 'missing') })
    expect(result).toMatchObject({ _tag: 'Err', reason: 'source_missing' })
  })

  it('resolves the skill next to the built module', () => {
    expect(skillSourceDirectory('file:///pkg/dist/cli.mjs')).toBe(path.join('/pkg', 'skills', 'gscdump'))
  })
})

describe('gscdump skill install', () => {
  // 2026-10-01 UX replay: run from the home directory, the command printed
  // `.claude/skills/gscdump`, so an agent could not tell where the skill was.
  it('prints a skill path that works from any directory', async () => {
    const home = await tmpDir()
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    vi.spyOn(process, 'cwd').mockReturnValue(home)
    let stderr = ''
    const runtime = createCliRuntime({
      configDir: path.join(home, 'config'),
      environment: {},
      stderr: {
        write: (chunk: string) => {
          stderr += chunk
          return true
        },
      } as unknown as NodeJS.WriteStream,
    })
    runtime.logger.level = 3

    await expect(runCli({ rawArgs: ['skill', 'install', '--agent', 'claude'], runtime })).resolves.toBe(0)

    expect(stderr).toContain('Installed the gscdump skill for claude at ~/.claude/skills/gscdump')
  })
})
