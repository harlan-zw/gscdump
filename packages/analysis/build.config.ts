import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/duckdb/index.ts'],
      outDir: './dist',
      name: 'duckdb',
    },
    {
      type: 'bundle',
      input: ['./src/browser/index.ts'],
      outDir: './dist',
      name: 'browser',
    },
    {
      type: 'bundle',
      input: ['./src/sqlite/index.ts'],
      outDir: './dist',
      name: 'sqlite',
    },
    {
      type: 'bundle',
      input: ['./src/query/index.ts'],
      outDir: './dist',
      name: 'query',
    },
    {
      type: 'bundle',
      input: ['./src/window/index.ts'],
      outDir: './dist',
      name: 'window',
    },
  ],
})
