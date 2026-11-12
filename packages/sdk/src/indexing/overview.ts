// The Indexing overview: the one state a Site's indexing Overview shows.
//
// Ported from nuxtseo.com `layers/pro/gsc/app/utils/indexing-overview.ts`.
// request-indexing and gscdump.com hold drifted copies.
//
// The page renders exactly one tag: waiting, trust failure, verify scope,
// partial scope, or diagnosis. Each gate is a variant, so a page cannot paint a
// diagnosis over evidence it does not have.
//
// The diagnosis itself is an argument. nuxtseo.com and request-indexing compute
// it with `diagnoseIndexing`, which reads Crawl evidence when it has some. This
// module needs only its reason and its recommended action ids.

import type { GscdumpIndexingUrl } from '@gscdump/contracts'
import type { SearchConsoleStageIssue } from '../search-console-stage'
import type { TrustGate } from './trust-gate'
import { compareCurrentSitemapScope } from './trust-gate'

export type IndexingDiagnosisReason
  = | 'none'
    | 'crawl_blocked'
    | 'canonical_or_indexability_blocked'
    | 'unknown_to_google_discovery_gap'
    | 'discovered_not_crawled'
    | 'crawled_not_indexed_quality_selection'
    | 'not_indexed_unspecified'
    | 'mixed_indexing_failure'
    | 'data_incomplete'

export type IndexingDiagnosisActionId
  = | 'complete-indexing-data'
    | 'fix-crawl-access'
    | 'align-indexability-signals'
    | 'improve-discovery'
    | 'strengthen-crawl-priority'
    | 'improve-or-consolidate-content'
    | 'run-url-level-triage'

/** The part of a diagnosis the Indexing overview reads. */
export interface IndexingOverviewDiagnosis {
  reason: IndexingDiagnosisReason
  recommendedActions: ReadonlyArray<{ id: IndexingDiagnosisActionId }>
}

/** What the caller's diagnosis function receives. */
export interface IndexingDiagnoseInput<Row> {
  totalUrls: number
  indexed: number
  issues: SearchConsoleStageIssue[]
  sampleUrls?: Row[]
}

/** One inspected URL, as far as the Inspection stages are concerned. */
export type InspectionStageRow = Partial<Pick<GscdumpIndexingUrl, 'verdict' | 'indexingState' | 'robotsTxtState' | 'pageFetchState' | 'lastCrawlTime'>>

export interface InspectionStageSource {
  urls: ReadonlyArray<InspectionStageRow>
  pagination: { total: number, hasMore: boolean }
  inspectedCount: number
}

export interface AvailableInspectionStages {
  _tag: 'available'
  inspected: number
  crawled: number
  indexable: number
  indexed: number
}

export interface UnavailableInspectionStages {
  _tag: 'unavailable'
  reason: 'partial_rows' | 'scope_mismatch'
}

export type InspectionStageCounts = AvailableInspectionStages | UnavailableInspectionStages

export interface IndexingOverviewInput<Row = unknown> {
  totalUrls: number
  indexed: number
  issues: SearchConsoleStageIssue[]
  indexingStatus: 'pending' | 'partial' | 'complete' | null
  inspectedCount: number
  sitemapTotal: number
  /** Sitemap URL counts by day, in any order. */
  sitemapHistory: ReadonlyArray<{ date: string, urlCount: number }>
  sampleUrls?: Row[]
  stages: InspectionStageCounts
  trust: TrustGate
}

export interface IndexingOverviewCount {
  id: string
  value: number
  label: string
}

export interface IndexingOverviewReason {
  issueType: string
  label: string
  count: number
  countLabel: string
  severity: NonNullable<SearchConsoleStageIssue['severity']>
}

export type IndexingReasonGroupId
  = | 'crawl_fetch'
    | 'discovery'
    | 'indexability'
    | 'selection'
    | 'unknown'
    | 'other'

export interface IndexingOverviewReasonGroup {
  id: IndexingReasonGroupId
  label: string
  countLabel: string
  reasons: IndexingOverviewReason[]
}

export interface IndexingOverviewAction {
  engineActionId: IndexingDiagnosisActionId
  issueType: string | null
  label: string
  detail: string
  buttonLabel: string
}

