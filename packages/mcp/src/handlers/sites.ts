import type { ApiSite, ApiSitemap, RequiredNonNullable, Site } from 'gscdump'
import type { z } from 'zod'
import type { HandlerContext, listSitemapsInput, listSitesInput, sitemapInput } from '../types'
import { fetchSites, fetchSitesWithSitemaps, fetchSitemaps, deleteSitemap as gscDeleteSitemap, fetchSitemap as gscFetchSitemap, submitSitemap as gscSubmitSitemap } from 'gscdump'

export async function listSites(
  _input: z.infer<typeof listSitesInput>,
  ctx: HandlerContext,
): Promise<ApiSite[]> {
  return fetchSites(ctx.client)
}

export async function listSitesWithSitemaps(
  _input: z.infer<typeof listSitesInput>,
  ctx: HandlerContext,
): Promise<(Site & { sitemaps: RequiredNonNullable<ApiSitemap>[] })[]> {
  return fetchSitesWithSitemaps(ctx.client)
}

export async function listSitemaps(
  input: z.infer<typeof listSitemapsInput>,
  ctx: HandlerContext,
): Promise<ApiSitemap[]> {
  return fetchSitemaps(ctx.client, input.siteUrl)
}

export async function getSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<ApiSitemap> {
  return gscFetchSitemap(ctx.client, input.siteUrl, input.feedpath)
}

export async function submitSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<{ success: boolean }> {
  await gscSubmitSitemap(ctx.client, input.siteUrl, input.feedpath)
  return { success: true }
}

export async function deleteSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<{ success: boolean }> {
  await gscDeleteSitemap(ctx.client, input.siteUrl, input.feedpath)
  return { success: true }
}
