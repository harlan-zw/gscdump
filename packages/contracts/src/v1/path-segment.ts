export function serializeHttpV1PathSegment(operationId: string, name: string, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError(`${operationId}: path parameter ${name} must serialize as a string or number`)
  const serialized = String(value)
  if (serialized.length === 0 || serialized === '.' || serialized === '..')
    throw new TypeError(`${operationId}: path parameter ${name} cannot serialize as an empty or dot segment`)
  return encodeURIComponent(serialized)
}
