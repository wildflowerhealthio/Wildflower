import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Link } from '@tanstack/react-router'
import type { CSSProperties, JSX, MouseEvent } from 'react'
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
  if (app.isSmart) pills.push({ key: 'smart', label: 'SMART', tone: 'info' })
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
  /** Launch `app` here or in a new tab, per the click (see {@link launchPlaceFor}). */
  readonly onLaunch: (app: AppRegistration, place: LaunchPlace) => void
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

/** Where a click on a launch tile opens the app. */
type LaunchPlace = 'here' | 'newTab'

/**
 * Where a click on a launch tile should open the app, or `undefined` to leave
 * the click to the browser. A plain primary click launches here; a primary
 * click with ctrl, cmd or shift, or a middle click, launches in a new tab —
 * what those clicks do to any link. Anything else (a right click's context
 * menu) is the browser's own.
 */
const launchPlaceFor = (click: {
  readonly button: number
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}): LaunchPlace | undefined => {
  if (click.button === 1) return 'newTab'
  if (click.button !== 0) return undefined
  return click.ctrlKey || click.metaKey || click.shiftKey ? 'newTab' : 'here'
}

/**
 * The view-mode launch target: a real link to the app's launch route,
 * so it behaves like any link — hover shows where it goes, and right-click →
 * "Open in new tab" works through the route. Clicks the page can serve itself
 * (see {@link launchPlaceFor}) are taken over, so the launch rides this page's
 * session instead of a fresh tab signing in first. Split out so the tile's
 * `editing` branch stays a flat two-way choice rather than a nested ternary.
 */
const TileLaunchTarget = ({
  app,
  onLaunch,
}: {
  readonly app: AppRegistration
  readonly onLaunch: (app: AppRegistration, place: LaunchPlace) => void
}): JSX.Element => {
  const takeOver = (event: MouseEvent<HTMLAnchorElement>): void => {
    const place = launchPlaceFor(event)
    if (place === undefined) return
    event.preventDefault()
    onLaunch(app, place)
  }
  return (
    <Link
      to="/home/launch/$id"
      params={{ id: app.id }}
      className={cn(tileStyles['app-tile__body'], tileStyles['app-tile__launch'])}
      rel="nofollow noreferrer"
      onClick={takeOver}
      onAuxClick={takeOver}
    >
      <TileContent app={app} />
    </Link>
  )
}

/**
 * A single home-screen app tile, cribbing the iOS home-screen rearrange
 * language. `useSortable` is gated on `editing` via its `disabled` flag — the
 * hook always runs (so it stays inside `DndContext`), but a drag can only start
 * in edit mode. In view mode the whole tile is a launch link. In edit
 * mode the content gently wiggles inside an inner wrapper (so the wiggle composes
 * with, rather than fights, dnd-kit's drag transform on the `<li>`), a click no
 * longer launches, and a stationary "×" badge pinned to the corner hides the app.
 * dnd-kit's pointer sensor only starts a drag past its activation distance, so a
 * plain click still reaches the link (and the corner badge's `onClick`).
 */
const SortableAppTile = ({
  app,
  editing,
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
        <TileLaunchTarget app={app} onLaunch={onLaunch} />
      )}
    </li>
  )
}

export { kindLabel, launchPlaceFor, SortableAppTile, tilePills }
export type { LaunchPlace, Pill, SortableAppTileProps }
