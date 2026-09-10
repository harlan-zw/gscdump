import type { CommandDef, CommandMeta, Resolvable, SubCommandsDef } from 'citty'
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

function shallowCommand(meta: CommandMeta, load: CommandLoader): CommandDef<any> {
  return {
    meta,
    args: async () => await resolveValue((await load()).args) ?? {},
    default: async () => await resolveValue((await load()).default) ?? '',
    subCommands: async () => await resolveValue<SubCommandsDef>((await load()).subCommands) ?? {},
    async setup(context) {
      const command = await load()
      await command.setup?.({ ...context, cmd: command })
    },
    async cleanup(context) {
      const command = await load()
      await command.cleanup?.({ ...context, cmd: command })
    },
    async run(context) {
      const command = await load()
      return command.run?.({ ...context, cmd: command })
    },
  }
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
