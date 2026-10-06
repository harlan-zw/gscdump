import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The page script loads into the user's app page as one ES module, so it
// bundles `devframe/in-page-channel` instead of importing it.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../../dist/client-script', import.meta.url)),
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
  },
})
