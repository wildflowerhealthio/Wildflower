import { Data, Option } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import {
  type HarSelection,
  type PreviewedResponse,
  enabledCandidates,
  isKindEnabled,
  overridePick,
  toggleKind,
} from 'har-importer-core'
import type { Extraction, HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo, useState } from 'react'
import { Chip } from 'react-tundraish'

import { describeResource, resourceTypeOf } from './describe-resource.ts'
import { ResourceEditor } from './resource-editor.tsx'
import styles from './review-body.module.css'

/**
 * The interactive per-URL, per-resource review of one HAR file's responses:
 * which of the archive's traffic to import, through which kind, and which of
 * the parsed resources to actually write. A view over the HAR-specific routing
 * model (`har-importer-core`) and the general per-resource selection
 * (`importer-fundamentals`). Controlled: the shell owns both state axes.
 *
 * @packageDocumentation
 */

/** One recognized/candidate kind — the concrete `unknown`-parameterised shape the shell threads. */
type AnyKind = HttpResponseKind.HttpResponseKind<unknown>

/** One previewed response — the parse outcome plus every resource's stable key. */
type Preview = PreviewedResponse<AnyKind, unknown>

/**
 * Props for {@link ReviewBody}. Two state axes: the HAR-specific routing
 * selection (kind toggles + pick overrides) and the general per-resource
 * selection (exclude/edit). The shell owns both and passes callbacks for each.
 */
interface ReviewBodyProps {
  /** One HAR file's decoded responses, in input order. */
  readonly responses: readonly Extraction.Input[]
  /**
   * The format's sources, each grouping its own kinds under a name and detail.
   * The include toggles are grouped by these.
   */
  readonly sources: readonly SourceDescriptor.SourceDescriptor<unknown>[]
  /** Previews the shell parsed for this file's responses under the current routing selection. */
  readonly previews: readonly Preview[]
  /** The HAR routing selection: kind toggles + per-response pick overrides. */
  readonly harSelection: HarSelection
  /** The per-resource selection: exclude/edit overrides. */
  readonly selection: Review.Selection<FhirResource>
  /** Called with the new HAR routing selection on every kind toggle or pick override. */
  readonly onHarSelectionChange: (harSelection: HarSelection) => void
  /** Called with the new per-resource selection on every resource toggle or edit. */
  readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
}

/** Matched responses grouped by URL, in first-seen order. */
interface UrlGroup {
  readonly url: string
  readonly previews: readonly Preview[]
}

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/**
 * The display label for a kind: its `name` without the conventional
 * `ResponseKind` suffix every kind's identity carries.
 */
const kindLabel = (name: string): string => name.replace(/ResponseKind$/, '')

/** Group the previewed responses by URL, preserving first-seen order. Skips no-match. */
const groupByUrl = (previews: readonly Preview[]): readonly UrlGroup[] => {
  const order: string[] = []
  const byUrl = new Map<string, Preview[]>()
  for (const preview of previews) {
    if (preview.recognized.candidates.length === 0) continue
    const url = preview.ref.url
    const existing = byUrl.get(url)
    if (existing === undefined) {
      order.push(url)
      byUrl.set(url, [preview])
    } else existing.push(preview)
  }
  return order.map((url) => ({ url, previews: byUrl.get(url) ?? [] }))
}

/** Aggregate include/exclude totals across every previewed resource, by resource type. */
interface TypeTally {
  readonly type: string
  readonly total: number
  readonly excluded: number
}

/** The per-type tallies of a file's previewed resources, in first-seen order. */
const perTypeTallies = (
  previews: readonly Preview[],
  selection: Review.Selection<FhirResource>
): readonly TypeTally[] => {
  const order: string[] = []
  const totals = new Map<string, { total: number; excluded: number }>()
  for (const preview of previews) {
    if (preview.outcome._tag !== 'resources') continue
    for (const resource of preview.outcome.resources) {
      const type = resourceTypeOf(resource.resource)
      const bucket = totals.get(type)
      if (bucket === undefined) {
        order.push(type)
        totals.set(type, {
          total: 1,
          excluded: Review.isResourceIncluded(selection, resource.key) ? 0 : 1,
        })
      } else {
        bucket.total += 1
        if (!Review.isResourceIncluded(selection, resource.key)) bucket.excluded += 1
      }
    }
  }
  return order.map((type) => {
    const bucket = totals.get(type) ?? { total: 0, excluded: 0 }
    return { type, total: bucket.total, excluded: bucket.excluded }
  })
}

/** The one-line tally label for one resource type ("14 MedicationRequest, 2 excluded"). */
const tallyLabel = (tally: TypeTally): string => {
  const base = `${tally.total} ${tally.type}`
  return tally.excluded === 0 ? base : `${base}, ${tally.excluded} excluded`
}

