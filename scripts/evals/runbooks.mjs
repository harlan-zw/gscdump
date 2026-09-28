// These cases exercise the decision path in each CLI guide. A real Site may
// lack a signal, so the transcript still needs human review before a claim
// about the answer is accepted.
export const RUNBOOK_CASES = [
  { id: 'weekly-triage', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'movers'], requiredFlags: ['--vs'], checks: [['query']], prompt: 'What changed in search traffic last week? Compare complete weeks. Check one changed page against source rows. Cite the Report Section and its dates. Do not infer a cause from clicks alone.' },
  { id: 'traffic-drop', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'triage'], requiredFlags: ['--target'], checks: [['query']], requiresUrl: true, prompt: 'Investigate a possible traffic drop for the supplied URL. Compare equal, complete windows and its query rows. Cite observed evidence and give a next check, not an unproven cause.' },
  { id: 'low-ctr', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'opportunities'], checks: [['query']], prompt: 'Find a query worth a CTR review. Check impressions, position, and its page. Treat potential extra clicks as an estimate, not a forecast.' },
  { id: 'brand-traffic', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'brand'], requiredFlags: ['--brand-terms', '--vs'], checks: [['query']], prompt: 'Did branded search traffic change? Use the brand term "example" and compare equal complete windows. Show the terms and the observed split before drawing a conclusion.' },
  { id: 'impressions-no-clicks', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['analyze', 'zero-click'], checks: [['query']], prompt: 'Find queries with impressions and few clicks. Check their pages and positions. Can these rows prove that AI search results caused the missing clicks? Explain the evidence limit.' },
  { id: 'growth-trends', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'growth'], requiredFlags: ['--vs'], checks: [['sync', '--status']], prompt: 'Is search growth seasonal? Check the history and comparison-window coverage before interpreting a year-over-year result. If there is too little history, say so instead of claiming a trend.' },
  { id: 'device-gaps', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['analyze', 'device-gap'], checks: [['query', '--live']], prompt: 'Check whether mobile and desktop search traffic differ. Keep the Site, dates, and search type fixed. Show the observed metrics before suggesting a next check.' },
  { id: 'page-overlap', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['report', 'pre-publish'], requiredFlags: ['--topic'], checks: [['query']], prompt: 'Before publishing a page about "example", check whether this Site already has pages receiving the same queries. Compare the pages. Do not call overlap harmful without evidence.' },
  { id: 'indexing-evidence', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['inspect'], checks: [['entities', 'show']], requiresUrl: true, prompt: 'For the supplied URL, check its Google Indexing Evidence. Give the observation date and uncertainty. Keep URL inspection separate from indexing change notifications.' },
  { id: 'google-and-bing', suite: 'runbooks', kind: 'runbook', seeded: false, operation: ['bing', 'inspect'], checks: [['inspect']], requiresBing: true, requiresUrl: true, prompt: 'Compare Google and Bing Indexing Evidence for the supplied URL. Show each Search Engine and observation date separately. Do not combine them into one indexing verdict.' },
]

for (const test of RUNBOOK_CASES)
  test.requiresStore = !['indexing-evidence', 'google-and-bing'].includes(test.id)

function matches(call, prefix) {
  if (prefix[0] === 'sync' && prefix[1] === '--status')
    return call.code === 0 && call.args[0] === 'sync' && call.args.includes('--status')
  if (prefix[0] === 'query' && prefix[1] === '--live')
    return call.code === 0 && call.args[0] === 'query' && call.args.includes('--live') && !call.args.includes('--help')
  return call.code === 0 && !call.args.includes('--help') && prefix.every((part, index) => call.args[index] === part)
}

function evidenceError(call, definition, expected) {
  if (call.code !== 0 || !call.stdout?.trim())
    return 'The primary CLI result is empty.'
  try {
    const value = JSON.parse(call.stdout)
    if (definition.operation[0] === 'report') {
      if (value?.id !== definition.operation[1] || !Array.isArray(value.sections) || !value.window?.start || !value.window?.end || value.meta?.degraded)
        return 'The Report lacks its ID, Sections, complete window, or healthy result.'
      if (expected?.site && value.site !== expected.site)
        return 'The Report used a different Site.'
    }
    else if (definition.operation[0] === 'analyze') {
      if (!Array.isArray(value?.results) || !value?.meta?.source || value.meta.coverage?.kind === 'truncated')
        return 'The Analyzer lacks results or complete source coverage.'
    }
    else if (definition.operation[0] === 'inspect') {
      if (value?.inspected < 1 || !Array.isArray(value.results) || !value.results.some(row => row.status === 'inspected' && (!expected?.url || row.url === expected.url)))
        return 'Google inspection did not return a saved observation.'
    }
    else if (definition.operation[0] === 'bing') {
      if (value?.searchEngine !== 'bing' || (expected?.url && value.url !== expected.url) || !('observedAt' in value))
        return 'Bing did not return dated or explicitly unknown evidence for the selected URL.'
    }
    else if (value === null || typeof value !== 'object' || Object.keys(value).length === 0) {
      return 'The primary CLI result lacks structured evidence.'
    }
    return null
  }
  catch {
    return 'The primary CLI result is not JSON.'
  }
}

export function gradeRunbook({ definition, calls, loaded, text, expected }) {
  const failures = []
  if (!loaded)
    failures.push('The agent did not load the skill.')
  const primary = calls.find(call => matches(call, definition.operation))
  if (!primary)
    failures.push(`The agent did not complete ${definition.operation.join(' ')}.`)
  if (primary) {
    for (const flag of definition.requiredFlags ?? []) {
      if (!primary.args.some(arg => arg === flag || arg.startsWith(`${flag}=`)))
        failures.push(`The ${definition.operation.join(' ')} call omitted ${flag}.`)
    }
  }
  for (const check of definition.checks) {
    if (!calls.some(call => matches(call, check)))
      failures.push(`The agent did not complete ${check.join(' ')}.`)
  }
  if (primary) {
    const error = evidenceError(primary, definition, expected)
    if (error)
      failures.push(error)
  }
  if (!text.trim())
    failures.push('The final answer is empty.')
  if (calls.some(call => call.code !== 0))
    failures.push('A CLI command failed or was denied; review the transcript.')
  return { passed: failures.length === 0, failures, reviewRequired: true }
}
