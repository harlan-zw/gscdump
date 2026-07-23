import { fileURLToPath } from 'node:url'
import { defineBuildConfig } from '../../scripts/build-config'

// Pure-JS `hysnappy` shim — see `@gscdump/engine`'s build.config.ts for the
// full rationale (copied verbatim: `icebird`'s metadata path pulls in
// `hyparquet-compressors`, which instantiates a WASM snappy module at import
// time, which `workerd` forbids). `icebird` (and therefore the patched
// BigInt-safe commit path) is bundled into this package's dist — same as the
// engine currently does — so every consumer (nuxtseo, gscdump.com, and the
// engine's own thin re-exports) gets the patch without needing the pnpm
// `patchedDependencies` entry themselves.
const hysnappyShim = fileURLToPath(new URL('./src/vendor/hysnappy-purejs.ts', import.meta.url))

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/bigint.ts',
        './src/schema.ts',
        './src/maintenance.ts',
        './src/unsafe-raw.ts',
        './src/provisioning/index.ts',
      ],
      rolldown: {
        resolve: {
          alias: { hysnappy: hysnappyShim },
        },
      },
    },
  ],
})
