import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/db',
    globals: true,
    reporters: 'dot',
    setupFiles: ['../../vitest.setup.ts'],
  },
})
