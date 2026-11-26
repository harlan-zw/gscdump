import {
  chartAnnotationsQueryV1Schema,
  createSiteAnnotationV1Schema,
  updateSiteAnnotationV1Schema,
} from '@gscdump/contracts/v1'
import { defineCommand } from 'citty'
import { annotationsCommandMeta } from '../command-meta'
import { HOSTED_ARGS, resolveHostedSite, resolveHostedSiteWithTarget } from '../hosted-site'
import { renderTable } from '../render/layout'
import { terminalOutputOptions } from '../render/terminal'
import { commandLineError } from '../stop'
import { applyOutputMode, logger, OUTPUT_ARGS } from '../utils'

const LOCAL_ALTERNATIVE = 'track release notes locally; chart annotations are stored on gscdump.com'

function resolveSiteAndAnnotationId(args: Record<string, unknown>): { siteArg: string | undefined, annotationId: string } {
  const positionals = ((args._ as string[] | undefined) ?? []).map(String)
  if (positionals.length > 2)
    throw commandLineError(`Unexpected positional argument: ${positionals[2]}.`)
  const flagSite = args.site ? String(args.site) : undefined
  if (positionals.length === 2) {
    if (flagSite)
      throw commandLineError('Pass either positional <site> <annotationId> or --site <site> <annotationId>, not both.')
    return { siteArg: positionals[0], annotationId: positionals[1]! }
  }
  if (positionals.length === 1)
    return { siteArg: flagSite, annotationId: positionals[0]! }
  throw commandLineError('Missing annotation ID.')
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List custom annotations and Google Search ranking updates for a Site (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    start: { type: 'string', description: 'First day to include (YYYY-MM-DD)' },
    end: { type: 'string', description: 'Last day to include (YYYY-MM-DD)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const parsedQuery = chartAnnotationsQueryV1Schema.safeParse({
      ...(args.start ? { startDate: String(args.start) } : {}),
      ...(args.end ? { endDate: String(args.end) } : {}),
    })
    if (!parsedQuery.success)
      throw commandLineError(parsedQuery.error.issues[0]?.message ?? 'Invalid date range.')

    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'annotations list', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.getChartAnnotations({
      params: { siteId: site.siteId },
      query: parsedQuery.data,
    })

    if (json) {
      console.log(JSON.stringify({ siteId: site.siteId, siteUrl: site.siteUrl, ...data }, null, 2))
      return
    }
    if (data.annotations.length === 0) {
      logger.info(`No chart annotations found for ${site.siteUrl}.`)
      return
    }
    for (const line of renderTable(
      data.annotations.map(item => ({
        date: item.date,
        category: item.category,
        id: item.id,
        label: item.label,
        description: item.description ?? '',
      })),
      [
        { key: 'date', label: 'Date' },
        { key: 'category', label: 'Category' },
        { key: 'id', label: 'ID' },
        { key: 'label', label: 'Title' },
        { key: 'description', label: 'Note' },
      ],
      terminalOutputOptions(),
    )) {
      console.log(line)
    }
  },
})

const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Create a custom chart annotation on a Site (hosted)',
  },
  args: {
    target: { type: 'positional', required: false, description: 'Site URL or Site ID (or pass --site)' },
    ...HOSTED_ARGS,
    date: { type: 'string', required: true, description: 'Calendar day (YYYY-MM-DD)' },
    title: { type: 'string', required: true, description: 'Short marker label (1 to 120 characters)' },
    note: { type: 'string', description: 'Optional note shown in the marker popover' },
    url: { type: 'string', description: 'Optional http or https link' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const parsedBody = createSiteAnnotationV1Schema.safeParse({
      date: String(args.date),
      title: String(args.title),
      ...(args.note !== undefined ? { note: String(args.note) } : {}),
      ...(args.url !== undefined ? { url: String(args.url) } : {}),
    })
    if (!parsedBody.success)
      throw commandLineError(parsedBody.error.issues[0]?.message ?? 'Invalid annotation input.')

    const { client, site } = await resolveHostedSiteWithTarget(
      args as Record<string, unknown>,
      { name: 'annotations create', localAlternative: LOCAL_ALTERNATIVE },
      args.target ? String(args.target) : undefined,
    )
    const { data } = await client.createSiteAnnotation({
      params: { siteId: site.siteId },
      body: parsedBody.data,
    })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    logger.success(`Created annotation ${data.annotation.id} on ${site.siteUrl} (${data.annotation.date}: ${data.annotation.title}).`)
  },
})

const updateCommand = defineCommand({
  meta: {
    name: 'update',
    description: 'Update a custom chart annotation on a Site (hosted)',
  },
  args: {
    first: { type: 'positional', required: true, description: 'Site (when passing <site> <annotationId>) or annotation ID (with --site)' },
    second: { type: 'positional', required: false, description: 'Annotation ID (when passing <site> <annotationId>)' },
    ...HOSTED_ARGS,
    date: { type: 'string', description: 'Calendar day (YYYY-MM-DD)' },
    title: { type: 'string', description: 'Short marker label (1 to 120 characters)' },
    note: { type: 'string', description: 'Note text (pass an empty string to clear)' },
    url: { type: 'string', description: 'http or https link (pass an empty string to clear)' },
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { siteArg, annotationId } = resolveSiteAndAnnotationId(args as Record<string, unknown>)
    const parsedBody = updateSiteAnnotationV1Schema.safeParse({
      ...(args.date !== undefined ? { date: String(args.date) } : {}),
      ...(args.title !== undefined ? { title: String(args.title) } : {}),
      ...(args.note !== undefined ? { note: String(args.note) === '' ? null : String(args.note) } : {}),
      ...(args.url !== undefined ? { url: String(args.url) === '' ? null : String(args.url) } : {}),
    })
    if (!parsedBody.success)
      throw commandLineError(parsedBody.error.issues[0]?.message ?? 'Provide at least one field to update.')

    const { client, site } = await resolveHostedSite(
      { ...args, ...(siteArg ? { site: siteArg } : {}), _: [] },
      { name: 'annotations update', localAlternative: LOCAL_ALTERNATIVE },
    )
    const { data } = await client.updateSiteAnnotation({
      params: { siteId: site.siteId, annotationId },
      body: parsedBody.data,
    })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    logger.success(`Updated annotation ${data.annotation.id} on ${site.siteUrl} (${data.annotation.date}: ${data.annotation.title}).`)
  },
})

const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a custom chart annotation from a Site (hosted)',
  },
  args: {
    first: { type: 'positional', required: true, description: 'Site (when passing <site> <annotationId>) or annotation ID (with --site)' },
    second: { type: 'positional', required: false, description: 'Annotation ID (when passing <site> <annotationId>)' },
    ...HOSTED_ARGS,
    ...OUTPUT_ARGS,
  },
  async run({ args }) {
    const { json } = applyOutputMode(args)
    const { siteArg, annotationId } = resolveSiteAndAnnotationId(args as Record<string, unknown>)
    const { client, site } = await resolveHostedSite(
      { ...args, ...(siteArg ? { site: siteArg } : {}), _: [] },
      { name: 'annotations delete', localAlternative: LOCAL_ALTERNATIVE },
    )
    const { data } = await client.deleteSiteAnnotation({
      params: { siteId: site.siteId, annotationId },
    })

    if (json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    logger.success(`Deleted annotation ${data.id} from ${site.siteUrl}.`)
  },
})

export const annotationsCommand = defineCommand({
  meta: annotationsCommandMeta,
  subCommands: {
    list: listCommand,
    create: createCommand,
    update: updateCommand,
    delete: deleteCommand,
  },
})
