import { createFileRoute, useNavigate, useRouteContext } from '@tanstack/react-router'
import { Either } from 'effect'
import { useEffect, useRef, type JSX } from 'react'

import type { RouterContext } from '../../../router-context.ts'
import { launchApp, type LaunchContext } from './-launch.ts'

/**
 * Launches app `id` on arrival, then gets out of the way: the tab moves to the
 * app (a forwarded launch), or back to the home screen when the host opened it
 * natively or the launch failed (with the failure in `?launchError`).
 *
 * A home tile links here, so a tab the browser opens by itself (right-click →
 * "Open in new tab") still launches. Such a tab starts with no bearer, so the
 * `_auth` gate signs it in first and returns here.
 */
function LaunchScreen({
  id,
  launch,
  goHome,
}: {
  readonly id: string
  readonly launch: (id: string) => ReturnType<typeof launchApp>
  readonly goHome: (launchError: string | undefined) => void
}): JSX.Element {
  // Launch once: a re-render (or StrictMode's double effect) must not mint a
  // second launch.
  const launched = useRef(false)
  useEffect(() => {
    if (launched.current) return
    launched.current = true
    void launch(id).then((result) => {
      Either.match(result, {
        onLeft: (launchError) => goHome(launchError),
        onRight: (outcome) => {
          if (outcome === 'openedOnHost') goHome(undefined)
        },
      })
    })
  }, [id, launch, goHome])
  return <p className="text-body-2">Opening the app…</p>
}

function LaunchRoute(): JSX.Element {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const runAuthed = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runAuthed,
  })
  const ctx: LaunchContext = {
    runAuthed,
    // Replace, so Back from the app skips this transient page.
    navigate: (url) => {
      window.location.replace(url)
    },
  }
  return (
    <LaunchScreen
      id={id}
      launch={(appId) => launchApp(ctx, appId)}
      goHome={(launchError) => {
        void navigate({
          to: '/home',
          search: launchError === undefined ? {} : { launchError },
          replace: true,
        })
      }}
    />
  )
}

const Route = createFileRoute('/_auth/home/launch/$id')({
  component: LaunchRoute,
})

export { LaunchScreen, Route }
