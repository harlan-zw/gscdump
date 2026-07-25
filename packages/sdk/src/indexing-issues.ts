// Catalog + grouping for the GSC indexing-coverage issue types. Pure data.
//
// Host UIs layer their own visual config (severity colors, icon→tailwind class
// maps) on top of these slugs.

export interface IndexingIssueDetail {
  description: string
  fix: string
}

export type IssueSeverity = 'error' | 'warning' | 'info'

export interface IndexingIssue {
  type: string
  label: string
  severity: IssueSeverity
  count: number
}

export const issueDetails: Record<string, IndexingIssueDetail> = {
  crawled_not_indexed: {
    description: 'Google crawled these pages but decided not to add them to the index. This often means the content was deemed low-quality, duplicate, or not useful enough.',
    fix: 'Improve content quality and uniqueness. Add internal links pointing to these pages. Ensure they have clear, distinct value compared to other pages on your site.',
  },
  discovered_not_indexed: {
    description: 'Google knows these URLs exist but hasn\'t crawled them yet. This is usually a crawl-budget or priority signal — Google deemed other pages more important.',
    fix: 'Add strong internal links from indexed pages. Submit the URL via Search Console\'s URL Inspection > Request Indexing. Improve site authority and crawl-budget signals; check no resource constraints (slow server, large response sizes) are deterring the crawl.',
  },
  server_error: {
    description: 'Google encountered 5xx server errors when trying to crawl these URLs. The pages were unreachable at crawl time.',
    fix: 'Check your server logs for errors. Ensure your hosting can handle Googlebot traffic. Fix any backend issues causing 500/502/503 errors.',
  },
  access_forbidden: {
    description: 'Your server returned 403 Forbidden to Googlebot. Usually a WAF, bot-protection rule, or firewall treating the crawler as an attacker — a human visitor may see the page fine.',
    fix: 'Allowlist Googlebot in your WAF / bot-protection rules and verify by IP, not user agent. Check Cloudflare bot-fight mode, rate limits, and any geo or ASN blocking. Re-test with the URL Inspection tool\'s "Test live URL".',
  },
  access_denied: {
    description: 'Your server returned 401 Unauthorized to Googlebot. The URL sits behind an authentication wall.',
    fix: 'If the page should rank, remove the auth requirement for crawlers or move the content to a public URL. If it is genuinely private, block it in robots.txt or noindex it so it stops being reported as an indexing failure.',
  },
  blocked_4xx: {
    description: 'Google got a 4xx response other than 401, 403, or 404 — commonly 410 Gone, 429 Too Many Requests, or 451.',
    fix: 'Check which status the URL actually returns. A 429 means Googlebot is being rate-limited: raise or exempt the crawler limit. A 410 is intentional deletion and will clear on its own.',
  },
  redirect_error: {
    description: 'Google could not follow the redirect — a redirect chain that is too long, a loop, an empty Location header, or a URL that exceeds the maximum length.',
    fix: 'Collapse redirect chains to a single hop. Look for loops (A→B→A) and self-redirects. Point internal links and sitemap entries at the final destination URL.',
  },
  crawl_error: {
    description: 'Google hit an internal crawl error or considered the URL malformed. Often transient on Google\'s side, but a persistent count means the URL itself is invalid.',
    fix: 'Verify the URL parses and resolves. Remove malformed URLs from your sitemap and internal links. If the URLs are valid, re-inspect in a few days — transient crawl errors clear themselves.',
  },
  sitemap_redirect: {
    description: 'These URLs are submitted in your sitemap but redirect elsewhere. A sitemap should only list final, canonical, 200-status URLs — a redirecting entry wastes crawl budget and tells Google your sitemap is stale.',
    fix: 'Replace each redirecting entry with its destination URL, or drop it from the sitemap entirely. Then resubmit the sitemap.',
  },
  alternate_canonical: {
    description: 'These pages declare a canonical pointing at another page, and Google honoured it. The canonical target is what gets indexed. Usually intentional.',
    fix: 'Nothing to fix if the canonical is deliberate. If these pages should rank on their own, make each one self-canonical and give it genuinely distinct content.',
  },
  duplicate_no_canonical: {
    description: 'Google decided these pages duplicate another URL and picked the canonical itself, because the page declared no preference. You did not choose which URL ranks — Google did.',
    fix: 'Add a canonical link to every page. Point it at itself for pages that should rank, or at the preferred URL for genuine duplicates. Leaving it unset hands the decision to Google.',
  },
  indexed_consider_canonical: {
    description: 'These pages are indexed, and Google is telling you it found duplicates it thinks should point here. Nothing is broken; Google is naming the canonical it would honour if you declared it.',
    fix: 'Add a self-referencing canonical to each of these pages, and point the duplicate versions at them. This makes explicit the choice Google is already making, so it survives future recrawls instead of being re-decided each time.',
  },
  page_removed: {
    description: 'These URLs are suppressed by a request in Search Console\'s Removals tool. The block is temporary — roughly six months — and then they become eligible again.',
    fix: 'If the removal was intentional, back it with a real signal: a noindex tag, a 404/410, or authentication. The removal tool alone does not keep a page out of Search permanently.',
  },
  unknown_to_google: {
    description: 'These URLs exist on your site but Google hasn\'t discovered them yet. They may be orphaned pages or missing from your sitemap.',
    fix: 'Add these URLs to your sitemap. Create internal links to them from well-indexed pages. Submit the sitemap in Google Search Console.',
  },
  stale_crawl: {
    description: 'Google hasn\'t re-crawled these pages in over 30 days. They may have low perceived value or your crawl budget may be exhausted.',
    fix: 'Update content on these pages to signal freshness. Improve internal linking. Ensure your site loads quickly to maximize crawl budget efficiency.',
  },
  very_stale_crawl: {
    description: 'Google hasn\'t visited these pages in over 60 days. They are at risk of being dropped from the index entirely.',
    fix: 'Prioritize updating these pages immediately. Add fresh internal links. Consider requesting re-indexing via Google Search Console\'s URL Inspection tool.',
  },
  not_found: {
    description: 'These URLs return 404 errors. Google previously knew about them but they no longer exist.',
    fix: 'If the content moved, add 301 redirects to the new URLs. If intentionally removed, ensure no internal links still point to them. The 404s will clear over time.',
  },
  soft_404: {
    description: 'These pages return a 200 status but Google detects them as effectively empty or error pages — "soft" 404s.',
    fix: 'Return a proper 404 status code for missing pages. If the pages should exist, add meaningful content. Avoid thin placeholder pages.',
  },
  blocked_robots: {
    description: 'Your robots.txt file is preventing Google from crawling these URLs.',
    fix: 'Review your robots.txt rules. Remove Disallow directives for pages you want indexed. Remember that blocked pages can\'t be indexed even if linked.',
  },
  noindex: {
    description: 'These pages have a noindex meta tag or X-Robots-Tag header, telling Google not to include them in search results.',
    fix: 'If these pages should be indexed, remove the noindex directive. Check for noindex in meta tags, HTTP headers, and any SEO plugin configuration.',
  },
  redirect: {
    description: 'These URLs redirect to other pages. Google follows the redirect and indexes the destination instead.',
    fix: 'This is usually expected behavior. Ensure redirects point to the correct destination. Update internal links to point directly to the final URL to save crawl budget.',
  },
  canonical_mismatch: {
    description: 'The canonical URL declared on these pages points to a different URL. Google may index the canonical target instead.',
    fix: 'Ensure each page\'s canonical tag points to itself, or intentionally to the preferred version. Fix any unintended canonical tags added by CMS plugins.',
  },
  fragment_url: {
    description: 'These URLs contain fragment identifiers (#). Googlebot typically ignores fragments as they\'re client-side only.',
    fix: 'Avoid using fragment URLs as unique pages. If using client-side routing with hashes, migrate to proper URL paths for better indexability.',
  },
  not_indexed: {
    description: 'These URLs are not in Google\'s index. This is a general category — the specific reason may vary.',
    fix: 'Check individual URLs in Google Search Console\'s URL Inspection tool for specific reasons. Common causes include quality, duplicate content, or crawl issues.',
  },
}

