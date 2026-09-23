import type { ArgsDef, CommandDef, CommandMeta, Resolvable, SubCommandsDef } from 'citty'
import {
  analyzeCommandMeta,
  authCommandMeta,
  bingCommandMeta,
  configCommandMeta,
  doctorCommandMeta,
  dumpCommandMeta,
  entitiesCommandMeta,
  indexingCommandMeta,
  initCommandMeta,
  inspectCommandMeta,
  mcpCommandMeta,
  papercutCommandMeta,
  profileCommandMeta,
  queryCommandMeta,
  reportCommandMeta,
  sitemapsCommandMeta,
  sitesCommandMeta,
  skillCommandMeta,
  storeCommandMeta,
  syncCommandMeta,
} from './command-meta'

type CommandLoader = () => Promise<CommandDef<any>>

function resolveValue<T>(value: Resolvable<T> | undefined): T | Promise<T> | undefined {
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value
}

const KEBAB_RE = /-([a-z])/g

function camelCase(name: string): string {
  return name.replace(KEBAB_RE, (_, letter: string) => letter.toUpperCase())
}

/** True when `flag` takes the next argv item as its value. Mirrors citty's parser. */
function isValueFlag(flag: string, argsDef: ArgsDef): boolean {
  const name = flag.replace(/^-{1,2}/, '')
  for (const [key, def] of Object.entries(argsDef)) {
    if (def.type !== 'string' && def.type !== 'enum')
      continue
    const aliases = 'alias' in def && def.alias ? [def.alias].flat() : []
    if (camelCase(name) === camelCase(key) || aliases.includes(name))
      return true
  }
  return false
}

/**
 * Index of the subcommand name in `rawArgs`, or -1. This is the same rule
 * citty uses to dispatch, so a parent sees exactly what citty selected, even
 * when flags come before the subcommand name.
 */
export function findSubCommandIndex(rawArgs: readonly string[], argsDef: ArgsDef): number {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!
    if (arg === '--')
      return -1
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && isValueFlag(arg, argsDef))
        i++
      continue
    }
    return i
  }
  return -1
}

/** A citty usage error: the shell prints the command usage above it. */
export function usageError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: 'CLIError', code })
}

export function isUsageError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'CLIError'
}

/**
 * citty calls a parent `run` after its subcommand finished, and never reports
 * a bare parent that has no `run`. The guard gives every command in the tree
 * one rule: a parent `run` fires only when no subcommand was selected, and a
 * bare parent without `run` is a usage error.
 */
function guardedRun(load: CommandLoader): CommandDef<any>['run'] {
  return async (context) => {
    const command = await load()
    const subCommands = await resolveValue<SubCommandsDef>(command.subCommands) ?? {}
    if (Object.keys(subCommands).length > 0) {
      const argsDef = await resolveValue<ArgsDef>(command.args) ?? {}
      if (findSubCommandIndex(context.rawArgs, argsDef) >= 0)
        return
      if (!command.run)
        throw usageError('No command specified.', 'E_NO_COMMAND')
    }
    return command.run?.({ ...context, cmd: command })
  }
}

function guardedSubCommands(load: CommandLoader): () => Promise<SubCommandsDef> {
  return async () => {
    const subCommands = await resolveValue<SubCommandsDef>((await load()).subCommands) ?? {}
    return Object.fromEntries(Object.entries(subCommands).map(([name, sub]) => [
      name,
      async () => guardCommand(await resolveValue(sub) as CommandDef<any>),
    ]))
  }
}

function guardCommand(command: CommandDef<any>): CommandDef<any> {
  const load = async (): Promise<CommandDef<any>> => command
  return {
    ...command,
    subCommands: guardedSubCommands(load),
    run: guardedRun(load),
  }
}

function shallowCommand(meta: CommandMeta, load: CommandLoader): CommandDef<any> {
  return {
    meta,
    args: async () => await resolveValue((await load()).args) ?? {},
    subCommands: guardedSubCommands(load),
    async setup(context) {
      const command = await load()
      await command.setup?.({ ...context, cmd: command })
    },
    async cleanup(context) {
      const command = await load()
      await command.cleanup?.({ ...context, cmd: command })
    },
    run: guardedRun(load),
  }
}

