import process from 'node:process'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import pkg from '../package.json' with { type: 'json' }

// The Chrome extension build. `GSCDUMP_ORIGIN` points a test build at a local
// server; the default reads gscdump.com.
const origin = (process.env.GSCDUMP_ORIGIN ?? 'https://gscdump.com').replace(/\/+$/, '')

function manifest(): string {
  return JSON.stringify({
    manifest_version: 3,
    name: 'gscdump: Search Console',
    description: 'Search Console clicks, impressions, and queries for the page in the current tab, from your gscdump Sites.',
    version: pkg.version,
    permissions: ['sidePanel', 'tabs'],
    host_permissions: [`${origin}/*`],
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'panel.html' },
    action: { default_title: 'Open gscdump Search Console' },
  }, null, 2)
}

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: { 'import.meta.env.GSCDUMP_ORIGIN': JSON.stringify(origin) },
  plugins: [
    vue(),
    {
      name: 'gscdump-extension-manifest',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'manifest.json', source: manifest() })
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL('../dist-extension', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
        background: fileURLToPath(new URL('./background.ts', import.meta.url)),
      },
      output: {
        entryFileNames: chunk => chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
      },
    },
  },
})
