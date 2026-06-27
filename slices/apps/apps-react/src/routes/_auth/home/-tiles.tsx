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
 * The pills a tile shows for an app's registry flags: always the provenance,
 * plus `SMART` when `smart` and `Local-Only` when `localOnly`. Pure — derives
 * the list from the row so it can be unit-tested without rendering.
 */
const tilePills = (app: AppEntry): readonly Pill[] => {
  const provenance = PROVENANCE_PILL[app.provenance]
  const pills: Pill[] = [{ key: 'provenance', label: provenance.label, tone: provenance.tone }]
  if (app.smart) pills.push({ key: 'smart', label: 'SMART', tone: 'info' })
  if (app.localOnly) pills.push({ key: 'local-only', label: 'Local-Only', tone: 'success' })
  return pills
}

interface SortableAppTileProps {
  readonly app: AppEntry
  readonly onLaunch: (app: AppEntry) => void
}

/**
 * A single drag-sortable app tile. `useSortable` wires the drag transform and
 * the activator listeners onto the tile; a click that isn't a drag launches
 * the app. The pill row reflects the registry flags via {@link tilePills}.
 *
 * The whole tile is the drag handle (the `listeners`/`attributes` spread), so
 * the launch lives on a nested button rather than the tile itself — dnd-kit's
 * pointer sensor only starts a drag past its activation distance, so a plain
 * click still fires the button's `onClick`.
 */
const SortableAppTile = ({ app, onLaunch }: SortableAppTileProps): JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: app.id,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  }
  const pills = tilePills(app)
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(tileStyles['app-tile'], isDragging ? tileStyles['app-tile--dragging'] : null)}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        className={tileStyles['app-tile__launch']}
        onClick={() => {
          onLaunch(app)
        }}
      >
        <span className={tileStyles['app-tile__head']}>
          <span className={cn(tileStyles['app-tile__name'], 'text-body-2')}>{app.name}</span>
          {app.subtitle !== undefined ? (
            <span className={cn(tileStyles['app-tile__subtitle'], 'text-body-3')}>
              {app.subtitle}
            </span>
          ) : null}
        </span>
        <span className={tileStyles['app-tile__pills']}>
          {pills.map((pill) => (
            <StatusBadge key={pill.key} tone={pill.tone}>
              {pill.label}
            </StatusBadge>
          ))}
        </span>
      </button>
    </li>
  )
}

export { SortableAppTile, tilePills }
export type { Pill, SortableAppTileProps }
