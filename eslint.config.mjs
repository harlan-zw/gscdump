import antfu from '@antfu/eslint-config'

// Layer lint — encodes the package DAG declared in ARCHITECTURE.md + NEXT_STEPS.md.
// Edges allowed between sibling packages:
//   gscdump    → (no @gscdump/* siblings; edge-compatible surface must stay node-free)
//   analysis   → gscdump
//   cloud      → gscdump
//   mcp        → gscdump
//   cli        → gscdump, analysis, mcp        (NOT cloud — cloud commands live in @gscdump/cloud bin)
function forbidSiblings(...siblings) {
  return {
    patterns: siblings.map(name => ({
      group: [`@gscdump/${name}`, `@gscdump/${name}/*`],
      message: `Layer violation: this package may not import from @gscdump/${name}. See ARCHITECTURE.md / NEXT_STEPS.md for the allowed DAG.`,
    })),
  }
}

const preferGranularCoreSubpaths = {
  paths: [
    {
      name: 'gscdump/shared',
      importNames: ['AnalysisParams', 'AnalysisResult', 'AnalysisTool'],
      message: 'Import analysis contracts from gscdump/shared/analysis.',
    },
    {
      name: 'gscdump/shared',
      importNames: ['DriverInspectResult', 'DriverQueryParams', 'DriverQueryResult', 'DriverQueryRow', 'DriverSite', 'DriverSitemap', 'DriverSiteWithSync'],
      message: 'Import driver contracts from gscdump/shared/driver.',
    },
    {
      name: 'gscdump/shared',
      importNames: ['SnapshotIndex'],
      message: 'Import snapshot contracts from gscdump/shared/snapshot.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['Row', 'StorageEngine', 'TableName', 'TenantCtx', 'WriteCtx', 'ManifestEntry', 'Watermark'],
      message: 'Import analytics contracts from gscdump/analytics/contracts.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['SCHEMAS', 'allTables', 'currentSchemaVersion', 'dimensionToColumn', 'inferTable'],
      message: 'Import analytics schema primitives from gscdump/analytics/schema.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['enumeratePartitions', 'FILES_PLACEHOLDER', 'resolveToSQL', 'substituteNamedFiles'],
      message: 'Import analytics query-planning primitives from gscdump/analytics/planner.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['encodeSiteId'],
      message: 'Import tenant helpers from gscdump/analytics/tenant.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['normalizeUrl'],
      message: 'Import URL normalization from gscdump/analytics/normalize.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['createRowAccumulator', 'toPath', 'toSumPosition', 'transformGscRow'],
      message: 'Import ingest helpers from gscdump/analytics/ingest.',
    },
    {
      name: 'gscdump/analytics',
      importNames: ['bindLiterals', 'formatLiteral'],
      message: 'Import SQL literal helpers from gscdump/analytics/sql.',
    },
  ],
  patterns: [
    {
      group: ['**/gscdump/src/**'],
      message: 'Import gscdump internals through its public subpath exports instead of reaching into packages/gscdump/src.',
    },
  ],
}

export default antfu({
  type: 'lib',
  ignores: [
    'CLAUDE.md',
    'examples/browser-attach/analyzers.mjs',
    'examples/browser-http/bundle.mjs',
    'examples/browser-http/browser-entry.mjs',
    'examples/browser-http/proxy.mjs',
    'examples/browser-http/snapshot.mjs',
    'examples/browser-http/_snapshots/**',
    'examples/browser-http/_served/**',
  ],
}, {
  files: [
    'packages/cloud/src/commands/**/*.ts',
    'packages/cloud/src/cli.ts',
  ],
  rules: {
    'no-console': 'off',
  },
}, {
  // Core overall — no reaching into sibling @gscdump/* packages (would create a cycle).
  files: ['packages/gscdump/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@gscdump/*'], message: 'Core (gscdump) must not depend on sibling @gscdump/* packages (would create a cycle).' },
      ],
    }],
  },
}, {
  // Core's edge-compatible surface (client + query builder + shared types + driver types + index).
  // Must never pull in node:* builtins on top of the sibling-package rule above.
  // This config appears AFTER the broader one so the tighter `no-restricted-imports` wins for these files.
  files: [
    'packages/gscdump/src/core/**/*.ts',
    'packages/gscdump/src/query/**/*.ts',
    'packages/gscdump/src/shared/**/*.ts',
    'packages/gscdump/src/driver/**/*.ts',
    'packages/gscdump/src/index.ts',
  ],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['node:*'], message: 'Core\'s edge-compatible surface must not import node:* builtins. Move Node-only code into packages/gscdump/src/analytics/adapters/.' },
        { group: ['@gscdump/*'], message: 'Core (gscdump) must not depend on sibling @gscdump/* packages (would create a cycle).' },
      ],
    }],
  },
}, {
  files: ['packages/analysis/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cli', 'mcp', 'cloud').patterns,
        ...preferGranularCoreSubpaths.patterns,
      ],
    }],
  },
}, {
  files: ['packages/cloud/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cli', 'mcp', 'analysis').patterns,
        ...preferGranularCoreSubpaths.patterns,
      ],
    }],
  },
}, {
  files: ['packages/mcp/src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: preferGranularCoreSubpaths.paths,
      patterns: [
        ...forbidSiblings('cli', 'cloud', 'analysis').patterns,
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
