import type { GscSite, GscSitemap, RequiredNonNullable } from 'gscdump'
import type { z } from 'zod'
import type { HandlerContext, listSitemapsInput, listSitesInput, Site, sitemapInput } from '../types'
import { fetchGscSites, fetchGscSitesWithSitemaps, fetchSitemaps, deleteSitemap as gscDeleteSitemap, getSitemap as gscGetSitemap, submitSitemap as gscSubmitSitemap } from 'gscdump'

export async function listSites(
  _input: z.infer<typeof listSitesInput>,
  ctx: HandlerContext,
): Promise<GscSite[]> {
  return fetchGscSites(ctx.auth)
}

export async function listSitesWithSitemaps(
  _input: z.infer<typeof listSitesInput>,
  ctx: HandlerContext,
): Promise<(Site & { sitemaps: RequiredNonNullable<GscSitemap>[] })[]> {
  return fetchGscSitesWithSitemaps(ctx.auth)
}

export async function listSitemaps(
  input: z.infer<typeof listSitemapsInput>,
  ctx: HandlerContext,
): Promise<GscSitemap[]> {
  return fetchSitemaps(ctx.auth, input.siteUrl)
}

export async function getSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<GscSitemap> {
  return gscGetSitemap(ctx.auth, input.siteUrl, input.feedpath)
}

export async function submitSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<{ success: boolean }> {
  await gscSubmitSitemap(ctx.auth, input.siteUrl, input.feedpath)
  return { success: true }
}

export async function deleteSitemap(
  input: z.infer<typeof sitemapInput>,
  ctx: HandlerContext,
): Promise<{ success: boolean }> {
  await gscDeleteSitemap(ctx.auth, input.siteUrl, input.feedpath)
  return { success: true }
}
