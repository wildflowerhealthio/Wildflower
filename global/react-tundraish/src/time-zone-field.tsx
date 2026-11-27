import { isKnownTimeZone } from '@wildflowerhealthio/kitchen-sink'
import { useDebouncedCallback } from '@wildflowerhealthio/react-kitchen-sink'
import { useId, useState, type ComponentProps, type JSX, type ReactNode } from 'react'

import { Field, FieldDescription } from './field.tsx'
import { Notice } from './notice.tsx'

/** What the field says under a name the runtime cannot resolve as a zone. */
const UNKNOWN_TIME_ZONE_MESSAGE =
  'Not an IANA time zone name (for example America/Toronto). The last recognized zone stays in use.'

/**
 * How long the field waits after the last keystroke before reporting a zone.
 *
 * @remarks
 * A reported zone usually sets off expensive work downstream (re-reading
 * files under it, say), so reporting each keystroke would run it a dozen
 * times for one typed zone name. Long enough to cover normal typing, short
 * enough that a reviewer who pauses sees the result follow.
 */
const TIME_ZONE_COMMIT_DELAY_MS = 400

/**
 * Props for {@link TimeZoneField}: its label, committed zone, suggestions and
 * `onChange`, and any other `<div>` prop (`id`, `aria-*`, `data-*`, `ref`, a
 * `className` added to its own), which go to the root {@link Field}.
 * `onChange` is the committed zone's, so a caller cannot set the `<div>`'s.
 */
interface TimeZoneFieldProps extends Omit<ComponentProps<'div'>, 'children' | 'onChange'> {
  /** Label rendered above the input as the Field eyebrow. */
  readonly label: ReactNode
  /** The caller's IANA zone: what the field shows until the reviewer types, and whenever it changes. */
  readonly value: string
  /** Called with a zone the runtime recognizes, once typing pauses or the field is left. */
  readonly onChange: (timeZone: string) => void
  /** Zones offered through a `datalist`, most likely first. */
  readonly suggestions: readonly string[]
  /** Secondary helper rendered beneath the input via `<FieldDescription>`. */
  readonly description?: ReactNode
}

/**
 * A free-text IANA time zone field with suggested zones offered through a
 * `datalist`, so the common ones need no typing and any other zone can still
 * be typed.
 *
 * @remarks
 * What is typed is the field's own draft, and the field reports a zone up
 * only when the runtime recognizes it (`isKnownTimeZone`), on a
 * {@link TIME_ZONE_COMMIT_DELAY_MS} wait after the last keystroke, flushed on
 * blur or Enter. Every half-typed prefix of `America/Toronto` is itself a
 * name the runtime rejects, so reporting them would hand the caller a run of
 * unusable zones on the way to a good one. An unrecognized name is flagged
 * inline instead (`aria-invalid` and a danger {@link Notice} saying
 * {@link UNKNOWN_TIME_ZONE_MESSAGE}), and the caller keeps the last zone that
 * was recognized.
 *
 * A zone equal to `value` is not reported: deleting a letter and typing it
 * back changes nothing the caller holds. A `value` changed from outside while
 * the field is mounted (the same setting edited in another place) replaces
 * the draft and drops any pending report; a report echoing back as `value`
 * is the zone the field already holds, so what has been typed since is kept.
 */
const TimeZoneField = ({
  label,
  value,
  onChange,
  suggestions,
  description,
  ...rest
}: TimeZoneFieldProps): JSX.Element => {
  const inputId = useId()
  const listId = useId()
  const messageId = useId()

  const [draft, setDraft] = useState(value)
  // The zone the field and its caller last agreed on: the one it last
  // reported, or the `value` it last took in. A `value` that differs from it
  // was set from outside; one that equals it is a report echoing back.
  const [agreed, setAgreed] = useState(value)
  if (value !== agreed) {
    setAgreed(value)
    setDraft(value)
  }

  // A report pending when the draft was replaced from outside no longer
  // matches the draft, so it is dropped when it fires or is flushed.
  const commit = useDebouncedCallback((timeZone: string) => {
    if (timeZone !== draft || timeZone === value) return
    setAgreed(timeZone)
    onChange(timeZone)
  }, TIME_ZONE_COMMIT_DELAY_MS)

  const edit = (timeZone: string): void => {
    setDraft(timeZone)
    // Cancel rather than leave an earlier recognized prefix scheduled: typing
    // on past `UTC` into `UTC-nonsense` must not report `UTC` a beat later.
    if (isKnownTimeZone(timeZone) && timeZone !== value) commit.call(timeZone)
    else commit.cancel()
  }

  const known = isKnownTimeZone(draft)
  return (
    <Field {...rest} label={label} htmlFor={inputId}>
      <input
        id={inputId}
        type="text"
        className="input-3"
        autoComplete="off"
        autoCapitalize="none"
        list={listId}
        value={draft}
        aria-invalid={!known}
        aria-describedby={known ? undefined : messageId}
        onChange={(event) => edit(event.target.value)}
        onBlur={commit.flush}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit.flush()
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      {known ? null : (
        <Notice id={messageId} tone="danger">
          {UNKNOWN_TIME_ZONE_MESSAGE}
        </Notice>
      )}
    </Field>
  )
}

export { TIME_ZONE_COMMIT_DELAY_MS, TimeZoneField, UNKNOWN_TIME_ZONE_MESSAGE }
export type { TimeZoneFieldProps }
