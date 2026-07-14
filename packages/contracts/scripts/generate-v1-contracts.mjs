import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createGscdumpV1Documents,
  serializeContractDocument,
} from '@gscdump/contracts/v1'

const generatedDirectory = fileURLToPath(new URL('../generated/', import.meta.url))
await mkdir(generatedDirectory, { recursive: true })

for (const [filename, document] of Object.entries(createGscdumpV1Documents())) {
  await writeFile(
    join(generatedDirectory, filename),
    serializeContractDocument(document),
    'utf8',
  )
}
