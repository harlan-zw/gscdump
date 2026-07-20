import antfu from '@antfu/eslint-config'

// Layer lint — encodes the package DAG declared in ARCHITECTURE.md.
// Edges allowed between sibling packages:
//   gscdump             → contracts (edge-compatible surface must stay node-free)
//   lakehouse           → no runtime siblings
//   engine              → gscdump, contracts, lakehouse
//   analysis            → gscdump, engine, engine-gsc-api
//   cloudflare          → gscdump, contracts, engine, engine-sqlite
//   cli                 → gscdump, engine, engine-gsc-api, analysis
function forbidSiblings(...siblings) {
  return {
    patterns: siblings.map(name => ({
      group: [`@gscdump/${name}`, `@gscdump/${name}/*`],
      message: `Layer violation: this package may not import from @gscdump/${name}. See ARCHITECTURE.md for the allowed DAG.`,
    })),
  }
}

// Every @gscdump/* sibling except the dependency-free `contracts` leaf, which
// core (gscdump) is allowed to depend on (it sits below core in the DAG).
const coreForbiddenSiblings = [
  'analysis',
  'cli',
  'cloudflare',
  'engine',
  'engine-duckdb-wasm',
  'engine-gsc-api',
  'engine-sqlite',
  'lakehouse',
  'sdk',
]

const preferGranularCoreSubpaths = {
  paths: [
    {
      name: '@gscdump/engine',
      importNames: ['Row', 'StorageEngine', 'TableName', 'TenantCtx', 'WriteCtx', 'ManifestEntry', 'Watermark'],
      message: 'Import storage contracts from @gscdump/engine/contracts.',
    },
    {
      name: '@gscdump/engine',
      importNames: ['SCHEMAS', 'allTables', 'currentSchemaVersion', 'dimensionToColumn', 'inferTable'],
      message: 'Import schema primitives from @gscdump/engine/schema.',
    },
    {
      name: '@gscdump/engine',
      importNames: ['enumeratePartitions', 'FILES_PLACEHOLDER', 'resolveToSQL', 'substituteNamedFiles'],
      message: 'Import query-planning primitives from @gscdump/engine/planner.',
    },
    {
      name: '@gscdump/engine',
      importNames: ['createRowAccumulator', 'toPath', 'toSumPosition', 'transformGscRow'],
      message: 'Import ingest helpers from @gscdump/engine/ingest.',
    },
    {
      name: '@gscdump/engine',
      importNames: ['bindLiterals', 'formatLiteral'],
      message: 'Import SQL literal helpers from @gscdump/engine/sql.',
    },
    {
      name: 'gscdump',
      importNames: ['DriverInspectResult', 'DriverQueryParams', 'DriverQueryResult', 'DriverQueryRow', 'DriverSite', 'DriverSitemap', 'DriverSiteWithSync'],
      message: 'Import driver contracts from gscdump/driver.',
    },
    {
      name: 'gscdump',
      importNames: ['encodeSiteId'],
      message: 'Import tenant helpers from gscdump/tenant.',
    },
    {
      name: 'gscdump',
      importNames: ['normalizeUrl'],
      message: 'Import URL normalization from gscdump/normalize.',
    },
  ],
  patterns: [
    {
      group: ['**/gscdump/src/**', '**/engine/src/**'],
      message: 'Import gscdump/engine internals through public subpath exports instead of reaching into packages/*/src.',
    },
  ],
}

export default antfu({
  type: 'lib',
  ignores: [
    'CLAUDE.md',
    'docs/gsc-api-reference/**',
    'examples/browser-attach/analyzers.mjs',
    'examples/browser-http/bundle.mjs',
    'examples/browser-http/browser-entry.mjs',
    'examples/browser-http/proxy.mjs',
    'examples/browser-http/snapshot.mjs',
    'examples/browser-http/_snapshots/**',
    'examples/browser-http/_served/**',
  ],
}, {
  // Core overall — no reaching into sibling @gscdump/* packages (would create a
  // cycle); only the @gscdump/contracts leaf is an allowed edge.
  files: ['packages/gscdump/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        ...forbidSiblings(...coreForbiddenSiblings).patterns,
      ],
    }],
  },
}, {
  // Core's edge-compatible surface (client + query builder + driver types + index).
  // Must never pull in node:* builtins on top of the sibling-package rule above.
  files: [
    'packages/gscdump/src/core/**/*.ts',
    'packages/gscdump/src/query/**/*.ts',
    'packages/gscdump/src/driver.ts',
    'packages/gscdump/src/tenant.ts',
    'packages/gscdump/src/normalize.ts',
    'packages/gscdump/src/index.ts',
  ],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['node:*'], message: 'Core\'s edge-compatible surface must not import node:* builtins. Move Node-only code into @gscdump/engine adapters.' },
        ...forbidSiblings(...coreForbiddenSiblings).patterns,
      ],
    }],
  },
}, {
  files: ['packages/engine/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cli', 'cloudflare', 'analysis', 'engine-duckdb-wasm', 'engine-gsc-api', 'engine-sqlite', 'sdk').patterns,
        ...preferGranularCoreSubpaths.patterns,
      ],
    }],
  },
}, {
  files: ['packages/analysis/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cli', 'cloudflare', 'sdk').patterns,
        ...preferGranularCoreSubpaths.patterns,
      ],
    }],
  },
}, {
  files: ['packages/cli/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cloud').patterns,
        ...preferGranularCoreSubpaths.patterns,
      ],
    }],
  },
}, {
  files: ['packages/*/test/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', preferGranularCoreSubpaths],
  },
})
