import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/mcp',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
    passWithNoTests: true,
  },
})
