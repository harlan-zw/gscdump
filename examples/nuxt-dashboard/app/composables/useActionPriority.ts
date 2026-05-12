import type {
  ActionPrioritySourceState,
  ActionSource,
  AnalysisParams,
  AnalysisResult,
  AnalysisTool,
  Effort,
  PriorityAction,
} from '@gscdump/analysis'

import {
  mergePriorityActions,
  normalizePriorityActions,
  scorePriorityActions,
} from '@gscdump/analysis'

interface AnalysisRunner {
  analyze: (params: AnalysisParams) => Promise<AnalysisResult>
}

interface ActionPriorityAnalyzer {
  analyze: (params: AnalysisParams) => Promise<AnalysisResult>
}

interface ActionPriorityResult {
  actions: PriorityAction[]
  totalSignals: number
}

async function analyzeActionPriority(
  analyzer: ActionPriorityAnalyzer,
  options: {
    sources: ActionSource[]
    limit?: number
    onSourceStatus?: (state: ActionPrioritySourceState) => void
  },
): Promise<ActionPriorityResult> {
  const { sources, limit = 40, onSourceStatus } = options
  const counts = new Map<ActionSource, number>()
  for (const source of sources) {
    counts.set(source, 0)
    onSourceStatus?.({ source, status: 'pending', count: 0 })
  }

  const runOne = (source: ActionSource): Promise<PriorityAction[]> => {
    onSourceStatus?.({ source, status: 'running', count: 0 })
    const params = { type: source as AnalysisTool } as AnalysisParams
    return analyzer.analyze(params).then((result) => {
      const normalized = normalizePriorityActions(source, result)
      onSourceStatus?.({
        source,
        status: normalized.length === 0 ? 'skipped' : 'done',
        count: normalized.length,
      })
      return normalized
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      onSourceStatus?.({ source, status: 'error', count: 0, error: message })
      return []
    })
  }

  const all = (await Promise.all(sources.map(runOne))).flat()
  const actions = scorePriorityActions(mergePriorityActions(all)).slice(0, limit)
  return { actions, totalSignals: all.length }
}

export type { ActionSource, Effort, PriorityAction }

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
  run: (runner: AnalysisRunner) => Promise<void>
}

function resolveSources(): ActionSource[] {
  return useGscAnalyzerDefsWithCapability('actionPriority')
    .map(d => d.capabilities.actionPriority)
}

function initialProgress(sources: ActionSource[]): ActionPriorityProgress {
  const seeded: Partial<Record<ActionSource, 'pending' | 'running' | 'done' | 'skipped' | 'error'>> = {}
  for (const s of sources) seeded[s] = 'pending'
  return {
    phase: 'idle',
    message: `Ready. Runs ${sources.length} analyzers in parallel then synthesizes a prioritized action list.`,
    completed: 0,
    total: sources.length,
    sources: seeded as ActionPriorityProgress['sources'],
  }
}

function applySourceState(
  progress: ActionPriorityProgress,
  next: ActionPrioritySourceState,
): ActionPriorityProgress {
  const current = progress.sources[next.source]
  const completedBefore = current === 'done' || current === 'skipped' || current === 'error'
  const completedAfter = next.status === 'done' || next.status === 'skipped' || next.status === 'error'
  return {
    ...progress,
    completed: progress.completed + (!completedBefore && completedAfter ? 1 : 0),
    sources: { ...progress.sources, [next.source]: next.status },
  }
}

export function useActionPriority(): ActionPriorityRunner {
  const sources = resolveSources()
  // `useState` so panel switches (mount/unmount under v-if) preserve the
  // long-running action priority result + phase across the user's session.
  const progress = useState<ActionPriorityProgress>('gscActionPriority:progress', () => initialProgress(sources))
  const actions = useState<PriorityAction[]>('gscActionPriority:actions', () => [])
  const error = useState<Error | null>('gscActionPriority:error', () => null)
  const running = useState<boolean>('gscActionPriority:running', () => false)

  async function run(runner: AnalysisRunner): Promise<void> {
    if (running.value)
      return

    running.value = true
    error.value = null
    actions.value = []
    progress.value = {
      ...initialProgress(sources),
      phase: 'running',
      message: `Running ${sources.length} analyzers in parallel...`,
    }

    const analyzer: ActionPriorityAnalyzer = {
      analyze: params => runner.analyze(params as AnalysisParams),
    }

    try {
      const result = await analyzeActionPriority(analyzer, {
        sources,
        onSourceStatus: (state) => {
          progress.value = applySourceState(progress.value, state)
        },
      })
      actions.value = result.actions
      progress.value = {
        ...progress.value,
        phase: 'done',
        message: `Ranked ${result.actions.length} actions from ${result.totalSignals} signals across ${sources.length} analyzers.`,
      }
    }
    catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      progress.value = {
        ...progress.value,
        phase: 'error',
        message: error.value.message,
      }
    }
    finally {
      running.value = false
    }
  }

  return { progress, actions, error, running, run }
}
