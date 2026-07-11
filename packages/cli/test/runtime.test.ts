import { describe, expect, it } from 'vitest'
import { getConfigDir, setConfigDir } from '../src/config'
import { resolveCliEnvironment } from '../src/environment'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'
import { isColorEnabled, noSubcommandSelected, setNoColor, setQuiet } from '../src/utils'

describe('cli runtime', () => {
  it('isolates config, environment, output, and argv state per invocation', () => {
    const first = createCliRuntime({
      configDir: '/tmp/gscdump-first',
      environment: { GSCDUMP_PROFILE: 'first' },
      rawArgs: ['profile', 'list'],
    })
    const second = createCliRuntime({
      configDir: '/tmp/gscdump-second',
      environment: { GSCDUMP_PROFILE: 'second' },
      rawArgs: ['profile'],
    })

    runWithCliRuntime(first, () => {
      expect(getConfigDir()).toBe('/tmp/gscdump-first')
      expect(resolveCliEnvironment().profile).toBe('first')
      expect(noSubcommandSelected('profile', ['list'])).toBe(false)
      setConfigDir('/tmp/gscdump-first-updated')
      setQuiet(true)
      setNoColor(true)
    })

    runWithCliRuntime(second, () => {
      expect(getConfigDir()).toBe('/tmp/gscdump-second')
      expect(resolveCliEnvironment().profile).toBe('second')
      expect(noSubcommandSelected('profile', ['list'])).toBe(true)
      expect(second.logger).not.toBe(first.logger)
      expect(second.quiet).toBe(false)
      expect(isColorEnabled()).toBe(true)
    })

    expect(first.configDir).toBe('/tmp/gscdump-first-updated')
    expect(first.quiet).toBe(true)
    expect(second.configDir).toBe('/tmp/gscdump-second')
  })
})
