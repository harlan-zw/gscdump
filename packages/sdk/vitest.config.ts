import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/sdk',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
