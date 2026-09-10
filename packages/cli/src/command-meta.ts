export const initCommandMeta = {
  name: 'init',
  description: 'Set up GSCDump authentication',
}

export const dumpCommandMeta = {
  name: 'dump',
  description: 'Export live Parquet files from the local store to a directory',
}

export const queryCommandMeta = {
  name: 'query',
  description: 'Run a search analytics query (local Parquet by default, --live hits GSC API)',
}

export const sitesCommandMeta = {
  name: 'sites',
  description: 'List GSC sites; manage properties (add/delete) and verify ownership',
}

export const sitemapsCommandMeta = {
  name: 'sitemaps',
  description: 'Manage sitemaps',
}

export const syncCommandMeta = {
  name: 'sync',
  description: 'Sync GSC data to local Parquet store',
}

export const storeCommandMeta = {
  name: 'store',
  description: 'Manage the local DuckDB/Parquet store',
}

export const inspectCommandMeta = {
  name: 'inspect',
  description: 'Inspect URL indexing status (single URL; use `inspect batch` for many)',
}

export const indexingCommandMeta = {
  name: 'indexing',
  description: 'Notify Google about URL updates/removals (Indexing API)',
}

export const entitiesCommandMeta = {
  name: 'entities',
  description: 'Manage local entity snapshots (URL inspections and indexing metadata)',
}

export const analyzeCommandMeta = {
  name: 'analyze',
  description: 'SEO analysis tools',
}

export const reportCommandMeta = {
  name: 'report',
  description: 'Run an intent-keyed report (composes analyzers into bounded sections)',
}

export const authCommandMeta = {
  status: {
    name: 'status',
    description: 'Show current authentication status',
  },
  login: {
    name: 'login',
    description: 'Run OAuth flow and persist tokens (skip if BYOK env vars set)',
  },
  logout: {
    name: 'logout',
    description: 'Clear stored OAuth tokens',
  },
  auth: {
    name: 'auth',
    description: 'Manage authentication',
  },
}

export const configCommandMeta = {
  name: 'config',
  description: 'Manage configuration',
}

export const profileCommandMeta = {
  name: 'profile',
  description: 'Manage gscdump profiles (per-account token + config dirs)',
}

export const doctorCommandMeta = {
  name: 'doctor',
  description: 'Run health checks (env, auth, scopes, time, dataDir, store, GSC reachability + ping, defaultSite)',
}

export const mcpCommandMeta = {
  name: 'mcp',
  description: 'Start MCP server for AI assistants',
}

export const skillCommandMeta = {
  name: 'skill',
  description: 'Install the packaged coding agent skill',
}

export const papercutCommandMeta = {
  name: 'papercut',
  description: 'Report a CLI problem to gscdump.com (anonymous, sanitized)',
}
export const bingCommandMeta = { name: 'bing', description: 'Authenticate Bing, list sites, dump data, and read Indexing Evidence' }
