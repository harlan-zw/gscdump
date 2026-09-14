import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function evaluatorIdentity() {
  const digest = async file => createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex')
  return { grader: await digest('./core.mjs'), cases: await digest('./cases.mjs'), runner: await digest('./run.mjs'), summarizer: await digest('./summarize.mjs'), proxy: await digest('./cli-proxy.mjs'), policy: await digest('./policy.mjs'), reservation: await digest('./reservation.mjs'), runtime: await digest('./runtime.mjs') }
}

export async function fileState(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT')
      return [] // A nonexistent Store has an explicit empty file state.
    throw error
  })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const file of await fileState(path))
        files.push({ ...file, path: join(entry.name, file.path) })
    }
    else {
      files.push({ path: entry.name, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
