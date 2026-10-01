import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli'
import { createCliRuntime } from '../src/runtime'
import { installSkill, skillDestination, skillSourceDirectory } from '../src/skill'

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