/** The command whose usage `rawArgs` selects, plus its parent. Mirrors citty. */
export async function resolveUsageTarget(
  command: CommandDef<any>,
  rawArgs: readonly string[],
  parent?: CommandDef<any>,
): Promise<[CommandDef<any>, CommandDef<any> | undefined]> {
  const subCommands = await resolveValue<SubCommandsDef>(command.subCommands) ?? {}
  if (Object.keys(subCommands).length > 0) {
    const index = findSubCommandIndex(rawArgs, await resolveValue<ArgsDef>(command.args) ?? {})
    const name = rawArgs[index]
    if (name !== undefined) {
      const selected = await findSubCommand(subCommands, name)
      if (selected)
        return resolveUsageTarget(selected, rawArgs.slice(index + 1), command)
    }
  }
  return [command, parent]
}

async function findSubCommand(subCommands: SubCommandsDef, name: string): Promise<CommandDef<any> | undefined> {
  if (name in subCommands)
    return await resolveValue(subCommands[name]) as CommandDef<any>
  for (const candidate of Object.values(subCommands)) {
    const resolved = await resolveValue(candidate) as CommandDef<any>
    const meta = await resolveValue(resolved?.meta)
    if (meta?.alias && [meta.alias].flat().includes(name))
      return resolved
  }
  return undefined
}

export const CLI_SUBCOMMANDS = {
  bing: shallowCommand(
    bingCommandMeta,
    () => import('./commands/bing').then(module => module.bingCommand),
  ),
  init: shallowCommand(
    initCommandMeta,
    () => import('./commands/init').then(module => module.initCommand),
  ),
  dump: shallowCommand(
    dumpCommandMeta,
    () => import('./commands/dump').then(module => module.dumpCommand),
  ),
  query: shallowCommand(
    queryCommandMeta,
    () => import('./commands/query').then(module => module.queryCommand),
  ),
  sites: shallowCommand(
    sitesCommandMeta,
    () => import('./commands/sites').then(module => module.sitesCommand),
  ),
  sitemaps: shallowCommand(
    sitemapsCommandMeta,
    () => import('./commands/sitemaps').then(module => module.sitemapsCommand),
  ),
  sync: shallowCommand(
    syncCommandMeta,
    () => import('./commands/sync').then(module => module.syncCommand),
  ),
  store: shallowCommand(
    storeCommandMeta,
    () => import('./commands/store').then(module => module.storeCommand),
  ),
  inspect: shallowCommand(
    inspectCommandMeta,
    () => import('./commands/inspect').then(module => module.inspectCommand),
  ),
  indexing: shallowCommand(
    indexingCommandMeta,
    () => import('./commands/indexing').then(module => module.indexingCommand),
  ),
  entities: shallowCommand(
    entitiesCommandMeta,
    () => import('./commands/entities').then(module => module.entitiesCommand),
  ),
  analyze: shallowCommand(
    analyzeCommandMeta,
    () => import('./commands/analyze').then(module => module.analyzeCommand),
  ),
  report: shallowCommand(
    reportCommandMeta,
    () => import('./commands/report').then(module => module.reportCommand),
  ),
  auth: shallowCommand(
    authCommandMeta.auth,
    () => import('./commands/auth').then(module => module.authCommand),
  ),
  login: shallowCommand(
    authCommandMeta.login,
    () => import('./commands/auth').then(module => module.loginCommand),
  ),
  logout: shallowCommand(
    authCommandMeta.logout,
    () => import('./commands/auth').then(module => module.logoutCommand),
  ),
  status: shallowCommand(
    authCommandMeta.status,
    () => import('./commands/auth').then(module => module.statusCommand),
  ),
  config: shallowCommand(
    configCommandMeta,
    () => import('./commands/config').then(module => module.configCommand),
  ),
  profile: shallowCommand(
    profileCommandMeta,
    () => import('./commands/profile').then(module => module.profileCommand),
  ),
  doctor: shallowCommand(
    doctorCommandMeta,
    () => import('./commands/doctor').then(module => module.doctorCommand),
  ),
  mcp: shallowCommand(
    mcpCommandMeta,
    () => import('./commands/mcp').then(module => module.mcpCommand),
  ),
  skill: shallowCommand(
    skillCommandMeta,
    () => import('./commands/skill').then(module => module.skillCommand),
  ),
  papercut: shallowCommand(
    papercutCommandMeta,
    () => import('./commands/papercut').then(module => module.papercutCommand),
  ),
} satisfies SubCommandsDef
