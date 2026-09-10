import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { CLI_SUBCOMMANDS } from '../src/command-registry'
import { skillSourceDirectory } from '../src/skill'

/**
 * The skill is what an agent believes about the binary. A command the skill
 * names that the binary lacks reads as a lie to an agent on the wrong version;
 * a command the binary has that the skill omits is invisible to it. Both fail.
 */
describe('skill command parity', () => {
  const skillPath = `${skillSourceDirectory(new URL('../src/cli.ts', import.meta.url).href)}/SKILL.md`

  it('names every registered top-level command and no unknown one', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const mentioned = new Set(
      [...skill.matchAll(/`gscdump ([a-z][a-z-]*)/g)].map(match => match[1]!),
    )
    const registered = new Set(Object.keys(CLI_SUBCOMMANDS))

    const documentedButAbsent = [...mentioned].filter(name => !registered.has(name))
    const undocumented = [...registered].filter(name => !mentioned.has(name))

    expect({ documentedButAbsent, undocumented }).toEqual({ documentedButAbsent: [], undocumented: [] })
  })

  it('names every Report id the registry ships', async () => {
    const { REPORTS } = await import('@gscdump/analysis/report')
    const skill = await readFile(skillPath, 'utf8')
    const missing = REPORTS.map(report => report.id).filter(id => !skill.includes(`\`${id}\``))
    expect(missing).toEqual([])
  })
})
