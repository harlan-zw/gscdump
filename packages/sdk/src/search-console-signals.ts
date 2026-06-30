export interface SearchConsoleIssueLike {
  type: string
  count: number
}

export function formatSearchConsoleCount(value: number): string {
  return new Intl.NumberFormat('en').format(Math.max(0, Math.round(value)))
}

export function countSearchConsoleIssues(
  issues: readonly SearchConsoleIssueLike[] | null | undefined,
  ...types: string[]
): number {
  if (!issues?.length)
    return 0
  const wanted = new Set(types)
  return issues.reduce((sum, issue) => sum + (wanted.has(issue.type) ? issue.count : 0), 0)
}
