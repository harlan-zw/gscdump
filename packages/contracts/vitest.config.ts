import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/contracts',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
  },
})
