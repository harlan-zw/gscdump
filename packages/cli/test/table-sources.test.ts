import type { ManifestEntry } from '../src/local-store'
import { describe, expect, it } from 'vitest'
import { groupTableSources } from '../src/table-sources'

function entry(siteId: string): ManifestEntry {
  return { userId: 'local', siteId, table: 'pages', partition: 'daily/2026-08-01', objectKey: `${siteId}/pages.parquet`, rowCount: 3, bytes: 10, createdAt: 0 }
}

describe('groupTableSources', () => {
  it('tags rows with the Site URL the Site map records', () => {
    // `h_example.com` decodes to https, but the Store holds the http Site.
    const [source] = groupTableSources([entry('h_example.com')], '/data', { 'h_example.com': 'http://example.com/' })
    expect(source!.site).toBe('http://example.com/')
  })

  it('decodes the siteId for a Store created before the Site map', () => {
    const [source] = groupTableSources([entry('d_example.com')], '/data', {})
    expect(source!.site).toBe('sc-domain:example.com')
  })
})
