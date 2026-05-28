/** Replicates the 16-hex-char slug `opfs.ts` derives from a `contentHash`. */
export async function contentHashSlugFor(contentHash: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(contentHash))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < 8; i++)
    hex += bytes[i]!.toString(16).padStart(2, '0')
  return hex
}
