import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/module.ts',
        './src/runtime-config.ts',
      ],
    },
  ],
})