export interface IndexingOverviewScope {
  inspected: number
  indexed: number
  indexedLabel: string
  sitemapTotal: number
  complete: boolean
}

export interface InspectionStageStep {
  id: 'inspected' | 'crawled' | 'indexable' | 'indexed'
  label: 'Inspected' | 'Crawled' | 'Indexable' | 'Indexed'
  value: number
  countLabel: string
}

export interface InspectionStageSteps {
  _tag: 'available'
  steps: [InspectionStageStep, InspectionStageStep, InspectionStageStep, InspectionStageStep]
  largestLoss: {
    from: InspectionStageStep['label']
    to: InspectionStageStep['label']
    count: number
  } | null
}

export interface IndexingOverviewWaiting {
  _tag: 'waiting'
  /** `not_connected` needs a connect action; `pending` needs patience. */
  state: 'not_connected' | 'pending'
  reason: string
  progress: { inspected: number, total: number } | null
}

export interface IndexingOverviewTrustFailure {
  _tag: 'trust_failure'
  reason: string
  state: 'unknown' | 'broken' | 'no_sitemap'
}

export interface IndexingOverviewVerifyScope {
  _tag: 'verify_scope'
  current: number
  highWater: number
  reason: string
}

export interface IndexingOverviewPartialScope {
  _tag: 'partial_scope'
  scope: IndexingOverviewScope
  reason: string
}

export interface IndexingOverviewDiagnosisState<Diagnosis extends IndexingOverviewDiagnosis = IndexingOverviewDiagnosis> {
  _tag: 'diagnosis'
  diagnosis: Diagnosis
  scope: IndexingOverviewScope
  counts: IndexingOverviewCount[]
  reasonGroups: IndexingOverviewReasonGroup[]
  stages: InspectionStageSteps | UnavailableInspectionStages
  primaryAction: IndexingOverviewAction | null
  trustNote: string | null
}

export type IndexingOverviewModel<Diagnosis extends IndexingOverviewDiagnosis = IndexingOverviewDiagnosis>
  = | IndexingOverviewWaiting
    | IndexingOverviewTrustFailure
    | IndexingOverviewVerifyScope
    | IndexingOverviewPartialScope
    | IndexingOverviewDiagnosisState<Diagnosis>

const hardCrawlIssueTypes: ReadonlySet<string> = new Set([
  'blocked_robots',
  'server_error',
  'access_denied',
  'access_forbidden',
  'blocked_4xx',
  'redirect_error',
  'crawl_error',
  'not_found',
  'soft_404',
])

const issueGroupByType: Readonly<Record<string, IndexingReasonGroupId>> = {
  blocked_robots: 'crawl_fetch',
  server_error: 'crawl_fetch',
  access_denied: 'crawl_fetch',
  access_forbidden: 'crawl_fetch',
  blocked_4xx: 'crawl_fetch',
  redirect_error: 'crawl_fetch',
  crawl_error: 'crawl_fetch',
  not_found: 'crawl_fetch',
  soft_404: 'crawl_fetch',
  discovered_not_indexed: 'discovery',
  canonical_mismatch: 'indexability',
  canonical_cross_domain: 'indexability',
  noindex: 'indexability',
  duplicate_no_canonical: 'indexability',
  crawled_not_indexed: 'selection',
  unknown_to_google: 'unknown',
}

const reasonGroupLabels = {
  crawl_fetch: 'Crawl or fetch faults',
  discovery: 'Discovered, not crawled',
  indexability: 'Canonical or indexability faults',
  selection: 'Crawled, not indexed',
  unknown: 'Unknown to Google',
  other: 'Other indexing reasons',
} satisfies Record<IndexingReasonGroupId, string>

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(Math.max(0, Math.round(value)))
}

function denominatorLabel(value: number, inspected: number): string {
  return `${formatNumber(value)} of ${formatNumber(inspected)} inspected`
}

/**
 * Count the Inspection stages from the inspected rows. Refuses a partial page:
 * stages drawn from 500 of 4,000 rows read as a 4,000-URL answer.
 */
