import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { PageActionMessageBody, SnifferRequestId } from '../messages.ts'
import { AnySchema as WebViewSourceSchema } from '../web-view-source.ts'

/**
 * `POST /sniffer/webview` payload. `source` is the slice's `WebViewSource`
 * union (the same schema the retired bridge's `RequestSniffableWebView` /
 * `Open` messages carried, so the wire shape is unchanged). `linkedSpan` is
 * the caller's OpenTelemetry span context; the host accepts it on the wire
 * (a tracing host can adopt it without a client change) but doesn't act on it
 * today.
 */
const OpenWebviewPayloadSchema = Schema.Struct({
  source: WebViewSourceSchema,
  linkedSpan: Schema.optional(Schema.Struct({ traceId: Schema.String, spanId: Schema.String })),
})

const SetStatusPayloadSchema = Schema.Struct({
  name: Schema.String,
})

/** Reuses the `PageAction` message's inner `action` union (`Click` / `Fill`). */
const PageActionPayloadSchema = Schema.Struct({
  action: PageActionMessageBody.fields.action,
})

const CancelRequestPayloadSchema = Schema.Struct({
  id: SnifferRequestId,
})

/**
 * 400 when the submitted `source` is rejected (non-`http(s)://` or
 * unparseable URI, or the unsupported `Html` variant). Under the retired
 * bridge these were host-side warn-and-drops; the REST surface acknowledges
 * them.
 */
const InvalidSourceSchema = Schema.Struct({
  error: Schema.Literal('InvalidSource'),
  message: Schema.String,
})

/**
 * 403 on every endpoint when the caller authenticated but their token doesn't
 * cover the `wildflower/Sniffer.<perm>` scope the operation requires (`.c`
 * for the control plane; the `/sniffer/events` WebSocket needs `.r`). Matches
 * the shared Rust `InsufficientScopeBody`.
 */
const InsufficientScopeSchema = Schema.Struct({
  error: Schema.Literal('InsufficientScope'),
  missingScopes: Schema.Array(Schema.String),
})

/**
 * The `/sniffer` control plane. Every operation answers `204 No Content` —
 * the host effects are asynchronous by nature (results and lifecycle arrive
 * on the `/sniffer/events` WebSocket), so a success only acknowledges
 * dispatch, mirroring the fire-and-forget bridge semantics it replaces.
 */
const httpApiGroup = HttpApiGroup.make('sniffer', { topLevel: false })
  .add(
    HttpApiEndpoint.post('OpenSnifferWebview', '/webview')
      .setPayload(OpenWebviewPayloadSchema)
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InvalidSourceSchema, { status: 400 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.del('DisposeSnifferWebview', '/webview')
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.put('SetSnifferStatus', '/status')
      .setPayload(SetStatusPayloadSchema)
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.post('ShowSnifferWebview', '/visibility')
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.post('SendPageAction', '/page-actions')
      .setPayload(PageActionPayloadSchema)
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.post('CancelSnifferRequest', '/cancellations')
      .setPayload(CancelRequestPayloadSchema)
      .addSuccess(Schema.Void, { status: 204 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .prefix('/sniffer')

export {
  httpApiGroup,
  OpenWebviewPayloadSchema,
  SetStatusPayloadSchema,
  PageActionPayloadSchema,
  CancelRequestPayloadSchema,
  InvalidSourceSchema,
  InsufficientScopeSchema,
}
