import { randomBytes } from 'node:crypto'
import { rename as fsRename, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const TRANSIENT_RENAME_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_BASE_DELAY_MS = 20
const DEFAULT_MAX_DELAY_MS = 400

export interface RenameRetryOptions {
  /** Total attempts including the initial try. Defaults to 10. */
  maxAttempts?: number
  /** Initial exponential backoff ceiling in milliseconds. Defaults to 20. */
  baseDelayMs?: number
  /** Maximum backoff ceiling in milliseconds. Defaults to 400. */
  maxDelayMs?: number
  /** Injectable rename operation (defaults to `node:fs/promises` `rename`). */
  rename?: (source: string, destination: string) => Promise<void>
  /** Injectable sleep function (defaults to `setTimeout`). */
  sleep?: (ms: number) => Promise<void>
  /** Injectable RNG in `[0, 1)` for equal-jitter backoff (defaults to `Math.random`). */
  random?: () => number
}

export interface WriteFileAtomicOptions {
  encoding?: BufferEncoding
  mode?: number
  flag?: string
  dirMode?: number
  retry?: RenameRetryOptions
}

/**
 * True for transient filesystem lock errors returned on Windows (`MoveFileExW`)
 * and network/FUSE mounts when another handle or OS minifilter briefly holds the
 * target or temporary file open during an atomic replace.
 */
export function isTransientRenameError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && TRANSIENT_RENAME_ERROR_CODES.has(error.code)
}

function computeRetryDelayMs(
  failedAttempt: number,
  opts: { baseDelayMs: number, maxDelayMs: number, random: number },
): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (failedAttempt - 1))
  const half = ceiling / 2
  const jitter = Math.min(1, Math.max(0, opts.random))
  return Math.round(half + jitter * half)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Rename `source` to `destination`, retrying transient lock errors (`EPERM`,
 * `EBUSY`, `EACCES`) with bounded exponential backoff and equal jitter.
 */
export async function renameWithRetry(
  source: string,
  destination: string,
  opts: RenameRetryOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
  const renameFn = opts.rename ?? fsRename
  const sleepFn = opts.sleep ?? defaultSleep
  const randomFn = opts.random ?? Math.random

  for (let attempt = 1; ; attempt++) {
    try {
      await renameFn(source, destination)
      return
    }
    catch (error) {
      if (attempt >= maxAttempts || !isTransientRenameError(error))
        throw error
      const delayMs = computeRetryDelayMs(attempt, {
        baseDelayMs,
        maxDelayMs,
        random: randomFn(),
      })
      await sleepFn(delayMs)
    }
  }
}

/**
 * Write `content` to a unique sibling `.tmp` file, then atomically replace
 * `target` via {@link renameWithRetry}. Creates missing parent directories on
 * demand and removes the temporary file if either step fails.
 */
export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = dirname(target)
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  const writeOptions = typeof content === 'string'
    ? {
        encoding: opts.encoding ?? 'utf8',
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.flag !== undefined ? { flag: opts.flag } : {}),
      }
    : {
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.flag !== undefined ? { flag: opts.flag } : {}),
      }

  const writeTemp = async (): Promise<void> => {
    await writeFile(tmp, content, writeOptions).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      await mkdir(dir, { recursive: true, ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {}) })
      await writeFile(tmp, content, writeOptions)
    })
  }

  await writeTemp()
    .then(() => renameWithRetry(tmp, target, opts.retry))
    .catch(async (err: unknown) => {
      await unlink(tmp).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code === 'ENOENT')
          return
        throw new AggregateError([err, cleanupError], `failed to replace ${target} and remove temporary file ${tmp}`)
      })
      throw err
    })
}
