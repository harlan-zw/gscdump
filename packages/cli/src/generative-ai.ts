import type { GenerativeAiReportParseError } from '@gscdump/sdk/generative-ai-report'
import type { StopDetails } from './stop'

/** The Site that the uploader selected, in the parser's terms. Mirrors gscdump.com's registered host rule. */
export function generativeAiSiteOf(siteUrl: string): { registeredHost: string, gscProperty: string | null } {
  const registeredHost = siteUrl
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
  const gscProperty = /^(?:sc-domain:|https?:\/\/)/.test(siteUrl) ? siteUrl : null
  return { registeredHost, gscProperty }
}

export type GenerativeAiExportRefusal = StopDetails & { code: 'GENERATIVE_AI_EXPORT_REFUSED', refusal: GenerativeAiReportParseError }

function noHostRowsMessage(host: string): string {
  return `This export has no pages on ${host}. Select the Site that this export belongs to.`
}

function refusalMessage(error: GenerativeAiReportParseError): string {
  switch (error._tag) {
    case 'not_a_report_zip':
      return `This file is not a Search Console export zip (${error.reason}). Download the export again, and upload it unchanged.`
    case 'file_too_large':
      return `This file is too large: the ${error.scope} has ${error.found} bytes, and the limit is ${error.limit}. Upload the Generative AI report export.`
    case 'unexpected_entries':
      return `This zip has unexpected files. Found: ${error.found.join(', ') || 'none'}. Missing: ${error.missing.join(', ') || 'none'}. Upload the zip that Search Console downloads, unchanged.`
    case 'invalid_encoding':
      return `${error.file} cannot be read (${error.reason}${error.line === null ? '' : ` at line ${error.line}`}). Download the export again.`
    case 'unrecognized_headers':
      return `${error.file} has the headers ${error.found.join(', ')}. Expected ${error.expected.join(', ')}. Upload the Generative AI report export.`
    case 'not_generative_ai_report':
      return 'This file is the Search results export. Open Generative AI features in Search Console, then export from there.'
    case 'unsupported_filter':
      return `This export uses the filter ${error.filter}. Remove the filter, then export again.`
    case 'discover_not_supported':
      return 'Discover exports are not supported yet. Export the Search report.'
    case 'invalid_chart_dates':
      return `Chart.csv has invalid dates (${error.reason}${error.found === null ? '' : `: ${error.found}`}).`
    case 'invalid_impressions':
      return `${error.file} has an invalid impressions value: ${error.found}.`
    case 'invalid_device':
      return `Devices.csv has an unknown device: ${error.found}.`
    case 'invalid_page_url':
      return `Pages.csv has an invalid page URL: ${error.found}.`
    case 'duplicate_rows':
      return `${error.file} repeats the row ${error.found}.`
    case 'too_many_rows':
      return `${error.file} has ${error.found} rows. The limit is ${error.limit}.`
    case 'no_registered_host_rows':
      return noHostRowsMessage(error.host)
  }
}

/** The stop for an export the parser refuses. `refusal` keeps the parser's tagged error for agents. */
export function generativeAiExportRefusal(error: GenerativeAiReportParseError): GenerativeAiExportRefusal {
  return { code: 'GENERATIVE_AI_EXPORT_REFUSED', message: refusalMessage(error), nextCommand: null, refusal: error }
}

const OWN_NOT_FOUND_CODES = new Set(['site_not_found', 'generative_ai_report_upload_not_found'])

/**
 * The stop for a hosted failure that a Generative AI command can name, or undefined.
 * A host without these operations answers 404 for an unknown route, 405, or 501.
 * Matched by name, as `isSessionExpiredError` does.
 */
export function generativeAiHostedStop(error: unknown, context: { apiRoot: string, siteId: string, registeredHost: string }): StopDetails | undefined {
  if (!(error instanceof Error) || error.name !== 'GscdumpV1Error')
    return undefined
  const { status, code } = error as { status?: unknown, code?: unknown }
  if (code === 'generative_ai_report_upload_not_found') {
    return {
      code: 'GENERATIVE_AI_UPLOAD_NOT_FOUND',
      message: `No Generative AI report upload has this id for the Site. List the uploads to find the id.`,
      nextCommand: `gscdump generative-ai list --site ${context.siteId} --json`,
    }
  }
  if (code === 'no_registered_host_rows')
    return { code: 'GENERATIVE_AI_EXPORT_REFUSED', message: noHostRowsMessage(context.registeredHost), nextCommand: null }
  if (status === 405 || status === 501 || (status === 404 && !OWN_NOT_FOUND_CODES.has(String(code)))) {
    return {
      code: 'GENERATIVE_AI_UNAVAILABLE',
      message: `${context.apiRoot} does not serve Generative AI report uploads. Keep the export zip, and upload it when the host supports it.`,
      nextCommand: null,
    }
  }
  return undefined
}
