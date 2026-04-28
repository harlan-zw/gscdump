import type { AnalysisParams, AnalysisResult, AnalysisTool } from '@gscdump/engine/analysis-types'
import type { AnalyzerRegistry } from '@gscdump/engine/analyzer'
import type { AnalysisQuerySource } from '@gscdump/engine/resolver'
import { clamp, clamp01 } from './scoring'
import { analyzeFromSource } from './source/analyze-from-source'

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

export type ActionPrioritySourceStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

export interface ActionPrioritySourceState {
  source: ActionSource
  status: ActionPrioritySourceStatus
  count: number
  error?: string
}

export interface ActionPriorityResult {
  actions: PriorityAction[]
  totalSignals: number
  sources: ActionPrioritySourceState[]
}

export interface ActionPriorityRunOptions {
  sources?: ActionSource[]
  limit?: number
  continueOnError?: boolean
  paramsBySource?: Partial<Record<ActionSource, Omit<AnalysisParams, 'type'>>>
  onSourceStatus?: (state: ActionPrioritySourceState) => void
}

export interface ActionPriorityAnalyzer {
  analyze: (params: AnalysisParams) => Promise<AnalysisResult>
}

const DEFAULT_SOURCES: ActionSource[] = [
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

const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 }

function idKey(keyword: string, page: string): string {
  return `${keyword.toLowerCase()}|${page.toLowerCase()}`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}...`
}

interface ActionSpec<S extends ActionSource> {
  source: S
  keyword: string
  page: string
  title: string
  why: string
  severity: number
  impressions: number
  impact: number
  data: unknown
}

function buildAction<S extends ActionSource>(spec: ActionSpec<S>): PriorityAction {
  return {
    id: idKey(spec.keyword, spec.page),
    title: spec.title,
    keyword: spec.keyword,
    page: spec.page,
    sources: [spec.source],
    severity: spec.severity,
    impressions: spec.impressions,
    impact: spec.impact,
    effort: EFFORT_BY_SOURCE[spec.source],
    why: spec.why,
    priorityScore: 0,
    data: { [spec.source]: spec.data as Record<string, unknown> } as PriorityAction['data'],
  }
}

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
    const posScore = clamp01((20 - r.position) / 16)
    const imprScore = Math.min(1, r.impressions / 5000)
    out.push(buildAction({
      source: 'striking-distance',
      keyword: r.keyword,
      page: r.page,
      title: `Push "${truncate(r.keyword, 40)}" onto page 1`,
      why: `Ranks #${r.position.toFixed(1)} with ${Math.round(r.impressions)} impressions; small gains unlock page-1 clicks.`,
      severity: Math.round(100 * Math.sqrt(posScore * imprScore)),
      impressions: r.impressions,
      impact,
      data: r,
    }))
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
    out.push(buildAction({
      source: 'opportunity',
      keyword: r.keyword,
      page: r.page,
      title: `Improve on-page for "${truncate(r.keyword, 40)}"`,
      why: `Opportunity score ${Math.round(r.opportunityScore)}; CTR ${(r.ctr * 100).toFixed(1)}% vs expected at pos ${r.position.toFixed(1)}.`,
      severity: Math.round(r.opportunityScore),
      impressions: r.impressions,
      impact,
      data: r,
    }))
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
    out.push(buildAction({
      source: 'cannibalization',
      keyword: ev.keyword,
      page: ev.leaderUrl,
      title: `Consolidate cannibalization on "${truncate(ev.keyword, 36)}"`,
      why: `${ev.competitorCount} URLs split ${Math.round(ev.totalImpressions)} impressions; leader loses ~${Math.round(ev.stolenClicks)} clicks to siblings.`,
      severity: Math.round(ev.severity),
      impressions: ev.totalImpressions,
      impact: Math.max(0, ev.stolenClicks),
      data: ev,
    }))
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
  let maxRaw = 0
  for (const r of rows) {
    if (r.severity > maxRaw)
      maxRaw = r.severity
  }
  for (const r of rows) {
    const impact = Math.max(0, r.clicksLost)
    if (impact <= 0)
      continue
    out.push(buildAction({
      source: 'ctr-anomaly',
      keyword: r.keyword,
      page: r.page,
      title: `Lift CTR on "${truncate(r.keyword, 36)}"`,
      why: `CTR collapsed ${r.breachDaysDown} days at flat position; ~${Math.round(r.clicksLost)} clicks lost vs baseline ${(r.baselineCtr * 100).toFixed(1)}%.`,
      severity: maxRaw > 0 ? Math.round((r.severity / maxRaw) * 100) : 0,
      impressions: r.totalImpressions,
      impact,
      data: r,
    }))
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
    const days = Math.max(1, r.totalDays / 2)
    const drift = Math.abs(r.leftMean - r.rightMean)
    const impact = drift * days
    if (impact <= 0)
      continue
    out.push(buildAction({
      source: 'change-point',
      keyword: r.keyword,
      page: r.page,
      title: `Diagnose drop on "${truncate(r.keyword, 34)}"`,
      why: `Significant regression around ${r.changeDate} (${r.leftMean.toFixed(1)} -> ${r.rightMean.toFixed(1)}, LLR ${r.llr.toFixed(0)}).`,
      severity: clamp(Math.round((Math.log10(Math.max(10, r.llr)) / 3) * 100), 0, 100),
      impressions: r.totalImpressions,
      impact,
      data: r,
    }))
  }
  return out
}

