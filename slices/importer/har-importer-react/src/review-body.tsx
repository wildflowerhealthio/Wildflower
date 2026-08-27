import { Option } from 'effect'
import type { Extraction, HttpResponseKind } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo, useState } from 'react'

import styles from './review-body.module.css'

/**
 * The interactive per-URL review of one HAR file's responses: which of the
 * archive's traffic to import and, on the rare overlap, through which kind. A
 * view over `importer-fundamentals`' pure {@link Review} model — uncontrolled,
 * reporting every selection change up through {@link ReviewBodyProps.onChange}.
 * The interaction model (toggles, picker, no-match fold) is described in this
 * package's AGENTS.md.
 *
 * @packageDocumentation
 */

/** Props for {@link ReviewBody}. */
interface ReviewBodyProps {
  /** One HAR file's decoded responses, in input order. */
  readonly responses: readonly Extraction.Input[]
  /** The format's response-kind pool (the shell passes the descriptor's `pool`). */
  readonly pool: readonly HttpResponseKind.HttpResponseKind<unknown>[]
  /** The selection to seed the review with (the shell's default is `Review.initial(pool)`). */
  readonly initialSelection: Review.Selection
  /** Called with the new selection on every toggle or override. */
  readonly onChange: (selection: Review.Selection) => void
}

/** A recognized response, carrying the concrete kind type its candidates hold. */
type Recognized = Extraction.RecognizedResponse<HttpResponseKind.HttpResponseKind<unknown>>

/** Matched responses grouped by URL, in first-seen order. */
interface UrlGroup {
  readonly url: string
  readonly responses: readonly Recognized[]
}

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** Group the matched responses by URL, preserving first-seen order. */
const groupByUrl = (matched: readonly Recognized[]): readonly UrlGroup[] => {
  const order: string[] = []
  const byUrl = new Map<string, Recognized[]>()
  for (const response of matched) {
    const existing = byUrl.get(response.ref.url)
    if (existing === undefined) {
      order.push(response.ref.url)
      byUrl.set(response.ref.url, [response])
    } else existing.push(response)
  }
  return order.map((url) => ({ url, responses: byUrl.get(url) ?? [] }))
}

/** One response's picker: a static label for one kind, a `<select>` for an overlap. */
const ResponsePicker = ({
  recognized,
  selection,
  onOverride,
}: {
  readonly recognized: Recognized
  readonly selection: Review.Selection
  readonly onOverride: (kindName: string) => void
}): JSX.Element => {
  const enabled = Review.enabledCandidates(recognized, selection)
  if (enabled.length === 0) {
    return <span className={styles.excluded}>Excluded — every matching kind is turned off</span>
  }
  const pick = Review.pickFor(recognized, selection)
  const pickName = Option.match(pick, {
    onNone: () => '',
    onSome: (candidate) => candidate.kind.name,
  })
  if (enabled.length === 1) {
    return <span className={styles.singleKind}>{pickName}</span>
  }
  return (
    <select
      className={styles.kindSelect}
      aria-label={`Import kind for ${recognized.ref.url}`}
      value={pickName}
      onChange={(event) => onOverride(event.target.value)}
    >
      {enabled.map((candidate) => (
        <option key={candidate.kind.name} value={candidate.kind.name}>
          {candidate.kind.name}
        </option>
      ))}
    </select>
  )
}

/** The interactive review of one file's responses. */
const ReviewBody = ({
  responses,
  pool,
  initialSelection,
  onChange,
}: ReviewBodyProps): JSX.Element => {
  const [selection, setSelection] = useState<Review.Selection>(initialSelection)
  const recognized = useMemo(() => Review.recognize(pool, responses), [pool, responses])

  // Apply a pure transition, hold it, and report it up in one place.
  const update = (next: Review.Selection): void => {
    setSelection(next)
    onChange(next)
  }

  const matched = recognized.filter((response) => response.candidates.length > 0)
  const unmatched = recognized.filter((response) => response.candidates.length === 0)
  const urlGroups = groupByUrl(matched)

  return (
    <div className={styles.review} aria-label="Review responses">
      <fieldset className={styles.kindToggles}>
        <legend className={styles.togglesLegend}>Include</legend>
        {pool.map((kind) => (
          <label key={kind.name} className={styles.toggle}>
            <input
              type="checkbox"
              checked={Review.isKindEnabled(selection, kind.name)}
              onChange={() => update(Review.toggleKind(selection, kind.name))}
            />
            {kind.name}
          </label>
        ))}
      </fieldset>

      {urlGroups.length > 0 && (
        <ul className={styles.urlList}>
          {urlGroups.map((group) => (
            <li key={group.url} className={styles.urlGroup}>
              <p className={styles.url}>{group.url}</p>
              <ul className={styles.responseList}>
                {group.responses.map((response) => (
                  <li key={response.ref.id} className={styles.responseRow}>
                    <ResponsePicker
                      recognized={response}
                      selection={selection}
                      onOverride={(kindName) =>
                        update(Review.overridePick(selection, response.ref.id, kindName))
                      }
                    />
                  </li>
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
            {unmatched.map((response) => (
              <li key={response.ref.id} className={styles.noMatchUrl}>
                {response.ref.url}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export { ReviewBody }
export type { ReviewBodyProps }
