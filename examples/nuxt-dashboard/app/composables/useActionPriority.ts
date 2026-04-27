import type {
  ActionPriorityAnalyzer,
  ActionPrioritySourceState,
  ActionSource,
  AnalysisParams,
  AnalysisResult,
  Effort,
  PriorityAction,
} from '@gscdump/analysis'

import { analyzeActionPriority } from '@gscdump/analysis'

interface AnalysisRunner {
  analyze: (params: AnalysisParams) => Promise<AnalysisResult>
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

const SOURCES: ActionSource[] = [
  'striking-distance',
  'opportunity',
  'cannibalization',
  'ctr-anomaly',
  'change-point',
]

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
  const progress = ref<ActionPriorityProgress>(initialProgress())
  const actions = ref<PriorityAction[]>([])
  const error = ref<Error | null>(null)
  const running = ref(false)

  async function run(runner: AnalysisRunner): Promise<void> {
    if (running.value)
      return

    running.value = true
    error.value = null
    actions.value = []
    progress.value = {
      ...initialProgress(),
      phase: 'running',
      message: `Running ${SOURCES.length} analyzers in parallel...`,
    }

    const analyzer: ActionPriorityAnalyzer = {
      analyze: params => runner.analyze(params as AnalysisParams),
    }

    try {
      const result = await analyzeActionPriority(analyzer, {
        sources: SOURCES,
        onSourceStatus: (state) => {
          progress.value = applySourceState(progress.value, state)
        },
      })
      actions.value = result.actions
      progress.value = {
        ...progress.value,
        phase: 'done',
        message: `Ranked ${result.actions.length} actions from ${result.totalSignals} signals across ${SOURCES.length} analyzers.`,
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
