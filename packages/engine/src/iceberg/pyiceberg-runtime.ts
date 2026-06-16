import process from 'node:process'

export const PYICEBERG_PYTHON_ENV = 'GSCDUMP_ICEBERG_PYTHON'
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

export function resolvePyIcebergPython(override?: string): string {
  return override ?? process.env[PYICEBERG_PYTHON_ENV] ?? DEFAULT_PYICEBERG_PYTHON
}

export async function runPyIcebergWriter<T extends PyIcebergWriterResult>(
  options: RunPyIcebergWriterOptions,
): Promise<T> {
  const { execFile } = await import('node:child_process')
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
            // fall through to the error path below
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
