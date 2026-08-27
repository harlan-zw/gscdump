export {
  classifyError,
  GscApiError,
  gscErrorToException,
  isPermissionDeniedError,
  parseGoogleError,
  rethrowAsGscApiError,
} from './core/errors'
export type { GscApiErrorInfo, GscError, GscErrorKind } from './core/errors'
