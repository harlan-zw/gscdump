import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api'
import type { DuckDBHandle } from '../duckdb'
import type { Row } from '../storage'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { blobValue, DuckDBInstance, timestampValue } from '@duckdb/node-api'

export interface NodeDuckDBOptions {
  verbose?: boolean
}

type ConnectionState
  = { _tag: 'Unopened' }
    | { _tag: 'Opened', instance: DuckDBInstance, connection: DuckDBConnection }

interface Runtime {
  directory: string
  onExit: () => void
  tail: Promise<void>
  state: ConnectionState
}

let singleton: Runtime | undefined

function getRuntime(): Runtime {
  if (singleton)
    return singleton
  const directory = mkdtempSync(join(tmpdir(), 'gscdump-duckdb-'))
  const onExit = (): void => rmSync(directory, { recursive: true, force: true })
  process.once('exit', onExit)
  singleton = {
    directory,
    onExit,
    tail: Promise.resolve(),
    state: { _tag: 'Unopened' },
  }
  return singleton
}

function enqueue<T>(runtime: Runtime, operation: () => Promise<T>): Promise<T> {
  const result = runtime.tail.then(operation)
  // The caller receives failures. Keep later operations usable after a rejected query.
  runtime.tail = result.then(() => undefined, () => undefined)
  return result
}

async function connect(runtime: Runtime, opts: NodeDuckDBOptions): Promise<DuckDBConnection> {
  if (runtime.state._tag === 'Opened')
    return runtime.state.connection
  const instance = await DuckDBInstance.create(':memory:', {
    temp_directory: join(runtime.directory, 'spill'),
  })
  try {
    const connection = await instance.connect()
    runtime.state = { _tag: 'Opened', instance, connection }
    await connection.run('SET file_search_path = $1', [runtime.directory])
    if (opts.verbose)
      console.warn('[gscdump] Native DuckDB initialized')
    return connection
  }
  catch (error) {
    if (runtime.state._tag === 'Opened')
      runtime.state.connection.closeSync()
    runtime.state = { _tag: 'Unopened' }
    instance.closeSync()
    throw error
  }
}

function temporaryPath(runtime: Runtime, name: string): string {
  const path = resolve(runtime.directory, name)
  const child = relative(runtime.directory, path)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new TypeError('DuckDB temporary files must stay inside the temporary directory.')
  return path
}

function parameter(value: unknown): DuckDBValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint')
    return value
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return timestampValue(BigInt(value.getTime()) * 1000n)
  if (value instanceof Uint8Array)
    return blobValue(value)
  throw new TypeError('DuckDB parameters must be finite scalars, dates, byte arrays, or null.')
}

function rowValue(value: JS): unknown {
  // Preserve the Engine's epoch-millisecond dates and exact BIGINT values.
  if (value instanceof Date)
    return value.getTime()
  if (Array.isArray(value))
    return value.map(rowValue)
  if (value instanceof Uint8Array)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rowValue(item)]))
  return value
}

/** Node uses one native connection. Browser and Worker adapters own their WASM runtimes. */
export function createNodeDuckDBHandle(opts: NodeDuckDBOptions = {}): DuckDBHandle {
  return {
    query(sql, params): Promise<Row[]> {
      const runtime = getRuntime()
      return enqueue(runtime, async () => {
        const connection = await connect(runtime, opts)
        const result = await connection.runAndReadAll(sql, params?.length ? params.map(parameter) : undefined)
        const names = result.columnNames()
        return result.getRowsJS().map(values => Object.fromEntries(
          names.map((name, index) => [name, rowValue(values[index]!)]),
        ))
      })
    },
    registerFileBuffer(name, bytes): Promise<void> {
      const runtime = getRuntime()
      return enqueue(runtime, async () => {
        const path = temporaryPath(runtime, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, bytes)
      })
    },
    copyFileToBuffer(name): Promise<Uint8Array> {
      const runtime = getRuntime()
      return enqueue(runtime, () => readFile(temporaryPath(runtime, name)))
    },
    dropFiles(names): Promise<void> {
      const runtime = getRuntime()
      return enqueue(runtime, async () => {
        for (const name of names) {
          // COPY can fail before creating its output. Missing files need no cleanup.
          await rm(temporaryPath(runtime, name), { force: true })
        }
      })
    },
    makeTempPath(ext): string {
      const runtime = getRuntime()
      return temporaryPath(runtime, `${randomUUID()}.${ext}`)
    },
  }
}

export function resetNodeDuckDB(): void {
  const runtime = singleton
  singleton = undefined
  if (!runtime)
    return
  // Drain accepted operations before releasing their connection and files.
  // Held handles resolve the new runtime on their next operation.
  void enqueue(runtime, async () => {
    try {
      if (runtime.state._tag === 'Opened') {
        runtime.state.connection.closeSync()
        runtime.state.instance.closeSync()
      }
    }
    finally {
      await rm(runtime.directory, { recursive: true, force: true })
      process.removeListener('exit', runtime.onExit)
    }
  }).catch((error) => {
    console.warn('[gscdump] Failed to release DuckDB resources', error)
  })
}
