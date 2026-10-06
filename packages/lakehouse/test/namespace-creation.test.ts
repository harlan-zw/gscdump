import type { IcebergConnection } from '../src/catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { createIcebergNamespace } from '../src/index'

const conn = { namespace: 'gsc_source_v1', catalog: { type: 'rest', url: 'https://catalog.example', prefix: '', defaults: {}, overrides: {} }, resolver: {} } as IcebergConnection
afterEach(() => vi.unstubAllGlobals())
it('proves a fresh namespace through its real REST create response', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://catalog.example/v1/namespaces')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toMatchObject({ namespace: ['gsc_source_v1'] })
    return Response.json({ namespace: ['gsc_source_v1'], properties: {} }, { status: 201 })
  }))
  expect(await createIcebergNamespace(conn)).toEqual({ _tag: 'Created' })
})
it('returns an existing namespace without treating it as creation proof', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 409, type: 'AlreadyExistsException', message: 'Namespace exists' } }, { status: 409 })))
  expect(await createIcebergNamespace(conn)).toEqual({ _tag: 'Exists' })
})
it.each([401, 500])('propagates catalog failure %s', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: status, message: 'Catalog unavailable' } }, { status })))
  await expect(createIcebergNamespace(conn)).rejects.toMatchObject({ status })
})
it('does not classify a network message containing409 as existing namespace', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Proxy conflict409 but no catalog response')
  }))
  await expect(createIcebergNamespace(conn)).rejects.toThrow('Proxy conflict409')
})
