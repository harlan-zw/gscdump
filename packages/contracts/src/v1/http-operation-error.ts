export interface UnknownHttpV1OperationError extends TypeError {
  readonly tag: 'UnknownHttpV1OperationError'
  readonly operationId: string
}

export function isUnknownHttpV1OperationError(error: unknown): error is UnknownHttpV1OperationError {
  return error instanceof TypeError
    && 'tag' in error
    && error.tag === 'UnknownHttpV1OperationError'
    && 'operationId' in error
    && typeof error.operationId === 'string'
}

export function unknownHttpV1OperationError(operationId: string): UnknownHttpV1OperationError {
  return Object.assign(new TypeError(`Unknown HTTP v1 operation ID: ${operationId}`), {
    name: 'UnknownHttpV1OperationError',
    operationId,
    tag: 'UnknownHttpV1OperationError' as const,
  })
}