export function countInspectionStages(input: InspectionStageSource): InspectionStageCounts {
  const inspected = Math.max(0, Math.round(input.inspectedCount))
  const total = Math.max(0, Math.round(input.pagination.total))
  if (input.pagination.hasMore || input.urls.length !== total)
    return { _tag: 'unavailable', reason: 'partial_rows' }
  if (total !== inspected)
    return { _tag: 'unavailable', reason: 'scope_mismatch' }

  let crawled = 0
  let indexable = 0
  let indexed = 0
  for (const row of input.urls) {
    const isIndexed = row.verdict === 'PASS'
    const isCrawled = isIndexed
      || Boolean(row.lastCrawlTime)
      || row.pageFetchState === 'SUCCESSFUL'
    const isIndexable = isIndexed
      || (
        isCrawled
        && row.pageFetchState === 'SUCCESSFUL'
        && row.indexingState === 'INDEXING_ALLOWED'
        && row.robotsTxtState !== 'DISALLOWED'
      )

    if (isCrawled)
      crawled++
    if (isIndexable)
      indexable++
    if (isIndexed)
      indexed++
  }

  return { _tag: 'available', inspected, crawled, indexable, indexed }
}

function inspectionStageSteps(stages: InspectionStageCounts, inspected: number): InspectionStageSteps | UnavailableInspectionStages {
  if (stages._tag === 'unavailable')
    return stages
  if (stages.inspected !== inspected)
    return { _tag: 'unavailable', reason: 'scope_mismatch' }

  const values = [
    stages.inspected,
    Math.min(stages.inspected, stages.crawled),
    Math.min(stages.crawled, stages.indexable),
    Math.min(stages.indexable, stages.indexed),
  ]
  const labels = ['Inspected', 'Crawled', 'Indexable', 'Indexed'] as const
  const ids = ['inspected', 'crawled', 'indexable', 'indexed'] as const
  const steps = values.map((value, index) => ({
    id: ids[index]!,
    label: labels[index]!,
    value,
    countLabel: denominatorLabel(value, inspected),
  })) as InspectionStageSteps['steps']

  let largestLoss: InspectionStageSteps['largestLoss'] = null
  for (let index = 1; index < steps.length; index++) {
    const previous = steps[index - 1]!
    const current = steps[index]!
    const count = previous.value - current.value
    if (count > 0 && (!largestLoss || count > largestLoss.count))
      largestLoss = { from: previous.label, to: current.label, count }
  }

  return { _tag: 'available', steps, largestLoss }
}

function issueTypeForAction(actionId: IndexingDiagnosisActionId, issues: readonly SearchConsoleStageIssue[]): string | null {
  if (actionId === 'fix-crawl-access') {
    return issues
      .filter(issue => hardCrawlIssueTypes.has(issue.type) && issue.count > 0)
      .sort((a, b) => b.count - a.count)
      .at(0)
      ?.type ?? null
  }

  const candidateTypes = (() => {
    switch (actionId) {
      case 'align-indexability-signals':
        return ['canonical_cross_domain', 'canonical_mismatch', 'noindex', 'duplicate_no_canonical']
      case 'improve-discovery':
        return ['unknown_to_google']
      case 'strengthen-crawl-priority':
        return ['discovered_not_indexed']
      case 'improve-or-consolidate-content':
      case 'run-url-level-triage':
        return ['crawled_not_indexed', 'not_indexed']
      case 'complete-indexing-data':
        return []
    }
  })()

  return candidateTypes
    .map(type => issues.find(issue => issue.type === type && issue.count > 0))
    .find(Boolean)
    ?.type ?? null
}

const actionIdsByReason = {
  none: [],
  crawl_blocked: ['fix-crawl-access'],
  canonical_or_indexability_blocked: ['align-indexability-signals'],
  unknown_to_google_discovery_gap: ['improve-discovery'],
  discovered_not_crawled: ['strengthen-crawl-priority'],
  crawled_not_indexed_quality_selection: ['improve-or-consolidate-content', 'run-url-level-triage'],
  not_indexed_unspecified: ['run-url-level-triage'],
  mixed_indexing_failure: ['run-url-level-triage'],
  data_incomplete: ['complete-indexing-data'],
} satisfies Record<IndexingDiagnosisReason, IndexingDiagnosisActionId[]>

