import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: '@gscdump/query',
    globals: true,
    reporters: 'dot',
  },
})
