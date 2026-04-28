// R2 S3-compatible presigned URL generation via SigV4 query signing.
//
// Used for browser-direct httpfs reads of parquet objects. The browser hits
// `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?X-Amz-...` and
// R2 validates the signature without requiring a Worker to proxy bytes.
//
// Requires R2 S3 API token (secrets: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
// plus CLOUDFLARE_ACCOUNT_ID to build the endpoint hostname.

import type { AnalyticsEnv } from './env'
import { AwsClient } from 'aws4fetch'
import { createError } from 'h3'

export interface PresignOptions {
  key: string
  bucket: string
  expiresIn?: number
}

export function createR2Presigner(env: AnalyticsEnv) {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw createError({ statusCode: 500, message: 'R2 S3 credentials missing (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)' })
  if (!env.CLOUDFLARE_ACCOUNT_ID)
    throw createError({ statusCode: 500, message: 'CLOUDFLARE_ACCOUNT_ID missing' })

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })

  const endpoint = `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`

  return async function presignGet({ key, bucket, expiresIn = 3600 }: PresignOptions): Promise<string> {
    const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`)
    url.searchParams.set('X-Amz-Expires', String(expiresIn))
    const signed = await aws.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    })
    return signed.url
  }
}

// R2 object keys contain '/'; preserve slashes, encode other reserved chars.
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}
