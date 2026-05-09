export interface ScheduleState {
  nextAt: number
  consecutiveUnchanged: number
  policyVersion: number
}

export interface SchedulePolicy {
  readonly version: number
  initial: (now: number) => ScheduleState
  observe: (prev: ScheduleState, evt: { changed: boolean, at: number }) => ScheduleState
  isDue: (state: ScheduleState, now: number) => boolean
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function isDue(state: ScheduleState, now: number): boolean {
  return now >= state.nextAt
}

function sitemapCadenceMs(consecutiveUnchanged: number): number {
  if (consecutiveUnchanged >= 7)
    return 30 * DAY
  if (consecutiveUnchanged >= 3)
    return 7 * DAY
  return DAY
}

const SITEMAP_VERSION = 1

export const sitemapPolicy: SchedulePolicy = {
  version: SITEMAP_VERSION,
  initial(now) {
    return {
      nextAt: now + DAY,
      consecutiveUnchanged: 0,
      policyVersion: SITEMAP_VERSION,
    }
  },
  observe(prev, evt) {
    if (prev.policyVersion !== SITEMAP_VERSION) {
      return {
        nextAt: evt.at + sitemapCadenceMs(0),
        consecutiveUnchanged: 0,
        policyVersion: SITEMAP_VERSION,
      }
    }
    if (evt.changed) {
      return {
        nextAt: evt.at + DAY,
        consecutiveUnchanged: 0,
        policyVersion: SITEMAP_VERSION,
      }
    }
    const next = prev.consecutiveUnchanged + 1
    return {
      nextAt: evt.at + sitemapCadenceMs(next),
      consecutiveUnchanged: next,
      policyVersion: SITEMAP_VERSION,
    }
  },
  isDue,
}

const INSPECTION_VERSION = 1

export type InspectionVerdict = 'PASS' | 'FAIL' | 'NEUTRAL'

function inspectionCadenceMs(verdict: InspectionVerdict): number {
  if (verdict === 'PASS')
    return 30 * DAY
  if (verdict === 'FAIL')
    return 7 * DAY
  return 14 * DAY
}

export function inspectionPolicy(verdict: InspectionVerdict): SchedulePolicy {
  const cadence = inspectionCadenceMs(verdict)
  return {
    version: INSPECTION_VERSION,
    initial(now) {
      return {
        nextAt: now + cadence,
        consecutiveUnchanged: 0,
        policyVersion: INSPECTION_VERSION,
      }
    },
    observe(prev, evt) {
      if (prev.policyVersion !== INSPECTION_VERSION) {
        return {
          nextAt: evt.at + cadence,
          consecutiveUnchanged: 0,
          policyVersion: INSPECTION_VERSION,
        }
      }
      const next = evt.changed ? 0 : prev.consecutiveUnchanged + 1
      return {
        nextAt: evt.at + cadence,
        consecutiveUnchanged: next,
        policyVersion: INSPECTION_VERSION,
      }
    },
    isDue,
  }
}

const FIXED_VERSION = 1

export function fixedPolicy(intervalMs: number): SchedulePolicy {
  return {
    version: FIXED_VERSION,
    initial(now) {
      return {
        nextAt: now + intervalMs,
        consecutiveUnchanged: 0,
        policyVersion: FIXED_VERSION,
      }
    },
    observe(prev, evt) {
      if (prev.policyVersion !== FIXED_VERSION) {
        return {
          nextAt: evt.at + intervalMs,
          consecutiveUnchanged: 0,
          policyVersion: FIXED_VERSION,
        }
      }
      const next = evt.changed ? 0 : prev.consecutiveUnchanged + 1
      return {
        nextAt: evt.at + intervalMs,
        consecutiveUnchanged: next,
        policyVersion: FIXED_VERSION,
      }
    },
    isDue,
  }
}
