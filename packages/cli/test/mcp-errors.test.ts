import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analysisErrors } from '@gscdump/analysis/errors'
import { engineErrors } from '@gscdump/engine/errors'
import { queryErrors } from 'gscdump/query'
import { describe, expect, it } from 'vitest'
import { enrichToolError, mcpHandlerErrors, mcpHandlerErrorToException, toolErrorMessage } from '../src/mcp/errors'
import { customQueryResult } from '../src/mcp/handlers/query'
import { runReportHandlerResult } from '../src/mcp/handlers/reports'
import { createCliRuntime, runWithCliRuntime } from '../src/runtime'

const ctx = { auth: 'x', client: {} as any } as any

describe('mcp handler error cores (errors-as-values)', () => {
  it('runReportHandlerResult returns a typed unknown-report error', async () => {
    const r = await runReportHandlerResult({ id: 'nope', siteUrl: 'sc-domain:example.com' } as any, () => ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('unknown-report')
      expect(r.error.message).toContain('nope')
    }
  })

  it('runReportHandlerResult returns a typed unknown-period error', async () => {
    const r = await runReportHandlerResult({ id: 'movers', period: 'fortnight', siteUrl: 'sc-domain:example.com' } as any, () => ctx)
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error.kind).toBe('unknown-period')
  })

  it('runReportHandlerResult returns a typed unknown-comparison error', async () => {
    const r = await runReportHandlerResult({ id: 'movers', comparison: 'sideways', siteUrl: 'sc-domain:example.com' } as any, () => ctx)
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error.kind).toBe('unknown-comparison')
  })

  it('customQueryResult returns a typed no-valid-dimension error', async () => {
    const r = await customQueryResult(
      { siteUrl: 's', period: { start: '2026-01-01', end: '2026-01-02' }, dimensions: ['bogus'] } as any,
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(r.error.kind).toBe('no-valid-dimension')
  })

  it('the throwing wrapper preserves the verbatim message', () => {
    const e = mcpHandlerErrorToException(mcpHandlerErrors.unknownReport('x', ['health']))
    expect(e.message).toBe('Unknown report id "x". Available: health')
  })
})

describe('enrichToolError (consuming upstream typed errors)', () => {
  it('rewrites a QueryError into a [query:kind] payload', () => {
    const e = enrichToolError(queryErrors.unresolvableDataset(['page'], ['country']))
    expect(e?.message).toMatch(/^\[query:unresolvable-dataset\]/)
  })

  it('rewrites an EngineError into an [engine:kind] payload', () => {
    const e = enrichToolError(engineErrors.attachedTableMissing(['page_queries']))
    expect(e?.message).toMatch(/^\[engine:attached-table-missing\]/)
  })

  it('rewrites an AnalysisError and names the wrapped engine cause', () => {
    const cause = engineErrors.attachedTableMissing(['page_queries'])
    const analysis = analysisErrors.requiredStepFailed('health', 'striking', 'boom', cause)
    const e = enrichToolError(analysis)
    expect(e?.message).toMatch(/^\[analysis:required-step-failed\] \(engine:attached-table-missing\)/)
  })

  it('reads the typed union off a thrown wrapper Error', () => {
    const thrown = Object.assign(new Error('boom'), { queryError: queryErrors.missingDateRange() })
    const e = enrichToolError(thrown)
    expect(e?.message).toMatch(/^\[query:missing-date-range\]/)
  })

  it('returns null for an unmodelled defect', () => {
    expect(enrichToolError(new Error('totally unexpected'))).toBeNull()
  })
})

describe('toolErrorMessage (Google + hosted API failures)', () => {
  // google-auth-library throws this exact GaxiosError shape when the OAuth
  // token endpoint rejects a refresh: message `invalid_grant`, numeric
  // `.status`, and the response body at `.response.data`.
  const expiredGrant = Object.assign(new Error('invalid_grant'), {
    status: 400,
    response: {
      status: 400,
      data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    },
  })

  it('sends a rejected OAuth refresh to re-authentication, not the tool arguments', async () => {
    const message = await toolErrorMessage(expiredGrant)

    expect(message).toContain('Token has been expired or revoked.')
    expect(message).toContain('gscdump auth login')
    expect(message).not.toContain('Check the tool arguments')
  })

  it('keeps argument advice for a Google API 400', async () => {
    const badArgument = Object.assign(new Error('[GET] https://www.googleapis.com/url: 400'), {
      statusCode: 400,
      data: { error: { code: 400, message: 'Invalid dimension "bogus".' } },
    })

    const message = await toolErrorMessage(badArgument)

    expect(message).toContain('Invalid dimension "bogus".')
    expect(message).toContain('Check the tool arguments')
  })

  it('points a failing service-account credential at its key file, not the BYOK env vars', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gscdump-mcp-errors-'))
    const keyPath = path.join(configDir, 'service-account.json')
    await fs.writeFile(keyPath, JSON.stringify({
      type: 'service_account',
      client_email: 'stub@gscdump-test.iam.gserviceaccount.com',
      private_key: privateKey,
    }))
    // Tool handlers resolve the credential through this invocation's runtime.
    const runtime = createCliRuntime({
      configDir,
      environment: { GSC_SERVICE_ACCOUNT_JSON: keyPath, GSC_ACCESS_TOKEN: 'stale-token' },
    })
    // google-auth-library rethrows a rejected service-account token mint as a
    // GaxiosError: message `error: description`, numeric `.status`, body at
    // `.response.data`.
    const rejectedMint = Object.assign(new Error('invalid_client: Unauthorized'), {
      status: 401,
      response: {
        status: 401,
        data: { error: 'invalid_client', error_description: 'Unauthorized' },
      },
    })

    const message = await runWithCliRuntime(runtime, () => toolErrorMessage(rejectedMint))

    expect(message).toContain('API error 401')
    expect(message).toContain('GSC_SERVICE_ACCOUNT_JSON')
    expect(message).not.toContain('GSC_ACCESS_TOKEN')
    expect(message).not.toContain('gscdump auth login')
    await fs.rm(configDir, { recursive: true, force: true })
  })
})
