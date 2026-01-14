import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts', './src/handlers/index.ts', './src/server/index.ts'],
    },
  ],
})
