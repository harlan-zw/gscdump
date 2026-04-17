// useActionPriority() — pure UI/synthesis composable. Runs five DuckDB-backed
// analyzers in parallel via a shared InsightRunner, normalizes each result set
// into a unified PriorityAction shape, dedupes by `${keyword}|${page}`, and
// ranks them by a composite priority score. Returns the top 40 for a
// "what to do this week" ranked list.

import type { AnalyzeResult, InsightRunner } from './useInsightRunner'

export type ActionSource
  = | 'cannibalization'
    | 'striking-distance'
    | 'ctr-anomaly'
    | 'change-point'
    | 'opportunity'

export type Effort = 'low' | 'medium' | 'high'

export interface PriorityAction {
  id: string
  title: string
  keyword: string
  page: string
  sources: ActionSource[]
  severity: number
  impressions: number
  impact: number
  why: string
  effort: Effort
  priorityScore: number
  data: Partial<Record<ActionSource, Record<string, unknown>>>
}

export interface ActionPriorityProgress {
  phase: 'idle' | 'running' | 'done' | 'error'
  message: string
  completed: number
  total: number
  sources: Record<ActionSource, 'pending' | 'running' | 'done' | 'skipped' | 'error'>
}

export interface ActionPriorityRunner {
  progress: Ref<ActionPriorityProgress>
  actions: Ref<PriorityAction[]>
  error: Ref<Error | null>
  running: Ref<boolean>
  run: (runner: InsightRunner) => Promise<void>
}

const SOURCES: ActionSource[] = [
  'striking-distance',
  'opportunity',
  'cannibalization',
  'ctr-anomaly',
  'change-point',
]

const EFFORT_BY_SOURCE: Record<ActionSource, Effort> = {
  'striking-distance': 'low',
  'opportunity': 'low',
  'cannibalization': 'medium',
  'ctr-anomaly': 'high',
  'change-point': 'high',
}

const EFFORT_MULTIPLIER: Record<Effort, number> = {
  low: 1.3,
  medium: 1.0,
  high: 0.7,
}

// Lower effort beats higher effort when a pair is merged across sources.
const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 }

