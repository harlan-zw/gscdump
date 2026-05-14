// Re-export of the stable query builder surface from `gscdump/query`, so
// consumers can `import { gsc, and, between, ... } from '@gscdump/sdk/query'`
// without taking a runtime dep on the engine package.

export * from 'gscdump/query'
