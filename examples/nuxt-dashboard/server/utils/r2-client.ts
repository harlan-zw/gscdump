// Shared R2 S3 client for server routes. Signs presigned GET URLs and runs
// LIST requests. Reused by /api/manifest, /api/sign-url, and the server
// analysis fallback route.
//
// Same shape as examples/browser-http/proxy.mjs, but as a reusable server
// helper so every Nitro route hits the same aws4fetch signer.

import { AwsClient } from 'aws4fetch'

const CONTENTS_RE = /<Contents>[\s\S]*?<\/Contents>/g
const KEY_RE = /<Key>([^<]+)<\/Key>/
const SIZE_RE = /<Size>([^<]+)<\/Size>/
const LAST_MODIFIED_RE = /<LastModified>([^<]+)<\/LastModified>/
const NEXT_TOKEN_RE = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/
const IS_TRUNCATED_RE = /<IsTruncated>true<\/IsTruncated>/

interface R2ListedObject {
  key: string
  size: number
  lastModified: string
}

export interface R2ClientOptions {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export interface R2Client {
  presignGet: (key: string, expiresIn?: number) => Promise<string>
  listObjects: (prefix: string) => AsyncIterable<R2ListedObject>
}

const DEFAULT_EXPIRES_S = 3600

export function createR2Client(opts: R2ClientOptions): R2Client {
  const endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com`
  const aws = new AwsClient({
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: 's3',
    region: 'auto',
  })

  async function presignGet(key: string, expiresIn = DEFAULT_EXPIRES_S): Promise<string> {
    const url = new URL(`${endpoint}/${opts.bucket}/${encodeKey(key)}`)
    url.searchParams.set('X-Amz-Expires', String(expiresIn))
    const signed = await aws.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }

  async function* listObjects(prefix: string): AsyncIterable<R2ListedObject> {
    let continuationToken: string | undefined
    while (true) {
      const u = new URL(`${endpoint}/${opts.bucket}`)
      u.searchParams.set('list-type', '2')
      u.searchParams.set('prefix', prefix)
      if (continuationToken)
        u.searchParams.set('continuation-token', continuationToken)

      const signed = await aws.sign(new Request(u, { method: 'GET' }))
      const res = await fetch(signed)
      if (!res.ok)
        throw new Error(`r2 list failed ${res.status}: ${await res.text()}`)

      const xml = await res.text()
      const contents = xml.match(CONTENTS_RE) ?? []
      for (const c of contents) {
        const key = KEY_RE.exec(c)?.[1]
        const size = Number(SIZE_RE.exec(c)?.[1] ?? '0')
        const lastModified = LAST_MODIFIED_RE.exec(c)?.[1]
        if (key && lastModified)
          yield { key, size, lastModified }
      }
      const nextToken = NEXT_TOKEN_RE.exec(xml)?.[1]
      const isTruncated = IS_TRUNCATED_RE.test(xml)
      if (!isTruncated || !nextToken)
        break
      continuationToken = nextToken
    }
  }

  return { presignGet, listObjects }
}

// R2 object keys contain '/'; preserve slashes, encode other reserved chars.
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * Read R2 credentials from runtimeConfig and throw a clean 500 if any are
 * missing. Nitro routes call this before signing.
 */
export function useR2Client(): R2Client {
  const cfg = useRuntimeConfig()
  const missing: string[] = []
  if (!cfg.r2AccountId)
    missing.push('R2_ACCOUNT_ID')
  if (!cfg.r2AccessKeyId)
    missing.push('R2_ACCESS_KEY_ID')
  if (!cfg.r2SecretAccessKey)
    missing.push('R2_SECRET_ACCESS_KEY')
  if (!cfg.r2Bucket)
    missing.push('R2_BUCKET')
  if (missing.length > 0)
    throw createError({ statusCode: 500, statusMessage: `R2 config missing: ${missing.join(', ')}` })

  return createR2Client({
    accountId: cfg.r2AccountId,
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    bucket: cfg.r2Bucket,
  })
}
