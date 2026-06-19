import { AsyncErrorView } from 'react-tundraish'

/**
 * The canonical use — the error body a `<CatchBoundary errorComponent>`
 * renders when an awaited promise rejects. It delegates to `PageBodyError`,
 * so it's a fragment with no container; the preview supplies the page shell
 * and `h1` it expects to be slotted into.
 */
export const Rejected = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 8 }}>
    <h1 className="text-heading-2">Records</h1>
    <AsyncErrorView error={new Error('The server returned 503 Service Unavailable.')} />
  </div>
)

/** With a `title` sub-heading and a `retry` button to re-run the failed load. */
export const WithRetry = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 8 }}>
    <h1 className="text-heading-2">Connections</h1>
    <AsyncErrorView
      title="Couldn't reach the relay"
      error={new Error('Network request failed.')}
      retry={() => {}}
    />
  </div>
)
