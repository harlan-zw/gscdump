import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'lakehouse',
    globals: true,
    reporters: 'dot',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
})
