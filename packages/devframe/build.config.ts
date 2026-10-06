import { defineBuildConfig } from '../../scripts/build-config'

// The node entries. The panel SPA (`app/`) and the page script
// (`src/client-script/`) are browser bundles that Vite builds into `dist/`.
export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/vite.ts',
      ],
    },
  ],
})
