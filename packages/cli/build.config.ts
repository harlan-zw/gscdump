import { defineBuildConfig } from '../../scripts/build-config'

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
