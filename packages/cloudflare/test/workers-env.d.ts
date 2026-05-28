declare module 'cloudflare:test' {
  interface ProvidedEnv {
    TEST_BUCKET: import('@cloudflare/workers-types').R2Bucket
  }
}
