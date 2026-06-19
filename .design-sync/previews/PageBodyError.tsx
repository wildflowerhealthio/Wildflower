import { PageBodyError } from 'react-tundraish'

/**
 * The canonical use — a single-line error message rendered inside a page
 * shell. `PageBodyError` is an error *body* (a fragment, no container of its
 * own), so the preview supplies the surrounding shell + page `h1` it expects.
 */
export const WithMessage = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 8 }}>
    <h1 className="text-heading-2">Account</h1>
    <PageBodyError error={new Error('That FHIR endpoint refused the connection.')} />
  </div>
)

/** With a `title` sub-heading and a `retry` affordance. */
export const TitledWithRetry = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 8 }}>
    <h1 className="text-heading-2">Import</h1>
    <PageBodyError
      title="Couldn't load records"
      error={new Error('Request timed out after 30s.')}
      retry={() => {}}
    />
  </div>
)

/** Multi-line messages (e.g. a schema parse tree) keep their structure in a monospace block. */
export const MultiLine = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 8 }}>
    <h1 className="text-heading-2">Configuration</h1>
    <PageBodyError
      error={
        new Error(
          'Invalid relay config:\n  └─ host: expected a hostname, received ""\n  └─ port: expected 1–65535, received 0',
        )
      }
    />
  </div>
)
