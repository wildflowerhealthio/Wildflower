import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { normalizeServerUrl, searchWithServerUrl } from 'gatekeeper-core/smart-client'
import { buildDeviceLoginTarget } from 'gatekeeper-react'
import { type JSX, type SubmitEvent, useState } from 'react'
import { isAuthed, useSubscribable, useAuthStateSubscribable } from 'react-kitchen-sink'
import { TextField, pageLayoutStyles } from 'react-tundraish'

import type { RouterContext } from '../router-context.ts'

const WILDFLOWER_DOMAIN = '.wildflowerhealth.io'
const LOCAL_SERVER_URL = 'http://127.0.0.1:8080'

const connectToServer = (serverUrl: string): void => {
  const normalized = normalizeServerUrl(serverUrl)
  if (normalized === undefined) return
  const search = searchWithServerUrl(window.location.search, normalized)
  window.location.assign(`/${search}`)
}

/**
 * Root index. Behavior varies by entry:
 *
 * - **Hosted + unauthed**: renders the server picker landing page.
 * - **Hosted + authed**: redirects to `/home`.
 * - **Non-hosted**: redirects to `/home` unconditionally (the `_auth`
 *   gate handles the auth check for those entries).
 */
const Route = createFileRoute('/')({
  beforeLoad: ({ context }: { readonly context: RouterContext }): void => {
    if (context.entry !== 'main-hosted') {
      throw redirect({ to: '/home' })
    }
  },
  component: HostedLanding,
})

function HostedLanding(): JSX.Element {
  const navigate = useNavigate()
  const authSignal = useSubscribable(useAuthStateSubscribable())
  const [subdomain, setSubdomain] = useState('')
  const [freeText, setFreeText] = useState('')

  if (isAuthed(authSignal)) {
    void navigate({ to: '/home' })
    return <></>
  }

  const startSignInWithCurrentServer = (): void => {
    void navigate(buildDeviceLoginTarget('/home'))
  }

  const handleLocal = (): void => {
    connectToServer(LOCAL_SERVER_URL)
  }

  const handleSubdomain = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = subdomain.trim()
    if (trimmed === '') return
    connectToServer(`https://${trimmed}${WILDFLOWER_DOMAIN}`)
  }

  const handleFreeText = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const trimmed = freeText.trim()
    if (trimmed === '') return
    connectToServer(trimmed)
  }

  const hasServerInUrl = new URLSearchParams(window.location.search).has('server')

  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-6">Wildflower</h1>
      <p className="text-body-2">
        Connect to a Wildflower server to manage devices, apps, and health data.
      </p>

      <section>
        <h2 className="text-heading-7">Connect to a server</h2>

        <div style={{ display: 'grid', gap: 'var(--space-7)', marginTop: 'var(--space-7)' }}>
          <button type="button" className="button-2 filled" onClick={handleLocal}>
            Local server (127.0.0.1:8080)
          </button>

          <form
            onSubmit={handleSubdomain}
            style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'end' }}
          >
            <TextField
              label="Subdomain"
              value={subdomain}
              onChange={setSubdomain}
              placeholder="my-server"
            />
            <span className="text-body-3">{WILDFLOWER_DOMAIN}</span>
            <button type="submit" className="button-3 outlined">
              Connect
            </button>
          </form>

          <form
            onSubmit={handleFreeText}
            style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'end' }}
          >
            <TextField
              label="Custom server URL"
              value={freeText}
              onChange={setFreeText}
              placeholder="https://my-server.example.com"
            />
            <button type="submit" className="button-3 outlined">
              Connect
            </button>
          </form>
        </div>

        {hasServerInUrl ? (
          <div style={{ marginTop: 'var(--space-9)' }}>
            <button
              type="button"
              className="button-2 filled"
              onClick={startSignInWithCurrentServer}
            >
              Sign in to connected server
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

export { Route }
