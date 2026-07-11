/** @deprecated PyIceberg subprocess writing now lives in `@gscdump/engine`. */
export const PYICEBERG_PYTHON_ENV = 'GSCDUMP_ICEBERG_PYTHON'
/** @deprecated PyIceberg subprocess writing now lives in `@gscdump/engine`. */
export const DEFAULT_PYICEBERG_PYTHON = 'python3'

export interface PyIcebergWriterResult {
  rowCount?: number
  error?: string
}

export interface RunPyIcebergWriterOptions {
  python: string
  script: string
  job: unknown
  label: string
  processErrorAsParseFailure?: boolean
  rejectOnProcessError?: boolean
}

function importRuntimeModule(specifier: string): Promise<unknown> {
  return import(specifier)
}

/**
 * @deprecated Import the engine-owned PyIceberg runtime instead. Retained as a
 * compatibility shim for consumers of `@gscdump/lakehouse` 0.x.
 */
export function resolvePyIcebergPython(override?: string): string {
  const runtimeProcess = Reflect.get(globalThis, 'process') as { env?: Record<string, string | undefined> } | undefined
  const env = runtimeProcess?.env
  return override ?? env?.[PYICEBERG_PYTHON_ENV] ?? DEFAULT_PYICEBERG_PYTHON
}

/**
 * @deprecated Import the engine-owned PyIceberg runtime instead. Retained as a
 * compatibility shim for consumers of `@gscdump/lakehouse` 0.x.
 */
export async function runPyIcebergWriter<T extends PyIcebergWriterResult>(
  options: RunPyIcebergWriterOptions,
): Promise<T> {
  // Keep the Node-only module opaque to browser bundlers. This compatibility
  // path is loaded only when a consumer actually invokes the legacy helper.
  const childProcess = await importRuntimeModule('node:child_process') as typeof import('node:child_process')
  const { execFile } = childProcess
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.python,
      [options.script],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed: T | undefined
        if (stdout.trim()) {
          try {
            parsed = JSON.parse(stdout) as T
          }
          catch {
            // Fall through to the existing error handling below.
          }
        }
        if (parsed && !(err && options.rejectOnProcessError)) {
          resolve(parsed)
          return
        }
        if (err) {
          if (options.processErrorAsParseFailure) {
            reject(new Error(`${options.label} produced no parseable output (${err.message})${stderr ? `: ${stderr}` : ''}`))
            return
          }
          reject(new Error(`${options.label} process failed (${err.message})${stderr ? `: ${stderr}` : ''}`))
          return
        }
        reject(new Error(`${options.label} produced no parseable output: ${stdout || stderr}`))
      },
    )
    child.stdin?.end(JSON.stringify(options.job))
  })
}
