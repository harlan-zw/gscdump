import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// The panel SPA, served as the definition's `clientAssets`. `base: './'` keeps
// asset URLs relative, so one build works under any mount path.
export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
  },
})
