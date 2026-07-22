import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/default-registry.ts',
        './src/errors.ts',
        './src/report/index.ts',
        './src/source/index.ts',
      ],
    },
  ],
})
