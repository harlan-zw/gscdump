import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gscdump } from '@gscdump/devframe/vite'
import { defineConfig } from 'vite'

// A small client-routed app with Vite DevTools. Build the package first
// (`pnpm build`), then run `pnpm dev`. Set `GSCDUMP_SITE` to pick a Site.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  devtools: {
    enabled: true,
    // Automated browser runs set `DEVTOOLS_NO_AUTH`; a manual run keeps the
    // terminal code prompt.
    clientAuth: !process.env.DEVTOOLS_NO_AUTH,
  },
  plugins: [gscdump({ site: process.env.GSCDUMP_SITE })],
})
