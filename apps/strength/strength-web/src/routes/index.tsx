import { createFileRoute, Link } from '@tanstack/react-router'
import { AppLanding } from '@wildflowerhealthio/branding-react'
import type { JSX } from 'react'

/**
 * The introduction, connected: `AppLanding`'s introduction of the app, the
 * one the standalone landing shows beside its connect menu, with the way
 * into the app in its place, the patient picker.
 */
function StrengthIntroduction(): JSX.Element {
  return (
    <AppLanding app="strength">
      <Link to="/patients" className="button-2 filled">
        Choose a patient
      </Link>
    </AppLanding>
  )
}

/**
 * `/`, the introduction. A completed launch never stays on it (the handshake
 * gate opens the launch's route, its patient or the picker), so it is what a
 * later visit to the app root inside the visit shows.
 */
const Route = createFileRoute('/')({
  component: StrengthIntroduction,
})

export { Route }
