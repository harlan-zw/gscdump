import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/cli.ts'],
      rolldown: {
        external: [
          /@duckdb\/node-api/,
          /@duckdb\/node-bindings/,
        ],
      },
    },
  ],
})
