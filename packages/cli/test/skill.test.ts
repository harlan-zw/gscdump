import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSkill, skillDestination, skillSourceDirectory } from '../src/skill'

const scratch: string[] = []

afterEach(async () => {
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
