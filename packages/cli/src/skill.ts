import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
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
  digest: string
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

async function skillDigest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function read(relative: string): Promise<void> {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.'))
        continue
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await read(name)
      }
      else if (entry.isFile()) {
        hash.update(name).update('\0').update(await readFile(path.join(directory, name))).update('\0')
      }
      else {
        throw new Error(`The skill contains an unsupported file at ${name}.`)
      }
    }
  }
  await read('')
  return hash.digest('hex')
}

export type SkillInstallationState
  = | { state: 'not-installed', agent: SkillAgent, destination: string }
    | { state: 'current' | 'stale', agent: SkillAgent, destination: string, installedDigest: string, packagedDigest: string }
    | { state: 'unavailable', agent: SkillAgent, destination: string, message: string }

export async function inspectSkillInstallation(options: { agent: SkillAgent, homeDirectory: string, sourceDirectory?: string, target?: string }): Promise<SkillInstallationState> {
  const destination = options.target ? path.join(options.target, SKILL_NAME) : skillDestination(options.homeDirectory, options.agent)
  const exists = await stat(destination).then(() => true).catch((cause: unknown) => {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')
      return false
    throw cause
  })
  if (!exists)
    return { state: 'not-installed', agent: options.agent, destination }
  return Promise.all([skillDigest(destination), skillDigest(options.sourceDirectory ?? skillSourceDirectory())])
    .then(([installedDigest, packagedDigest]): SkillInstallationState => ({ state: installedDigest === packagedDigest ? 'current' : 'stale', agent: options.agent, destination, installedDigest, packagedDigest }))
    .catch((cause: unknown): SkillInstallationState => ({ state: 'unavailable', agent: options.agent, destination, message: cause instanceof Error ? cause.message : String(cause) }))
}

async function replaceSkill(source: string, destination: string): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true })
  const staging = await mkdtemp(path.join(path.dirname(destination), '.gscdump-skill-'))
  const candidate = path.join(staging, 'candidate')
  const backup = path.join(staging, 'previous')
  const digest = await cp(source, candidate, { recursive: true, force: true })
    .then(() => skillDigest(candidate))
    .catch(async (cause: unknown) => {
      await rm(staging, { recursive: true, force: true })
      throw cause
    })
  const previous = await rename(destination, backup).then(() => 'moved' as const).catch((cause: unknown) => {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')
      return 'absent' as const
    throw cause
  })
  await rename(candidate, destination).catch(async (cause: unknown) => {
    // Keep the backup if restoration itself fails, so recovery remains possible.
    if (previous === 'moved')
      await rename(backup, destination)
    await rm(staging, { recursive: true, force: true })
    throw cause
  })
  await rm(staging, { recursive: true, force: true })
  return digest
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
  return replaceSkill(source, destination)
    .then((digest): SkillInstallResult => ({ _tag: 'Ok', installation: { agent: options.agent, source, destination, digest } }))
    .catch((cause: unknown): SkillInstallResult => {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return { _tag: 'Err', reason: 'write_failed', message: `Could not write the skill to ${destination}: ${detail}` }
    })
}
