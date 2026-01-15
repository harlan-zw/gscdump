import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'e2e',
    include: ['**/*.test.ts'],
    environment: 'node',
  },
})