export function normalizePriorityActions(
  source: ActionSource,
  result: AnalysisResult,
): PriorityAction[] {
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

export function mergePriorityActions(all: PriorityAction[]): PriorityAction[] {
  const byId = new Map<string, PriorityAction>()
  for (const a of all) {
    const existing = byId.get(a.id)
    if (existing == null) {
      byId.set(a.id, { ...a, sources: [...a.sources], data: { ...a.data } })
      continue
    }

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

export function scorePriorityActions(actions: PriorityAction[]): PriorityAction[] {
  for (const a of actions) {
    const mult = EFFORT_MULTIPLIER[a.effort]
    a.priorityScore = a.impact * (1 + a.severity / 100) * mult
  }
  actions.sort((a, b) => b.priorityScore - a.priorityScore)
  return actions
}

export async function analyzeActionPriority(
  analyzer: ActionPriorityAnalyzer,
  options: ActionPriorityRunOptions = {},
): Promise<ActionPriorityResult> {
  const {
    sources = DEFAULT_SOURCES,
    limit = 40,
    continueOnError = true,
    paramsBySource = {},
    onSourceStatus,
  } = options

  const states = new Map<ActionSource, ActionPrioritySourceState>()
  for (const source of sources) {
    const state: ActionPrioritySourceState = { source, status: 'pending', count: 0 }
    states.set(source, state)
    onSourceStatus?.(state)
  }

  const update = (source: ActionSource, patch: Partial<ActionPrioritySourceState>): void => {
    const next = { ...(states.get(source) ?? { source, status: 'pending', count: 0 }), ...patch }
    states.set(source, next)
    onSourceStatus?.(next)
  }

  const runOne = async (source: ActionSource): Promise<PriorityAction[]> => {
    update(source, { status: 'running', error: undefined })
    const params = { type: source as AnalysisTool, ...(paramsBySource[source] ?? {}) } as AnalysisParams
    return analyzer.analyze(params).then((result) => {
      const normalized = normalizePriorityActions(source, result)
      update(source, {
        status: normalized.length === 0 ? 'skipped' : 'done',
        count: normalized.length,
      })
      return normalized
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      update(source, { status: 'error', count: 0, error: message })
      if (!continueOnError)
        throw error
      return []
    })
  }

  const all = (await Promise.all(sources.map(runOne))).flat()
  const actions = scorePriorityActions(mergePriorityActions(all)).slice(0, limit)

  return {
    actions,
    totalSignals: all.length,
    sources: sources.map(source => states.get(source) ?? { source, status: 'pending', count: 0 }),
  }
}

/**
 * Convenience wrapper: build the analyzer callback from an
 * {@link AnalysisQuerySource} so consumers don't hand-roll the adapter.
 * SQL-only tools (e.g. `cannibalization`, `ctr-anomaly`, `change-point`) will
 * surface as `status: 'error'` on their source state when the source lacks a
 * row-based implementation — `continueOnError` defaults to true, so the
 * overall run still produces whatever the other analyzers found.
 */
export async function analyzeActionPriorityFromSource(
  source: AnalysisQuerySource,
  registry: AnalyzerRegistry,
  options: ActionPriorityRunOptions = {},
): Promise<ActionPriorityResult> {
  return analyzeActionPriority(
    { analyze: (params: AnalysisParams) => analyzeFromSource(source, params, registry) },
    options,
  )
}