function actionForDiagnosis<Action extends { id: IndexingDiagnosisActionId }>(diagnosis: { reason: IndexingDiagnosisReason, recommendedActions: ReadonlyArray<Action> }): Action | undefined {
  const alignedIds: readonly IndexingDiagnosisActionId[] = actionIdsByReason[diagnosis.reason]
  return diagnosis.recommendedActions.find(action => alignedIds.includes(action.id))
    ?? diagnosis.recommendedActions[0]
}

/** The recommended action that addresses one issue type, if the diagnosis has one. */
export function indexingActionForIssue<Action extends { id: IndexingDiagnosisActionId }>(
  diagnosis: { recommendedActions: ReadonlyArray<Action> },
  issueType: string,
): Action | undefined {
  const alignedIds: readonly IndexingDiagnosisActionId[] = (() => {
    if (hardCrawlIssueTypes.has(issueType))
      return ['fix-crawl-access']
    if (['noindex', 'canonical_mismatch', 'canonical_cross_domain', 'duplicate_no_canonical', 'alternate_canonical'].includes(issueType))
      return ['align-indexability-signals']
    if (issueType === 'unknown_to_google')
      return ['improve-discovery']
    if (issueType === 'discovered_not_indexed')
      return ['strengthen-crawl-priority']
    if (['crawled_not_indexed', 'not_indexed'].includes(issueType))
      return ['improve-or-consolidate-content', 'run-url-level-triage']
    return []
  })()

  return diagnosis.recommendedActions.find(action => alignedIds.includes(action.id))
}

const actionCopy = {
  'fix-crawl-access': {
    label: 'Fix crawl or fetch blockers',
    detail: 'Remove unintended robots blocks, response errors, authentication, or redirect failures.',
    buttonLabel: 'Review blocked URLs',
  },
  'align-indexability-signals': {
    label: 'Align indexability signals',
    detail: 'Remove unintended noindex directives and align canonicals, redirects, sitemap URLs, and internal links.',
    buttonLabel: 'Review conflicting URLs',
  },
  'improve-discovery': {
    label: 'Make these URLs discoverable',
    detail: 'Put canonical URLs in the sitemap and link to them from indexed pages.',
    buttonLabel: 'Review unknown URLs',
  },
  'strengthen-crawl-priority': {
    label: 'Strengthen crawl priority',
    detail: 'Reduce low-value URL inventory and link to important canonical pages from already-indexed pages.',
    buttonLabel: 'Review uncrawled URLs',
  },
  'improve-or-consolidate-content': {
    label: 'Improve or consolidate these pages',
    detail: 'Compare rendered content, duplicate intent, canonicals, and internal links before requesting indexing again.',
    buttonLabel: 'Review crawled URLs',
  },
  'run-url-level-triage': {
    label: 'Inspect crawled URLs before changing content',
    detail: 'Check fetch, robots, noindex, canonicals, rendered content, and duplication before changing pages in bulk.',
    buttonLabel: 'Review crawled URLs',
  },
  'complete-indexing-data': {
    label: 'Complete URL Inspection data',
    detail: 'Finish URL Inspection collection before assigning a cause.',
    buttonLabel: 'View inspected URLs',
  },
} satisfies Record<IndexingDiagnosisActionId, Pick<IndexingOverviewAction, 'label' | 'detail' | 'buttonLabel'>>

function groupReasons(
  issues: readonly SearchConsoleStageIssue[],
  inspected: number,
  primaryIssueType: string | null,
): IndexingOverviewReasonGroup[] {
  const groups = new Map<IndexingReasonGroupId, IndexingOverviewReason[]>()
  for (const issue of issues) {
    if (issue.count <= 0 || issue.type === 'not_indexed')
      continue
    const groupId = issueGroupByType[issue.type]
    if (!groupId)
      continue
    const group = groups.get(groupId) ?? []
    group.push({
      issueType: issue.type,
      label: issue.label,
      count: issue.count,
      countLabel: denominatorLabel(issue.count, inspected),
      severity: issue.severity ?? 'info',
    })
    groups.set(groupId, group)
  }

  const primaryGroup = primaryIssueType
    ? issueGroupByType[primaryIssueType] ?? 'other'
    : null
  return Array.from(groups.entries(), ([id, reasons]) => ({
    id,
    label: reasonGroupLabels[id],
    countLabel: denominatorLabel(reasons.reduce((total, reason) => total + reason.count, 0), inspected),
    reasons: reasons
      .sort((left, right) =>
        Number(right.issueType === primaryIssueType) - Number(left.issueType === primaryIssueType)
        || right.count - left.count,
      )
      .slice(0, 3),
  }))
    .sort((left, right) =>
      Number(right.id === primaryGroup) - Number(left.id === primaryGroup)
      || Math.max(...right.reasons.map(reason => reason.count)) - Math.max(...left.reasons.map(reason => reason.count)),
    )
    .slice(0, 3)
}

