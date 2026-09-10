import { cp, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'gscdump'

export const SKILL_AGENTS = ['claude', 'codex'] as const
export type SkillAgent = typeof SKILL_AGENTS[number]

const AGENT_DIRECTORIES: Record<SkillAgent, string> = {
  claude: '.claude',
  codex: '.codex',
}

export interface SkillInstallation {
  agent: SkillAgent
  source: string
  destination: string
}

export type SkillInstallResult
  = | { _tag: 'Ok', installation: SkillInstallation }
    | { _tag: 'Err', reason: 'source_missing' | 'write_failed', message: string }

/**
 * The skill ships inside the package next to `dist/`. A global install puts it
 * outside any project, so resolve it from this module rather than from cwd.
 */
export function skillSourceDirectory(moduleUrl: string = import.meta.url): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), '..', 'skills', SKILL_NAME)
}

export function skillDestination(homeDirectory: string, agent: SkillAgent): string {
  return path.join(homeDirectory, AGENT_DIRECTORIES[agent], 'skills', SKILL_NAME)
}

export async function installSkill(options: {
  agent: SkillAgent
  homeDirectory: string
  target?: string
  sourceDirectory?: string
}): Promise<SkillInstallResult> {
  const source = options.sourceDirectory ?? skillSourceDirectory()
  const readable = await stat(source).catch(() => {
    // A missing directory and an unreadable one need the same repair, and the
    // message below reports the path either way.
    return null
  })
  if (!readable?.isDirectory())
    return { _tag: 'Err', reason: 'source_missing', message: `The packaged skill is missing at ${source}. Reinstall @gscdump/cli, then run the command again.` }

  const destination = options.target
    ? path.join(options.target, SKILL_NAME)
    : skillDestination(options.homeDirectory, options.agent)
  return mkdir(path.dirname(destination), { recursive: true })
    .then(() => cp(source, destination, { recursive: true, force: true }))
    .then((): SkillInstallResult => ({ _tag: 'Ok', installation: { agent: options.agent, source, destination } }))
    .catch((cause: unknown): SkillInstallResult => {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return { _tag: 'Err', reason: 'write_failed', message: `Could not write the skill to ${destination}: ${detail}` }
    })
}
