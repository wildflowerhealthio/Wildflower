import { PageLoading } from 'react-tundraish'

/** The default Suspense-fallback body — the standard "Loading…" line. */
export const Default = () => (
  <div style={{ maxWidth: 360 }}>
    <PageLoading />
  </div>
)

/** A custom message for a specific wait. */
export const CustomMessage = () => (
  <div style={{ maxWidth: 360 }}>
    <PageLoading message="Connecting to the relay…" />
  </div>
)
