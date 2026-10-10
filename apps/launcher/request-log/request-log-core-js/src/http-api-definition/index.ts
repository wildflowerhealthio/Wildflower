import { HttpApi } from '@effect/platform'
import * as RequestLog from './request-log.ts'

/**
 * The request log's surface — its caller summaries and pages. The host gates
 * this surface: in the Tauri app the Rust server serves `/requests` behind the
 * gatekeeper bearer gate, then authorizes it by `wildflower/RequestLog.r` (a
 * `403 InsufficientScope` otherwise). Slice cores stay free of auth deps.
 */
const RequestLogApi = HttpApi.make('RequestLogApi').add(RequestLog.httpApiGroup)

export { RequestLog, RequestLogApi }
