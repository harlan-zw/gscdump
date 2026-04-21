import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/analysis',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
