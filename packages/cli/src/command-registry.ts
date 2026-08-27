import type { CommandDef, CommandMeta, Resolvable, SubCommandsDef } from 'citty'

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
  init: shallowCommand(
    { name: 'init', description: 'Set up GSCDump authentication' },
    () => import('./commands/init').then(module => module.initCommand),
  ),
  dump: shallowCommand(
    { name: 'dump', description: 'Export live Parquet files from the local store to a directory' },
    () => import('./commands/dump').then(module => module.dumpCommand),
  ),
  query: shallowCommand(
    { name: 'query', description: 'Run a search analytics query (local Parquet by default, --live hits GSC API)' },
    () => import('./commands/query').then(module => module.queryCommand),
  ),
  sites: shallowCommand(
    { name: 'sites', description: 'List GSC sites; manage properties (add/delete) and verify ownership' },
    () => import('./commands/sites').then(module => module.sitesCommand),
  ),
  sitemaps: shallowCommand(
    { name: 'sitemaps', description: 'Manage sitemaps' },
    () => import('./commands/sitemaps').then(module => module.sitemapsCommand),
  ),
  sync: shallowCommand(
    { name: 'sync', description: 'Sync GSC data to local Parquet store' },
    () => import('./commands/sync').then(module => module.syncCommand),
  ),
  store: shallowCommand(
    { name: 'store', description: 'Manage the local DuckDB/Parquet store' },
    () => import('./commands/store').then(module => module.storeCommand),
  ),
  inspect: shallowCommand(
    { name: 'inspect', description: 'Inspect URL indexing status (single URL; use `inspect batch` for many)' },
    () => import('./commands/inspect').then(module => module.inspectCommand),
  ),
  indexing: shallowCommand(
    { name: 'indexing', description: 'Notify Google about URL updates/removals (Indexing API)' },
    () => import('./commands/indexing').then(module => module.indexingCommand),
  ),
  entities: shallowCommand(
    { name: 'entities', description: 'Manage local entity snapshots (URL inspections and indexing metadata)' },
    () => import('./commands/entities').then(module => module.entitiesCommand),
  ),
  analyze: shallowCommand(
    { name: 'analyze', description: 'SEO analysis tools' },
    () => import('./commands/analyze').then(module => module.analyzeCommand),
  ),
  report: shallowCommand(
    { name: 'report', description: 'Run an intent-keyed report (composes analyzers into bounded sections)' },
    () => import('./commands/report').then(module => module.reportCommand),
  ),
  auth: shallowCommand(
    { name: 'auth', description: 'Manage authentication' },
    () => import('./commands/auth').then(module => module.authCommand),
  ),
  login: shallowCommand(
    { name: 'login', description: 'Run OAuth flow and persist tokens (skip if BYOK env vars set)' },
    () => import('./commands/auth').then(module => module.loginCommand),
  ),
  logout: shallowCommand(
    { name: 'logout', description: 'Clear stored OAuth tokens' },
    () => import('./commands/auth').then(module => module.logoutCommand),
  ),
  status: shallowCommand(
    { name: 'status', description: 'Show current authentication status' },
    () => import('./commands/auth').then(module => module.statusCommand),
  ),
  config: shallowCommand(
    { name: 'config', description: 'Manage configuration' },
    () => import('./commands/config').then(module => module.configCommand),
  ),
  profile: shallowCommand(
    { name: 'profile', description: 'Manage gscdump profiles (per-account token + config dirs)' },
    () => import('./commands/profile').then(module => module.profileCommand),
  ),
  doctor: shallowCommand(
    { name: 'doctor', description: 'Run health checks (env, auth, scopes, time, dataDir, store, GSC reachability + ping, defaultSite)' },
    () => import('./commands/doctor').then(module => module.doctorCommand),
  ),
  mcp: shallowCommand(
    { name: 'mcp', description: 'Start MCP server for AI assistants' },
    () => import('./commands/mcp').then(module => module.mcpCommand),
  ),
} satisfies SubCommandsDef