export const severityOrder: IssueSeverity[] = ['error', 'warning', 'info']

export interface IssueGroup {
  id: string
  label: string
  icon: string
  description: string
  /** How hard are these to fix? Shown as a badge */
  effort: 'quick' | 'moderate' | 'involved'
  /** Does the user have direct control over these? */
  controlLevel: 'full' | 'partial' | 'none'
  /** Educational explanation shown in the group header */
  education: string
  /** Issue types belonging to this group */
  issueTypes: string[]
}

export const issueGroups: IssueGroup[] = [
  {
    id: 'quick-wins',
    label: 'Quick Wins',
    icon: 'i-lucide-zap',
    description: 'Configuration changes you can make right now',
    effort: 'quick',
    controlLevel: 'full',
    education: 'These issues are caused by your site\'s configuration preventing Google from indexing certain pages. If these pages should be indexed, the fix is usually a one-line config change — remove a robots.txt rule, fix a canonical URL, or drop a redirecting entry from your sitemap. Highest-ROI fixes, zero content work.',
    // `indexed_consider_canonical` belongs here rather than under Expected
    // Behavior: the page is fine, but Google has named the exact one-line
    // change it would honour, which is the definition of a quick win.
    issueTypes: ['blocked_robots', 'canonical_mismatch', 'duplicate_no_canonical', 'indexed_consider_canonical', 'sitemap_redirect'],
  },
  {
    id: 'technical',
    label: 'Technical Fixes',
    icon: 'i-lucide-wrench',
    description: 'Server and URL issues to resolve',
    effort: 'moderate',
    controlLevel: 'full',
    education: 'These are infrastructure problems — your server is returning errors, blocking Googlebot at the edge, failing to follow redirects, or serving pages that look empty. Fix crawl blocks and server errors first (they cost crawl budget and can drop indexed pages), then handle 404s with redirects.',
    issueTypes: ['server_error', 'not_found', 'soft_404', 'access_forbidden', 'access_denied', 'blocked_4xx', 'redirect_error', 'crawl_error'],
  },
  {
    id: 'content-discovery',
    label: 'Content & Discovery',
    icon: 'i-lucide-file-search',
    description: 'Help Google find and value your pages',
    effort: 'involved',
    controlLevel: 'partial',
    education: 'Google found these pages but either didn\'t think they were worth indexing, or hasn\'t discovered them yet. For crawled-but-not-indexed pages, improving content quality and internal linking helps — but Google ultimately decides what to index. For undiscovered pages, adding them to your sitemap and linking to them from indexed pages is the fix.',
    issueTypes: ['crawled_not_indexed', 'discovered_not_indexed', 'unknown_to_google', 'stale_crawl', 'very_stale_crawl'],
  },
  {
    id: 'expected',
    label: 'Expected Behavior',
    icon: 'i-lucide-info',
    description: 'Usually intentional — review but likely fine',
    effort: 'quick',
    controlLevel: 'none',
    education: 'These aren\'t really "issues" — they\'re usually intentional. Noindex tags are set deliberately to keep pages out of search. Redirects are normal when you move pages. An alternate page with a proper canonical is consolidation working as designed. Fragment URLs are stripped by Google. Review to make sure nothing unexpected is here.',
    issueTypes: ['noindex', 'redirect', 'alternate_canonical', 'page_removed', 'fragment_url'],
  },
]