/** One response's picker: a static label for one kind, a `<select>` for an overlap. */
const ResponsePicker = ({
  preview,
  harSelection,
  onOverride,
}: {
  readonly preview: Preview
  readonly harSelection: HarSelection
  readonly onOverride: (kindName: string) => void
}): JSX.Element => {
  const enabled = enabledCandidates(preview.recognized, harSelection)
  if (enabled.length === 0) {
    return <span className={styles.excluded}>Excluded — every matching kind is turned off</span>
  }
  const pickName = Option.getOrElse(preview.pickKindName, () => '')
  if (enabled.length === 1) {
    return <span className={styles.singleKind}>{kindLabel(pickName)}</span>
  }
  return (
    <select
      className={styles.kindSelect}
      aria-label={`Import kind for ${preview.ref.url}`}
      value={pickName}
      onChange={(event) => onOverride(event.target.value)}
    >
      {enabled.map((candidate) => (
        <option key={candidate.kind.name} value={candidate.kind.name}>
          {kindLabel(candidate.kind.name)}
        </option>
      ))}
    </select>
  )
}

/**
 * One previewed resource's row: its type, one-line summary, include toggle,
 * Edit/Revert affordance, and the "edited" chip when a per-resource override
 * is in place.
 */
const ResourceRow = ({
  resourceKey,
  resource,
  selection,
  onToggle,
  onEdit,
  onRevert,
}: {
  readonly resourceKey: string
  readonly resource: unknown
  readonly selection: Review.Selection<FhirResource>
  readonly onToggle: (key: string) => void
  readonly onEdit: (key: string, resource: unknown) => void
  readonly onRevert: (key: string) => void
}): JSX.Element => {
  const edited = Option.getOrElse(Review.editedResource(selection, resourceKey), () => resource)
  const description = describeResource(edited)
  const included = Review.isResourceIncluded(selection, resourceKey)
  const isEdited = Review.isResourceEdited(selection, resourceKey)
  return (
    <li className={styles.resourceRow}>
      <label className={styles.resourceLabel}>
        <input
          type="checkbox"
          checked={included}
          aria-label={`Include ${description.type} ${description.summary}`}
          onChange={() => onToggle(resourceKey)}
        />
        <span className={included ? styles.resourceType : styles.resourceExcluded}>
          {description.type}
        </span>
        <span className={included ? styles.resourceSummary : styles.resourceExcluded}>
          {description.summary}
        </span>
      </label>
      {isEdited && <Chip className={styles.editedChip}>Edited</Chip>}
      <button
        type="button"
        className={styles.editButton}
        onClick={() => onEdit(resourceKey, edited)}
        aria-label={`Edit ${description.type} ${description.summary}`}
      >
        Edit
      </button>
      {isEdited && (
        <button
          type="button"
          className={styles.revertButton}
          onClick={() => onRevert(resourceKey)}
          aria-label={`Revert edit to ${description.type} ${description.summary}`}
        >
          Revert
        </button>
      )}
    </li>
  )
}

/**
 * One recognized response's block under its URL: the picker, the parsed
 * resources' rows, or the "why nothing" note.
 */
const ResponseBlock = ({
  preview,
  harSelection,
  selection,
  onOverride,
  onToggleResource,
  onEditResource,
  onRevertResource,
}: {
  readonly preview: Preview
  readonly harSelection: HarSelection
  readonly selection: Review.Selection<FhirResource>
  readonly onOverride: (kindName: string) => void
  readonly onToggleResource: (key: string) => void
  readonly onEditResource: (key: string, resource: unknown) => void
  readonly onRevertResource: (key: string) => void
}): JSX.Element => {
  const outcome = preview.outcome
  if (outcome._tag === 'parseError') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} harSelection={harSelection} onOverride={onOverride} />
        <p role="alert" className={styles.parseFailure}>
          This response could not be parsed and will not import.
        </p>
      </li>
    )
  }
  if (outcome._tag === 'bodyAbsent') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} harSelection={harSelection} onOverride={onOverride} />
        <p className={styles.bodyAbsent}>The archive captured no response body.</p>
      </li>
    )
  }
  if (outcome._tag === 'noPick') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} harSelection={harSelection} onOverride={onOverride} />
      </li>
    )
  }
  if (outcome._tag === 'duplicate') {
    return (
      <li className={styles.responseRow}>
        <p className={styles.bodyAbsent}>Duplicate of {outcome.of.id} — not written.</p>
      </li>
    )
  }
  const resources = outcome.resources
  return (
    <li className={styles.responseRow}>
      <ResponsePicker preview={preview} harSelection={harSelection} onOverride={onOverride} />
      <ul className={styles.resourceList}>
        {resources.map((resource) => (
          <ResourceRow
            key={resource.key}
            resourceKey={resource.key}
            resource={resource.resource}
            selection={selection}
            onToggle={onToggleResource}
            onEdit={onEditResource}
            onRevert={onRevertResource}
          />
        ))}
      </ul>
    </li>
  )
}

