/**
 * What an agent or a person reads when they ask for AI Overviews, AI Mode, or
 * other generative AI data. Google has no API for this data, so the only source
 * is the export zip that the user uploads. The packaged skill, the MCP tool
 * descriptions, and `generative-ai show` all say the same thing.
 */
export const GENERATIVE_AI_EXPORT_PATH = 'Search Console > Performance > Generative AI features > choose the date range > Export > Download CSV'

export function generativeAiUploadCommand(site = '<site>'): string {
  return `gscdump generative-ai upload <zip> --site ${site}`
}

/** One line per step. `site` fills the upload command. */
export function generativeAiUploadSteps(site?: string): string[] {
  return [
    'Google has no API for AI Overviews, AI Mode, or other generative AI data.',
    `To provide it, open ${GENERATIVE_AI_EXPORT_PATH}. The download is a zip.`,
    `Then upload the zip: ${generativeAiUploadCommand(site)}`,
    'The data is impressions only, with no queries and no clicks. It is fresh as of the last upload.',
  ]
}

/** For an MCP tool that reads Search Console rows: it has no generative AI data. */
export const GENERATIVE_AI_TOOL_NOTE = [
  'This tool returns no AI Overviews, AI Mode, or generative AI data, because Google has no API for it.',
  `If the user asks for that data, tell them to open ${GENERATIVE_AI_EXPORT_PATH}, then run \`${generativeAiUploadCommand()}\` in Hosted mode.`,
  'That data is impressions only, with no queries and no clicks, and is fresh as of the last upload.',
].join(' ')
