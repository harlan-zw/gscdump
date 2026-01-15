import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/cli',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
