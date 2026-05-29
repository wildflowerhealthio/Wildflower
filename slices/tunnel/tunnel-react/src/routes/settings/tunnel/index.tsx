import { createFileRoute } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import {
  tunnelStateQueryOptions,
  useTunnelPatchMutation,
  useTunnelStateQuery,
  type RunAuthed,
  type TunnelState,
} from '../../../queries.ts'
import type { TunnelRouterContext } from '../../../router-context.ts'
import styles from './index.module.css'

/**
 * Read the authed runner off this route's context. `select` is annotated
 * with the structural {@link TunnelRouterContext} so the result is a
 * typed {@link RunAuthed} — NOT `any`. (In the slice's standalone build
 * there is no registered `Router`, so an un-`select`ed
 * `Route.useRouteContext()` widens to `any`; the annotated `select`
 * keeps it honest without an unsafe cast. The app build, which DOES
 * register the router, sees the same shape.)
 */
const useTunnelRunAuthed = (): RunAuthed =>
  Route.useRouteContext({ select: (context: TunnelRouterContext) => context.runAuthed })

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/**
 * Compare the `subdomain` / `rootDomain` strings — empty input maps to
 * `null` so the user clearing a field becomes an explicit `null` write
 * (matching the `SetTunnelRequestBody` schema's "`null` clears,
 * `undefined` preserves" semantics).
 */
const normalizeOptionalString = (raw: string): string | null => {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const runAuthed = useTunnelRunAuthed()
  const patchMutation = useTunnelPatchMutation(runAuthed)
  const [subdomainInput, setSubdomainInput] = useState(state.subdomain ?? '')
  const [rootDomainInput, setRootDomainInput] = useState(state.rootDomain ?? '')

  // `mutation.isPending` is the canonical "in-flight write" signal —
  // wired into every input/button to lock the form during the request.
  // Even though the cached state has already optimistically advanced
  // (so the badge can show "Starting…"), we still want to keep the
  // controls inert until the daemon's response arrives.
  const pending = patchMutation.isPending
  // The mutation hangs onto its last error until the next `mutate` call
  // clears it; surface it next to the existing display.
  const submitError = patchMutation.error
  const errorMessage = submitError === null ? null : formatError(submitError)

  const nextSubdomain = normalizeOptionalString(subdomainInput)
  const nextRootDomain = normalizeOptionalString(rootDomainInput)

  const dirty = nextSubdomain !== state.subdomain || nextRootDomain !== state.rootDomain

  const onToggle = (requestedRunning: boolean): void => {
    patchMutation.mutate({ requestedRunning })
  }

  const onSave = (): void => {
    patchMutation.mutate({
      subdomain: nextSubdomain,
      rootDomain: nextRootDomain,
    })
  }

  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">Tunnel</h1>
      <FieldDescription>
        Expose this device to the public Internet so apps installed on phones can reach it.
      </FieldDescription>

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <TunnelToggle
        requestedRunning={state.requestedRunning}
        running={state.running}
        error={state.error}
        disabled={pending}
        onToggle={onToggle}
      />

      <div className={styles['fields']}>
        <Field label="Subdomain">
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={subdomainInput}
            placeholder="my-clinic"
            disabled={pending}
            onChange={(e) => {
              setSubdomainInput(e.target.value)
            }}
          />
          {state.currentSubdomain !== null && state.currentSubdomain !== state.subdomain ? (
            <FieldDescription>
              <span className={styles['current']}>Running as: {state.currentSubdomain}</span>
            </FieldDescription>
          ) : null}
        </Field>

        <Field label="Root domain">
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={rootDomainInput}
            placeholder="example.com"
            disabled={pending}
            onChange={(e) => {
              setRootDomainInput(e.target.value)
            }}
          />
          {state.currentRootDomain !== null && state.currentRootDomain !== state.rootDomain ? (
            <FieldDescription>
              <span className={styles['current']}>Running as: {state.currentRootDomain}</span>
            </FieldDescription>
          ) : null}
        </Field>
      </div>

      <FieldDescription>
        <span className={styles['current']}>Bound to local server at: {state.servedOrigin}</span>
        {state.currentLocalPort !== null ? (
          <>
            <br />
            <span className={styles['current']}>
              Tunnel forwarding to port {state.currentLocalPort}
            </span>
          </>
        ) : null}
      </FieldDescription>

      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={pending || !dirty}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * Settings landing for the tunnel slice — the fully-migrated worked
 * slice (Issue #101 Phase 1). `TunnelState` is read through TanStack
 * Query off the shared in-memory cache, warmed two ways:
 *
 *   - the route `loader` (below) prefetches via `ensureQueryData`, so
 *     navigation blocks until the data is ready and the component renders
 *     instantly with no spinner;
 *   - failing that (embedded first paint before the token lands), the
 *     in-component `useTunnelStateQuery` fetches once the `RequireAuth`
 *     gate above renders it (post-flush, token present).
 *
 * Edits go through `useTunnelPatchMutation`, which optimistically
 * projects the change into the cache for instant feedback and rolls back
 * if the daemon rejects the patch. `runAuthed` comes from the router
 * context — no `<TunnelClientProvider>` / `use*EffectAction` DI.
 */
const TunnelScreenContent = (): JSX.Element => {
  const runAuthed = useTunnelRunAuthed()
  const { data: state } = useTunnelStateQuery(runAuthed)
  return <TunnelScreenBody state={state} />
}

/**
 * The `/settings/tunnel/` landing route. Defined as a file route so the
 * slice generates its own `routeTree.gen.ts`; in `apps/wildflower-react`
 * this same file is mounted under the app's `/settings` route via
 * `@tanstack/virtual-file-routes`, which computes the identical
 * `/settings/tunnel/` id, so the literal below is stable across both trees.
 *
 * The `loader` prefetches `TunnelState` into the shared query cache via
 * the router context's `runAuthed` runner. It is BEST-EFFORT: in the
 * embedded WebView the bearer token arrives over the gatekeeper bridge
 * only after `transport.flushed`, so a loader firing on first paint can
 * 401. The `/settings` layout gate (`RequireAuth`) is a React-component
 * gate, NOT a `beforeLoad` gate, so it does not hold the loader back.
 * Rather than 401 into the `errorComponent`, the loader swallows a failed
 * prefetch and lets the in-component `useSuspenseQuery` — which only
 * renders once the gate sees the post-flush token — perform the first
 * read. On standalone web the token is present from module load, so the
 * prefetch succeeds and the screen paints instantly.
 *
 * `errorComponent` replaces the old inline `<CatchBoundary>` +
 * `<Suspense>`: the loader (and `useSuspenseQuery`) drive suspense, and a
 * genuine fetch error surfaces here as `<AsyncErrorView title="Tunnel">`.
 */
export const Route = createFileRoute('/settings/tunnel/')({
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
    } catch {
      // Best-effort warm-up — see the route doc comment. A failed
      // prefetch (e.g. embedded first paint before the token lands) is
      // intentionally non-fatal; the in-component query reads later.
    }
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