function idKey(keyword: string, page: string): string {
  return `${keyword.toLowerCase()}|${page.toLowerCase()}`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

// ---- per-source normalizers ---------------------------------------------------

interface StrikingDistanceRow {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  potentialClicks: number
}

function fromStrikingDistance(rows: StrikingDistanceRow[]): PriorityAction[] {
  const out: PriorityAction[] = []
  for (const r of rows) {
    if (r.page == null)
      continue
    const impact = Math.max(0, r.potentialClicks)
    if (impact <= 0)
      continue
    // Severity: position 4..20 → scale how close we are to page 1 (closer = higher)
    const posScore = Math.max(0, Math.min(1, (20 - r.position) / 16))
    const imprScore = Math.min(1, r.impressions / 5000)
    const severity = Math.round(100 * Math.sqrt(posScore * imprScore))
    out.push({
      id: idKey(r.keyword, r.page),
      title: `Push "${truncate(r.keyword, 40)}" onto page 1`,
      keyword: r.keyword,
      page: r.page,
      sources: ['striking-distance'],
      severity,
      impressions: r.impressions,
      impact,
      effort: EFFORT_BY_SOURCE['striking-distance'],
      why: `Ranks #${r.position.toFixed(1)} with ${Math.round(r.impressions)} impressions; small gains unlock page-1 clicks.`,
      priorityScore: 0,
      data: { 'striking-distance': r as unknown as Record<string, unknown> },
    })
  }
  return out
}

interface OpportunityRow {
  keyword: string
  page: string | null
  clicks: number
  impressions: number
  ctr: number
  position: number
  opportunityScore: number
  potentialClicks: number
  factors: Record<string, number>
}

function fromOpportunity(rows: OpportunityRow[]): PriorityAction[] {
  const out: PriorityAction[] = []
  for (const r of rows) {
    if (r.page == null)
      continue
    const impact = Math.max(0, r.potentialClicks)
    if (impact <= 0)
      continue
    out.push({
      id: idKey(r.keyword, r.page),
      title: `Improve on-page for "${truncate(r.keyword, 40)}"`,
      keyword: r.keyword,
      page: r.page,
      sources: ['opportunity'],
      severity: Math.round(r.opportunityScore),
      impressions: r.impressions,
      impact,
      effort: EFFORT_BY_SOURCE.opportunity,
      why: `Opportunity score ${Math.round(r.opportunityScore)}; CTR ${(r.ctr * 100).toFixed(1)}% vs expected at pos ${r.position.toFixed(1)}.`,
      priorityScore: 0,
      data: { opportunity: r as unknown as Record<string, unknown> },
    })
  }
  return out
}

interface CannibalizationCompetitor {
  url: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  share: number
  rank: number
}

interface CannibalizationEvent {
  keyword: string
  totalImpressions: number
  totalClicks: number
  competitorCount: number
  leaderUrl: string
  leaderCtr: number
  leaderPosition: number
  hhi: number
  fragmentation: number
  stolenClicks: number
  severity: number
  competitors: CannibalizationCompetitor[]
}

function fromCannibalization(events: CannibalizationEvent[]): PriorityAction[] {
  const out: PriorityAction[] = []
  for (const ev of events) {
    if (ev.severity < 30)
      continue
    const impact = Math.max(0, ev.stolenClicks)
    out.push({
      id: idKey(ev.keyword, ev.leaderUrl),
      title: `Consolidate cannibalization on "${truncate(ev.keyword, 36)}"`,
      keyword: ev.keyword,
      page: ev.leaderUrl,
      sources: ['cannibalization'],
      severity: Math.round(ev.severity),
      impressions: ev.totalImpressions,
      impact,
      effort: EFFORT_BY_SOURCE.cannibalization,
      why: `${ev.competitorCount} URLs split ${Math.round(ev.totalImpressions)} impressions; leader loses ~${Math.round(ev.stolenClicks)} clicks to siblings.`,
      priorityScore: 0,
      data: { cannibalization: ev as unknown as Record<string, unknown> },
    })
  }
  return out
}

interface CtrAnomalyRow {
  keyword: string
  page: string
  breachDaysDown: number
  breachDaysUp: number
  clicksLost: number
  severity: number
  maxZ: number
  baselineCtr: number
  baselinePosition: number
  totalImpressions: number
  totalClicks: number
}

function fromCtrAnomaly(rows: CtrAnomalyRow[]): PriorityAction[] {
  const out: PriorityAction[] = []
  // Normalize severity: raw severity is impressions-weighted |z|, can be huge.
  // Scale against the max in this result set so it fits 0..100.
  let maxRaw = 0
  for (const r of rows) {
    if (r.severity > maxRaw)
      maxRaw = r.severity
  }
  for (const r of rows) {
    const impact = Math.max(0, r.clicksLost)
    if (impact <= 0)
      continue
    const sev = maxRaw > 0 ? Math.round((r.severity / maxRaw) * 100) : 0
    out.push({
      id: idKey(r.keyword, r.page),
      title: `Lift CTR on "${truncate(r.keyword, 36)}"`,
      keyword: r.keyword,
      page: r.page,
      sources: ['ctr-anomaly'],
      severity: sev,
      impressions: r.totalImpressions,
      impact,
      effort: EFFORT_BY_SOURCE['ctr-anomaly'],
      why: `CTR collapsed ${r.breachDaysDown} days at flat position; ~${Math.round(r.clicksLost)} clicks lost vs baseline ${(r.baselineCtr * 100).toFixed(1)}%.`,
      priorityScore: 0,
      data: { 'ctr-anomaly': r as unknown as Record<string, unknown> },
    })
  }
  return out
}

interface ChangePointRow {
  keyword: string
  page: string
  totalDays: number
  totalImpressions: number
  changeDate: string
  llr: number
  leftMean: number
  rightMean: number
  delta: number
  leftStddev: number
  rightStddev: number
  direction: 'improved' | 'worsened'
}

function fromChangePoint(rows: ChangePointRow[]): PriorityAction[] {
  const out: PriorityAction[] = []
  for (const r of rows) {
    if (r.direction !== 'worsened')
      continue
    // For position metric, leftMean - rightMean < 0 when worsened (position went up).
    // Take absolute drift × days-affected as a rough impact proxy.
    const days = Math.max(1, r.totalDays / 2)
    const drift = Math.abs(r.leftMean - r.rightMean)
    const impact = drift * days
    if (impact <= 0)
      continue
    // Severity from LLR, log-scaled: LLR 10 → ~33, 100 → ~67, 1000 → 100.
    const sev = Math.min(100, Math.max(0, Math.round((Math.log10(Math.max(10, r.llr)) / 3) * 100)))
    out.push({
      id: idKey(r.keyword, r.page),
      title: `Diagnose drop on "${truncate(r.keyword, 34)}"`,
      keyword: r.keyword,
      page: r.page,
      sources: ['change-point'],
      severity: sev,
      impressions: r.totalImpressions,
      impact,
      effort: EFFORT_BY_SOURCE['change-point'],
      why: `Significant regression around ${r.changeDate} (${r.leftMean.toFixed(1)} → ${r.rightMean.toFixed(1)}, LLR ${r.llr.toFixed(0)}).`,
      priorityScore: 0,
      data: { 'change-point': r as unknown as Record<string, unknown> },
    })
  }
  return out
}

function normalize(source: ActionSource, result: AnalyzeResult): PriorityAction[] {
  const rows = result.results as unknown
  if (source === 'striking-distance')
    return fromStrikingDistance(rows as StrikingDistanceRow[])
  if (source === 'opportunity')
    return fromOpportunity(rows as OpportunityRow[])
  if (source === 'cannibalization')
    return fromCannibalization(rows as CannibalizationEvent[])
  if (source === 'ctr-anomaly')
    return fromCtrAnomaly(rows as CtrAnomalyRow[])
  return fromChangePoint(rows as ChangePointRow[])
}

// ---- merge + rank -------------------------------------------------------------

function mergeActions(all: PriorityAction[]): PriorityAction[] {
  const byId = new Map<string, PriorityAction>()
  for (const a of all) {
    const existing = byId.get(a.id)
    if (existing == null) {
      byId.set(a.id, { ...a, sources: [...a.sources], data: { ...a.data } })
      continue
    }
    // Merge: union sources, sum impact, keep max severity + max impressions,
    // lowest effort wins, combine data, prefer the higher-severity source's title/why.
    const mergedSources = [...new Set([...existing.sources, ...a.sources])]
    const preferNew = a.severity > existing.severity
    const mergedEffort: Effort = EFFORT_RANK[a.effort] < EFFORT_RANK[existing.effort] ? a.effort : existing.effort
    byId.set(a.id, {
      id: existing.id,
      title: preferNew ? a.title : existing.title,
      keyword: existing.keyword,
      page: existing.page,
      sources: mergedSources,
      severity: Math.max(existing.severity, a.severity),
      impressions: Math.max(existing.impressions, a.impressions),
      impact: existing.impact + a.impact,
      why: preferNew ? a.why : existing.why,
      effort: mergedEffort,
      priorityScore: 0,
      data: { ...existing.data, ...a.data },
    })
  }
  return [...byId.values()]
}

function scoreAndRank(actions: PriorityAction[]): PriorityAction[] {
  for (const a of actions) {
    const mult = EFFORT_MULTIPLIER[a.effort]
    a.priorityScore = a.impact * (1 + a.severity / 100) * mult
  }
  actions.sort((a, b) => b.priorityScore - a.priorityScore)
  return actions
}

// ---- composable ---------------------------------------------------------------

function initialProgress(): ActionPriorityProgress {
  return {
    phase: 'idle',
    message: 'Ready. Runs 5 analyzers in parallel then synthesizes a prioritized action list.',
    completed: 0,
    total: SOURCES.length,
    sources: {
      'striking-distance': 'pending',
      'opportunity': 'pending',
      'cannibalization': 'pending',
      'ctr-anomaly': 'pending',
      'change-point': 'pending',
    },
  }
}

export function useActionPriority(): ActionPriorityRunner {
  const progress = ref<ActionPriorityProgress>(initialProgress())
  const actions = ref<PriorityAction[]>([])
  const error = ref<Error | null>(null)
  const running = ref(false)

  async function run(runner: InsightRunner): Promise<void> {
    if (running.value)
      return
    running.value = true
    error.value = null
    actions.value = []
    progress.value = {
      ...initialProgress(),
      phase: 'running',
      message: `Running ${SOURCES.length} analyzers in parallel…`,
    }

    const updateSource = (source: ActionSource, status: 'running' | 'done' | 'skipped' | 'error'): void => {
      progress.value = {
        ...progress.value,
        sources: { ...progress.value.sources, [source]: status },
        completed: status === 'done' || status === 'skipped' || status === 'error'
          ? progress.value.completed + 1
          : progress.value.completed,
      }
    }

    // Kick all five off at once; each independently flips from running→done.
    const runOne = (source: ActionSource): Promise<PriorityAction[]> => {
      updateSource(source, 'running')
      return runner.analyze({ type: source })
        .then((result) => {
          const normalized = normalize(source, result)
          if (normalized.length === 0)
            updateSource(source, 'skipped')
          else
            updateSource(source, 'done')
          return normalized
        })
        .catch((err: Error) => {
          updateSource(source, 'error')
          // Don't fail the whole run because one analyzer errored — surface
          // it in progress and continue. Log for dev visibility.

          console.warn(`[useActionPriority] ${source} failed:`, err.message)
          return [] as PriorityAction[]
        })
    }

    let fatal: Error | null = null
    const all = await Promise.all(SOURCES.map(runOne))
      .then(results => results.flat())
      .catch((err: Error) => {
        fatal = err
        return [] as PriorityAction[]
      })

    if (fatal != null) {
      error.value = fatal
      progress.value = { ...progress.value, phase: 'error', message: (fatal as Error).message }
      running.value = false
      return
    }

    const merged = mergeActions(all)
    const ranked = scoreAndRank(merged)
    actions.value = ranked.slice(0, 40)
    progress.value = {
      ...progress.value,
      phase: 'done',
      message: `Ranked ${actions.value.length} actions from ${all.length} signals across ${SOURCES.length} analyzers.`,
    }
    running.value = false
  }

  return { progress, actions, error, running, run }
}
