import { Option } from 'effect'
import type { Extraction, HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo } from 'react'

import { describeResource, resourceTypeOf } from './describe-resource.ts'
import styles from './review-body.module.css'

/**
 * The interactive per-URL, per-resource review of one HAR file's responses:
 * which of the archive's traffic to import, through which kind, and — new in V1
 * — which of the parsed resources to actually write. A view over
 * `importer-fundamentals`' pure {@link Review} model, driven by pre-parsed
 * previews from the shell. Controlled: the shell owns the selection state.
 *
 * @packageDocumentation
 */

/** One recognized/candidate kind — the concrete `unknown`-parameterised shape the shell threads. */
type AnyKind = HttpResponseKind.HttpResponseKind<unknown>

/** One previewed response — the parse outcome plus every resource's stable key. */
type Preview = Review.PreviewedResponse<AnyKind, unknown>

/** Props for {@link ReviewBody}. */
interface ReviewBodyProps {
  /** One HAR file's decoded responses, in input order. */
  readonly responses: readonly Extraction.Input[]
  /**
   * The format's sources (the shell passes the descriptor's `sources`), each
   * grouping its own kinds under a name and detail. The include toggles are
   * grouped by these; recognition runs against their flattened kinds.
   */
  readonly sources: readonly SourceDescriptor.SourceDescriptor<unknown>[]
  /** Previews the shell parsed for this file's responses under the current selection. */
  readonly previews: readonly Preview[]
  /** The reviewer's selection for this file — reads and writes the same shape. */
  readonly selection: Review.Selection
  /** Called with the new selection on every toggle or override. */
  readonly onChange: (selection: Review.Selection) => void
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
 * `ResponseKind` suffix every kind's identity carries (e.g.
 * `PrescriptionResponseKind` → `Prescription`). The full `name` stays the value
 * behind the label — selection and overrides key by it.
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
  selection: Review.Selection
): readonly TypeTally[] => {
  const order: string[] = []
  const totals = new Map<string, { total: number; excluded: number }>()
  for (const preview of previews) {
    if (preview.outcome._tag !== 'resources') continue
    for (const resource of preview.outcome.resources) {
      // Tallies only care about the resource type; a full describeResource decode
      // per row on every render (selection toggle) would be O(rows²) in per-type
      // schema decodes — the cheap `resourceTypeOf` reads the field directly.
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
  selection,
  onOverride,
}: {
  readonly preview: Preview
  readonly selection: Review.Selection
  readonly onOverride: (kindName: string) => void
}): JSX.Element => {
  const enabled = Review.enabledCandidates(preview.recognized, selection)
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

/** One previewed resource's row: its type, one-line summary, and include toggle. */
const ResourceRow = ({
  resourceKey,
  resource,
  selection,
  onToggle,
}: {
  readonly resourceKey: string
  readonly resource: unknown
  readonly selection: Review.Selection
  readonly onToggle: (key: string) => void
}): JSX.Element => {
  const description = describeResource(resource)
  const included = Review.isResourceIncluded(selection, resourceKey)
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
    </li>
  )
}

/**
 * One recognized response's block under its URL: the picker (for the rare
 * overlap), the parsed resources' rows, or the "why nothing" note for a parse
 * failure / absent body / no-pick outcome.
 */
const ResponseBlock = ({
  preview,
  selection,
  onOverride,
  onToggleResource,
}: {
  readonly preview: Preview
  readonly selection: Review.Selection
  readonly onOverride: (kindName: string) => void
  readonly onToggleResource: (key: string) => void
}): JSX.Element => {
  const outcome = preview.outcome
  if (outcome._tag === 'parseError') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} selection={selection} onOverride={onOverride} />
        <p role="alert" className={styles.parseFailure}>
          This response could not be parsed and will not import.
        </p>
      </li>
    )
  }
  if (outcome._tag === 'bodyAbsent') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} selection={selection} onOverride={onOverride} />
        <p className={styles.bodyAbsent}>The archive captured no response body.</p>
      </li>
    )
  }
  if (outcome._tag === 'noPick') {
    return (
      <li className={styles.responseRow}>
        <ResponsePicker preview={preview} selection={selection} onOverride={onOverride} />
      </li>
    )
  }
  if (outcome._tag === 'duplicate') {
    // A duplicate is never routed to a kind — its `pickKindName` is `None` and
    // rendering the picker would show an empty label / an unmatched <select>
    // value; the "Duplicate of X" note is the whole story here.
    return (
      <li className={styles.responseRow}>
        <p className={styles.bodyAbsent}>Duplicate of {outcome.of.id} — not written.</p>
      </li>
    )
  }
  const resources = outcome.resources
  return (
    <li className={styles.responseRow}>
      <ResponsePicker preview={preview} selection={selection} onOverride={onOverride} />
      <ul className={styles.resourceList}>
        {resources.map((resource) => (
          <ResourceRow
            key={resource.key}
            resourceKey={resource.key}
            resource={resource.resource}
            selection={selection}
            onToggle={onToggleResource}
          />
        ))}
      </ul>
    </li>
  )
}

/** The interactive review of one file's responses. */
const ReviewBody = ({
  responses: _responses,
  sources,
  previews,
  selection,
  onChange,
}: ReviewBodyProps): JSX.Element => {
  // The kinds at least one of this file's responses recognized — the only kinds a
  // toggle can affect for this import. A kind that claims nothing here is shown
  // but disabled, so the menu still lists every source's kinds without offering
  // a toggle that would do nothing.
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
                      // A kind that matches nothing here reads as unchecked, even
                      // though it stays enabled in the selection — nothing in this
                      // file would import under it either way.
                      checked={usable && Review.isKindEnabled(selection, kind.name)}
                      onChange={() => onChange(Review.toggleKind(selection, kind.name))}
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
                    selection={selection}
                    onOverride={(kindName) =>
                      onChange(Review.overridePick(selection, preview.ref.id, kindName))
                    }
                    onToggleResource={(key) => onChange(Review.toggleResource(selection, key))}
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
    </div>
  )
}

export { ReviewBody }
export type { Preview, ReviewBodyProps }
