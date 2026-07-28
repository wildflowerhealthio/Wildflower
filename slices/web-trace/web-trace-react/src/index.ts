/**
 * The browser UI adapter of the web-trace slice: the on-device viewer for
 * recorded browsing sessions.
 *
 * @remarks
 * Presentation and interaction only. The codec, the pseudonymizer, and the HAR
 * emitter all live in `web-trace-core`; nothing here reimplements any of them,
 * and nothing here redacts — the viewer shows raw captured values because it
 * runs on the user's own device against the user's own data. Redaction belongs
 * to the export flow, at the boundary where data leaves.
 *
 * @packageDocumentation
 */
export {
  AttachmentViewer,
  type AttachmentViewerProps,
  PREVIEW_CHARACTER_CAP,
} from './attachments/attachment-viewer.tsx'
export {
  type AttachmentAbsence,
  decodeText,
  formatJson,
  fromFhirAttachment,
  fromTraceBody,
  mediaTypeOf,
  type PreviewKind,
  previewKindFor,
  type ViewableAttachment,
} from './attachments/viewable-attachment.ts'
export { ExchangeDetail, type ExchangeDetailProps } from './exchanges/exchange-detail.tsx'
export { ExchangeList, type ExchangeListProps } from './exchanges/exchange-list.tsx'
export { ExchangeFiltersBar, type ExchangeFiltersBarProps } from './exchanges/exchange-filters.tsx'
export {
  ANY,
  contentTypeOptions,
  type ExchangeFilters,
  filterExchanges,
  NO_FILTERS,
  normalizeContentType,
  STATUS_CLASSES,
  type StatusClass,
  statusClassOf,
} from './exchanges/filter-exchanges.ts'
export {
  DEFAULT_PAGE_SIZE,
  nextPageToken,
  type PageLink,
  TRACE_EXCHANGES_QUERY_KEY,
  type TraceExchangePage,
  type TraceExchangesQueryOptions,
  traceExchangesInfiniteQueryOptions,
  useTraceExchangesQuery,
  WEB_TRACE_CATEGORY_TOKEN,
  WEB_TRACE_QUERY_KEY,
} from './queries/index.ts'
export { RecordingsPanel, type RecordingsPanelProps } from './recordings/recordings-panel.tsx'
export { groupIntoSessions, hostOf, type TraceSession } from './sessions/group-sessions.ts'
export { SessionsList, type SessionsListProps } from './sessions/sessions-list.tsx'
export { useTraceSessions, type TraceSessionsState } from './sessions/use-trace-sessions.ts'
