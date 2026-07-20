import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts'],
    },
    {
      type: 'bundle',
      input: ['./src/default-registry.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/errors.ts'],
      outDir: './dist',
    },
    {
      type: 'bundle',
      input: ['./src/report/index.ts'],
      outDir: './dist',
    },
  ],
})
