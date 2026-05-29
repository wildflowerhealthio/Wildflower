import { createFileRoute, Link } from '@tanstack/react-router'
import type { JSX } from 'react'

function HomePage(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <h1>Home</h1>

      <Link to="/apps">
        <h2>Apps</h2>
      </Link>

      <Link to="/collector">
        <h2>Collector</h2>
      </Link>

      <Link to="/settings">
        <h2>Settings</h2>
      </Link>

      <Link to="/gatekeeper/devices">
        <h2>Device Auth</h2>
      </Link>
    </div>
  )
}

const Route = createFileRoute('/_auth')({ component: HomePage })

export { Route }
