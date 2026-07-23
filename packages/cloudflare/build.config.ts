import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts', './src/server-tail/index.ts'],
    },
  ],
})
