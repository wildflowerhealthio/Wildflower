import { Notice } from '@wildflowerhealthio/react-tundraish'

/**
 * Composed with a heading because a bare notice's text starts with its
 * glyph, and the preview harness reads a cell starting with ⚠ as crashed.
 */

/** A failed step, with the way back as its action. */
export const DangerWithAction = () => (
  <section style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
    <h2 className="text-heading-5" style={{ margin: 0 }}>
      Import
    </h2>
    <Notice tone="danger" action={{ label: 'Choose other files', onClick: () => {} }}>
      These files could not be planned against the existing records. Nothing was imported.
    </Notice>
  </section>
)

/** A refused write, its distinct issues listed under the message. */
export const DangerWithDetails = () => (
  <section style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
    <h2 className="text-heading-5" style={{ margin: 0 }}>
      Import
    </h2>
    <Notice
      tone="danger"
      details={
        <ul style={{ margin: 0, paddingLeft: 24 }}>
          <li>Transaction failed at entry 0</li>
        </ul>
      }
    >
      No records were written. The import plan is kept.
    </Notice>
  </section>
)

/** A finished step, with what comes next as its action. */
export const SuccessWithAction = () => (
  <section style={{ maxWidth: 520, display: 'grid', gap: 12 }}>
    <h2 className="text-heading-5" style={{ margin: 0 }}>
      Import complete
    </h2>
    <Notice tone="success" action={{ label: 'Import more files', onClick: () => {} }}>
      47 new, 2 updated, 65 linked.
    </Notice>
  </section>
)
