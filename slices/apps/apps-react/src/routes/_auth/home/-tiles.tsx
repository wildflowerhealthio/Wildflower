import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { CSSProperties, JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge, type StatusTone } from 'react-tundraish'

import type { AppEntry } from '../../../queries.ts'
import tileStyles from '../../../styles/app-tiles.module.css'

/** A registry-flag pill: its label and the {@link StatusTone} it paints. */
interface Pill {
  readonly key: string
  readonly label: string
  readonly tone: StatusTone
}

/** Provenance → its human label + pill tone. Cloud is the "interesting" one
 * (it's the editable / tunnel-reachable kind), so it gets the `info` tint;
 * system / self-hosted stay neutral. */
const PROVENANCE_PILL: Record<
  AppEntry['provenance'],
  { readonly label: string; readonly tone: StatusTone }
> = {
  system: { label: 'System', tone: 'neutral' },
  'self-hosted': { label: 'Self-Hosted', tone: 'neutral' },
  cloud: { label: 'Cloud', tone: 'info' },
}

/**
 * The human label for a provenance — the single source of truth shared with the
 * apps editor, so the home tile and the editor never disagree on casing.
 */
const provenanceLabel = (provenance: AppEntry['provenance']): string =>
  PROVENANCE_PILL[provenance].label

/**
 * The pills a tile shows for an app's registry flags: always the provenance,
 * plus `SMART` when `smart`, `Local-Only` when `localOnly`, and `Tunnel` when
 * `requiresTunnel` (so a launch that needs the tunnel up is signalled before the
 * user clicks into a `503`). Pure — derives the list from the row so it can be
 * unit-tested without rendering.
 */
const tilePills = (app: AppEntry): readonly Pill[] => {
  const provenance = PROVENANCE_PILL[app.provenance]
  const pills: Pill[] = [{ key: 'provenance', label: provenance.label, tone: provenance.tone }]
  if (app.smart) pills.push({ key: 'smart', label: 'SMART', tone: 'info' })
  if (app.localOnly) pills.push({ key: 'local-only', label: 'Local-Only', tone: 'success' })
  // `requiresTunnel` lives only on the cloud variant of the union.
  if (app.provenance === 'cloud' && app.requiresTunnel)
    pills.push({ key: 'tunnel', label: 'Tunnel', tone: 'warning' })
  return pills
}

interface SortableAppTileProps {
  readonly app: AppEntry
  /**
   * Home-screen edit mode. When `false` the tile launches on click and can't be
   * dragged; when `true` dragging is armed, the click no longer launches, and a
   * "Hide" control removes the app from the home screen.
   */
  readonly editing: boolean
  readonly onLaunch: (app: AppEntry) => void
  readonly onDisable: (app: AppEntry) => void
}

/** The app's name / subtitle / pills — shared by the launch button (view mode)
 * and the plain display wrapper (edit mode). */
const TileContent = ({ app }: { readonly app: AppEntry }): JSX.Element => (
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
 * A single home-screen app tile, cribbing the iOS home-screen rearrange
 * language. `useSortable` is gated on `editing` via its `disabled` flag — the
 * hook always runs (so it stays inside `DndContext`), but a drag can only start
 * in edit mode. In view mode the whole tile is a launch button; in edit mode the
 * content gently wiggles inside an inner wrapper (so the wiggle composes with,
 * rather than fights, dnd-kit's drag transform on the `<li>`), a click no longer
 * launches, and a stationary "×" badge pinned to the corner hides the app.
 * dnd-kit's pointer sensor only starts a drag past its activation distance, so
 * the corner badge still fires its `onClick`.
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
        isDragging ? tileStyles['app-tile--dragging'] : null,
        editing && !isDragging ? tileStyles['app-tile--wiggle'] : null
      )}
      {...attributes}
      {...listeners}
    >
      {editing ? (
        <>
          {/* The wiggle lives on this inner wrapper, not the <li>: the drag
           * transform dnd-kit writes to the <li>'s inline style would otherwise
           * be clobbered by the animation's `transform`. Suppress it mid-drag. */}
          <div className={cn(tileStyles['app-tile__body'])}>
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
        <button
          type="button"
          className={cn(tileStyles['app-tile__body'], tileStyles['app-tile__launch'])}
          onClick={() => {
            onLaunch(app)
          }}
        >
          <TileContent app={app} />
        </button>
      )}
    </li>
  )
}

export { provenanceLabel, SortableAppTile, tilePills }
export type { Pill, SortableAppTileProps }
