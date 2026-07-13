import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties, JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge, type StatusTone } from 'react-tundraish'

import type { AppRegistration } from '../../../queries.ts'
import tileStyles from '../../../styles/app-tiles.module.css'

/** A registry-flag pill: its label and the {@link StatusTone} it paints. */
interface Pill {
  readonly key: string
  readonly label: string
  readonly tone: StatusTone
}

/** Kind → its human label + pill tone. Cloud is the "interesting" one (it's the
 * editable / tunnel-reachable kind), so it gets the `info` tint; system /
 * self-hosted stay neutral. */
const KIND_PILL: Record<
  AppRegistration['kind'],
  { readonly label: string; readonly tone: StatusTone }
> = {
  system: { label: 'System', tone: 'neutral' },
  'self-hosted': { label: 'Self-Hosted', tone: 'neutral' },
  cloud: { label: 'Cloud', tone: 'info' },
}

/**
 * The human label for a kind — the single source of truth shared with the apps
 * editor, so the home tile and the editor never disagree on casing.
 */
const kindLabel = (kind: AppRegistration['kind']): string => KIND_PILL[kind].label

/**
 * The pills a tile shows for an app's registry flags: always the kind, plus
 * `SMART` when `smart`, `Local-Only` when `localOnly`, and `Tunnel` when
 * `requiresTunnel` (so a launch that needs the tunnel up is signalled before the
 * user clicks into a `503`). Pure — derives the list from the row so it can be
 * unit-tested without rendering. `requiresTunnel` reads straight off the uniform
 * registration (no per-kind narrowing).
 */
const tilePills = (app: AppRegistration): readonly Pill[] => {
  const kind = KIND_PILL[app.kind]
  const pills: Pill[] = [{ key: 'kind', label: kind.label, tone: kind.tone }]
  if (app.smart) pills.push({ key: 'smart', label: 'SMART', tone: 'info' })
  if (app.localOnly) pills.push({ key: 'local-only', label: 'Local-Only', tone: 'success' })
  if (app.requiresTunnel) pills.push({ key: 'tunnel', label: 'Tunnel', tone: 'warning' })
  return pills
}

interface SortableAppTileProps {
  readonly app: AppRegistration
  /**
   * Home-screen edit mode. When `false` the tile launches on click and can't be
   * dragged; when `true` dragging is armed, the click no longer launches, and a
   * "Hide" control removes the app from the home screen.
   */
  readonly editing: boolean
  /**
   * The web launch target (`/apps/{id}`), or `undefined` on Tauri. Defined ⇒ the
   * view-mode tile is a real `<a href>` the browser follows — native plain-click
   * / cmd-click affordances, and the auth cookie rides the navigation.
   * `undefined` ⇒ a plain `<button>` whose click drives `onLaunch` through the
   * authed loopback client, so the Tauri webview never navigates. See
   * `launchHref` in `-launch.ts`.
   */
  readonly href: string | undefined
  readonly onLaunch: (app: AppRegistration) => void
  readonly onDisable: (app: AppRegistration) => void
}

/** The app's name / subtitle / pills — shared by the launch button (view mode)
 * and the plain display wrapper (edit mode). */
const TileContent = ({ app }: { readonly app: AppRegistration }): JSX.Element => (
  <>
    <span className={tileStyles['app-tile__head']}>
      <span className={cn(tileStyles['app-tile__name'], 'text-body-2')}>{app.name}</span>
      {app.subtitle !== undefined ? (
        <span className={cn(tileStyles['app-tile__subtitle'], 'text-body-3')}>{app.subtitle}</span>
      ) : null}
    </span>
    <span className={tileStyles['app-tile__pills']}>
      {tilePills(app).map((pill) => (
        <StatusBadge key={pill.key} tone={pill.tone}>
          {pill.label}
        </StatusBadge>
      ))}
    </span>
  </>
)

/**
 * The view-mode launch target: a real `<a href>` on web (so a plain click
 * navigates this tab, a cmd/ctrl-click opens a new one, and the auth cookie rides
 * the navigation) or a plain `<button>` on Tauri (`href` is `undefined`; the
 * click drives the authed loopback launch through `onLaunch` and the webview
 * never navigates). Split out so the tile's `editing` branch stays a flat
 * two-way choice rather than a nested ternary.
 */
const TileLaunchTarget = ({
  app,
  href,
  onLaunch,
}: {
  readonly app: AppRegistration
  readonly href: string | undefined
  readonly onLaunch: (app: AppRegistration) => void
}): JSX.Element => {
  const className = cn(tileStyles['app-tile__body'], tileStyles['app-tile__launch'])
  // No `onClick` on the anchor: the navigation *is* the launch. `rel` keeps
  // crawlers off the launch route and withholds the referrer from the target.
  if (href !== undefined) {
    return (
      <a className={className} href={href} rel="nofollow noreferrer">
        <TileContent app={app} />
      </a>
    )
  }
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onLaunch(app)
      }}
    >
      <TileContent app={app} />
    </button>
  )
}

/**
 * A single home-screen app tile, cribbing the iOS home-screen rearrange
 * language. `useSortable` is gated on `editing` via its `disabled` flag — the
 * hook always runs (so it stays inside `DndContext`), but a drag can only start
 * in edit mode. In view mode the whole tile is a launch target — a real
 * `<a href>` on web (so a plain click navigates and a cmd/ctrl-click opens a new
 * tab, both native) or a plain `<button>` on Tauri (`href` is `undefined`; the
 * click drives the authed loopback launch and the webview stays put). In edit
 * mode the content gently wiggles inside an inner wrapper (so the wiggle composes
 * with, rather than fights, dnd-kit's drag transform on the `<li>`), a click no
 * longer launches, and a stationary "×" badge pinned to the corner hides the app.
 * dnd-kit's pointer sensor only starts a drag past its activation distance, so a
 * plain click still reaches the anchor/button (and the corner badge's `onClick`).
 */
const SortableAppTile = ({
  app,
  editing,
  href,
  onLaunch,
  onDisable,
}: SortableAppTileProps): JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.id,
    disabled: !editing,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        tileStyles['app-tile'],
        editing ? tileStyles['app-tile--editing'] : null,
        isDragging ? tileStyles['app-tile--dragging'] : null
      )}
      {...attributes}
      {...listeners}
    >
      {editing ? (
        <>
          {/* The wiggle lives on this inner wrapper, not the <li>: the drag
           * transform dnd-kit writes to the <li>'s inline style would otherwise
           * be clobbered by the animation's `transform`. Suppress it mid-drag. */}
          <div
            className={cn(
              tileStyles['app-tile__body'],
              !isDragging ? tileStyles['app-tile--wiggle'] : null
            )}
          >
            <TileContent app={app} />
          </div>
          <button
            type="button"
            className={tileStyles['app-tile__disable']}
            aria-label={`Hide ${app.name}`}
            onClick={() => {
              onDisable(app)
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </>
      ) : (
        <TileLaunchTarget app={app} href={href} onLaunch={onLaunch} />
      )}
    </li>
  )
}

export { kindLabel, SortableAppTile, tilePills }
export type { Pill, SortableAppTileProps }
