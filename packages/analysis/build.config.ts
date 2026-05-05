import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/analyzer/index.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/default-registry.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/query/index.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/source/index.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/semantic/index.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/routing/index.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/rollups.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/report/index.ts'],
      outDir: './dist',
    },
  ],
})
