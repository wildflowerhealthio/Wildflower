import { ErrorBanner } from 'react-tundraish'

/**
 * In context (databases-view): a failed mutation's message, inline under the
 * section heading while the list below stays usable. Composed with its heading
 * because a bare banner's text starts with its ⚠ icon, which the preview
 * harness reads as a crashed cell.
 */
export const Message = () => (
  <section style={{ maxWidth: 480, display: 'grid', gap: 12 }}>
    <h2 className="text-heading-5" style={{ margin: 0 }}>
      Databases
    </h2>
    <ErrorBanner error={new Error('Could not delete "Demo FHIR Server": the database is in use.')} />
  </section>
)

/**
 * An error with an underlying `cause` — the banner's collapsible
 * "Show details" carries the wrapped failure.
 */
export const WithDetails = () => (
  <section style={{ maxWidth: 480, display: 'grid', gap: 12 }}>
    <h2 className="text-heading-5" style={{ margin: 0 }}>
      Tunnel
    </h2>
    <ErrorBanner
      error={
        new Error('Failed to start the tunnel.', {
          cause: new Error('relay.wildflower.health:443 — connection refused'),
        })
      }
    />
  </section>
)
