import { StatusBadge } from 'react-tundraish'

/** The five tones, the way status surfaces use them. `neutral` is the default. */
export const Tones = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    <StatusBadge>DRAFT</StatusBadge>
    <StatusBadge tone="info">PENDING</StatusBadge>
    <StatusBadge tone="success">APPROVED</StatusBadge>
    <StatusBadge tone="warning">EXPIRING</StatusBadge>
    <StatusBadge tone="danger">REVOKED</StatusBadge>
  </div>
)

/** A single badge as it sits beside a record title (gatekeeper request screen). */
export const InlineWithTitle = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span className="text-heading-5">Request</span>
    <StatusBadge tone="success">APPROVED</StatusBadge>
  </div>
)

/** The connection toggle's live status line (tunnel TunnelToggle). */
export const ConnectionStatus = () => (
  <div style={{ display: 'grid', gap: 8, maxWidth: 280 }}>
    <StatusBadge tone="success">Connected</StatusBadge>
    <StatusBadge tone="warning">Connecting…</StatusBadge>
    <StatusBadge tone="danger">Disconnected</StatusBadge>
  </div>
)
