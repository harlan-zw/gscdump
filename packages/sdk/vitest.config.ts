import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/sdk',
    globals: true,
    setupFiles: ['../../vitest.setup.ts'],
    typecheck: {
      enabled: true,
      include: ['**/*.test-d.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
})
