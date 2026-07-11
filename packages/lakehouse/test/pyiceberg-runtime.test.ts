import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PYICEBERG_PYTHON,
  PYICEBERG_PYTHON_ENV,
  resolvePyIcebergPython,
  runPyIcebergWriter,
} from '../src/pyiceberg-runtime'

const originalPython = process.env[PYICEBERG_PYTHON_ENV]

afterEach(() => {
  if (originalPython === undefined)
    delete process.env[PYICEBERG_PYTHON_ENV]
  else
    process.env[PYICEBERG_PYTHON_ENV] = originalPython
})

describe('legacy PyIceberg runtime compatibility', () => {
  it('preserves override, environment, and default resolution precedence', () => {
    process.env[PYICEBERG_PYTHON_ENV] = 'environment-python'
    expect(resolvePyIcebergPython('override-python')).toBe('override-python')
    expect(resolvePyIcebergPython()).toBe('environment-python')

    delete process.env[PYICEBERG_PYTHON_ENV]
    expect(resolvePyIcebergPython()).toBe(DEFAULT_PYICEBERG_PYTHON)
  })

  it('loads the Node subprocess runtime lazily when invoked', async () => {
    const script = fileURLToPath(new URL('./fixtures/pyiceberg-writer.mjs', import.meta.url))
    await expect(runPyIcebergWriter({
      python: process.execPath,
      script,
      job: { rowCount: 7 },
      label: 'compatibility writer',
    })).resolves.toEqual({ rowCount: 7 })
  })
})