/**
 * The Indexing overview for one Site. `diagnose` is called only once the Trust
 * gate and the sitemap scope allow a diagnosis.
 */
export function buildIndexingOverviewModel<Row, Diagnosis extends IndexingOverviewDiagnosis>(
  input: IndexingOverviewInput<Row>,
  diagnose: (input: IndexingDiagnoseInput<Row>) => Diagnosis,
): IndexingOverviewModel<Diagnosis> {
  if (input.trust.state === 'not_connected' || input.trust.state === 'pending') {
    return {
      _tag: 'waiting',
      state: input.trust.state,
      reason: input.trust.reason,
      progress: input.sitemapTotal > 0
        ? { inspected: Math.max(0, input.inspectedCount), total: Math.max(0, input.sitemapTotal) }
        : null,
    }
  }

  if (input.trust.state === 'unknown' || input.trust.state === 'broken' || input.trust.state === 'no_sitemap')
    return { _tag: 'trust_failure', state: input.trust.state, reason: input.trust.reason }

  const sitemapScope = compareCurrentSitemapScope(input.sitemapHistory)
  if (sitemapScope?.collapsed) {
    return {
      _tag: 'verify_scope',
      current: sitemapScope.current,
      highWater: sitemapScope.highWater,
      reason: `Today's sitemap scope is ${formatNumber(sitemapScope.current)} URLs, down from a recent high of ${formatNumber(sitemapScope.highWater)}.`,
    }
  }

  const inspected = Math.max(0, input.inspectedCount || input.totalUrls)
  const complete = input.indexingStatus === 'complete'
    && (input.sitemapTotal <= 0 || inspected >= input.sitemapTotal)
  const scope: IndexingOverviewScope = {
    inspected,
    indexed: Math.max(0, input.indexed),
    indexedLabel: denominatorLabel(input.indexed, inspected),
    sitemapTotal: Math.max(0, input.sitemapTotal),
    complete,
  }
  const diagnosis = diagnose({
    totalUrls: input.totalUrls,
    indexed: input.indexed,
    issues: input.issues,
    sampleUrls: input.sampleUrls,
  })

  if (diagnosis.reason === 'none' && !complete) {
    return {
      _tag: 'partial_scope',
      scope,
      reason: `${formatNumber(inspected)} of ${formatNumber(input.sitemapTotal)} sitemap URLs are inspected. Keep collecting evidence before calling coverage complete.`,
    }
  }

  const action = actionForDiagnosis(diagnosis)
  const primaryAction: IndexingOverviewAction | null = action
    ? { engineActionId: action.id, issueType: issueTypeForAction(action.id, input.issues), ...actionCopy[action.id] }
    : null
  const reasonGroups = groupReasons(input.issues, inspected, primaryAction?.issueType ?? null)
  const notIndexed = Math.max(0, input.totalUrls - input.indexed)

  return {
    _tag: 'diagnosis',
    diagnosis,
    scope,
    counts: [
      { id: 'indexed', value: input.indexed, label: denominatorLabel(input.indexed, inspected) },
      { id: 'not-indexed', value: notIndexed, label: denominatorLabel(notIndexed, inspected) },
      ...reasonGroups.flatMap(group => group.reasons).map(reason => ({
        id: reason.issueType,
        value: reason.count,
        label: reason.countLabel,
      })),
    ],
    reasonGroups,
    stages: inspectionStageSteps(input.stages, inspected),
    primaryAction,
    trustNote: input.trust.state === 'blip' ? input.trust.reason : null,
  }
}
