import { StatusBadge } from 'react-tundraish'

/** The full tone scale — neutral / info / success / warning / danger. */
export const Tones = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <StatusBadge tone="neutral">Draft</StatusBadge>
    <StatusBadge tone="info">Pending</StatusBadge>
    <StatusBadge tone="success">Approved</StatusBadge>
    <StatusBadge tone="warning">Expiring</StatusBadge>
    <StatusBadge tone="danger">Revoked</StatusBadge>
  </div>
)

/** `pulse` animates the leading dot — a liveliness cue for an active state. */
export const Live = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <StatusBadge tone="success" pulse>
      Online
    </StatusBadge>
    <StatusBadge tone="info" pulse>
      Connecting
    </StatusBadge>
  </div>
)

/** In context — a status sitting beside the record it describes. */
export const InRow = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 12px',
      border: '1px solid var(--color-divider)',
      borderRadius: 'var(--radius-2)',
      maxWidth: 360,
    }}
  >
    <span className="text-body-2">Demo FHIR Server</span>
    <StatusBadge tone="success" pulse>
      Connected
    </StatusBadge>
  </div>
)