/**
 * The resource-editor dialog's local state.
 */
type EditorState = Data.TaggedEnum<{
  readonly Closed: Record<never, never>
  readonly Open: { readonly key: string; readonly resource: unknown }
}>
const editorState = Data.taggedEnum<EditorState>()
const { Closed: makeClosedEditor, Open: makeOpenEditor } = editorState

/** The interactive review of one HAR file's responses. */
const ReviewBody = ({
  responses: _responses,
  sources,
  previews,
  harSelection,
  selection,
  onHarSelectionChange,
  onSelectionChange,
}: ReviewBodyProps): JSX.Element => {
  const [editing, setEditing] = useState<EditorState>(makeClosedEditor())

  const openEditor = (key: string, resource: unknown): void => {
    setEditing(makeOpenEditor({ key, resource }))
  }
  const closeEditor = (): void => setEditing(makeClosedEditor())
  const keepEdit = (resource: FhirResource): void => {
    if (editing._tag !== 'Open') return
    onSelectionChange(Review.edit(selection, editing.key, resource))
    setEditing(makeClosedEditor())
  }
  const revertEdit = (key: string): void => {
    onSelectionChange(Review.revert(selection, key))
  }
  const usableKinds = useMemo(() => {
    const names = new Set<string>()
    for (const preview of previews) {
      for (const candidate of preview.recognized.candidates) names.add(candidate.kind.name)
    }
    return names
  }, [previews])

  const { unmatched, urlGroups } = useMemo(() => {
    const groups = groupByUrl(previews)
    const unmatchedPreviews = previews.filter(
      (preview) => preview.recognized.candidates.length === 0
    )
    return { unmatched: unmatchedPreviews, urlGroups: groups }
  }, [previews])

  const tallies = useMemo(() => perTypeTallies(previews, selection), [previews, selection])

  return (
    <div className={styles.review} aria-label="Review responses">
      <fieldset className={styles.kindToggles}>
        <legend className={styles.togglesLegend}>Include</legend>
        {sources.map((source) => (
          <div
            key={source.name}
            role="group"
            aria-label={source.display.title}
            className={styles.sourceGroup}
          >
            <p className={styles.sourceName}>{source.display.title}</p>
            <p className={styles.sourceDetail}>{source.display.description}</p>
            <div className={styles.sourceKinds}>
              {source.responseKinds.map((kind) => {
                const usable = usableKinds.has(kind.name)
                return (
                  <label
                    key={kind.name}
                    className={usable ? styles.toggle : `${styles.toggle} ${styles.toggleDisabled}`}
                  >
                    <input
                      type="checkbox"
                      disabled={!usable}
                      checked={usable && isKindEnabled(harSelection, kind.name)}
                      onChange={() => onHarSelectionChange(toggleKind(harSelection, kind.name))}
                    />
                    {kindLabel(kind.name)}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </fieldset>

      {tallies.length > 0 && (
        <p role="status" className={styles.responseTally}>
          {tallies.map(tallyLabel).join(' · ')}
        </p>
      )}

      {urlGroups.length > 0 && (
        <ul className={styles.urlList}>
          {urlGroups.map((group) => (
            <li key={group.url} className={styles.urlGroup}>
              <p className={styles.url}>{group.url}</p>
              <ul className={styles.responseList}>
                {group.previews.map((preview) => (
                  <ResponseBlock
                    key={preview.ref.id}
                    preview={preview}
                    harSelection={harSelection}
                    selection={selection}
                    onOverride={(kindName) =>
                      onHarSelectionChange(overridePick(harSelection, preview.ref.id, kindName))
                    }
                    onToggleResource={(key) =>
                      onSelectionChange(Review.toggleResource(selection, key))
                    }
                    onEditResource={openEditor}
                    onRevertResource={revertEdit}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {unmatched.length > 0 && (
        <details className={styles.noMatch}>
          <summary className={styles.noMatchSummary}>
            {`${unmatched.length} ${plural(unmatched.length, 'response')} matched no importer`}
          </summary>
          <ul className={styles.noMatchList}>
            {unmatched.map((preview) => (
              <li key={preview.ref.id} className={styles.noMatchUrl}>
                {preview.ref.url}
              </li>
            ))}
          </ul>
        </details>
      )}

      <ResourceEditor
        open={editing._tag === 'Open'}
        resource={editing._tag === 'Open' ? editing.resource : null}
        onEdit={(edit) => keepEdit(edit.resource)}
        onCancel={closeEditor}
      />
    </div>
  )
}

export { ReviewBody }
export type { Preview, ReviewBodyProps }
