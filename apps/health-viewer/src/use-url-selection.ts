import { type Selection, decodeSelection, encodeSelection } from 'health-viewer-core'
import { useCallback, useEffect, useState } from 'react'

/** A change to the selection, computed from the latest one. */
type SelectionUpdate = (latestSelection: Selection) => Selection

/** What {@link useUrlSelection} hands the page. */
interface UrlSelection {
  /** The selection as the page last committed it. */
  readonly selection: Selection
  /**
   * Apply `update` to the latest selection — not the one this render saw — so
   * two updates made before a re-render both land.
   */
  readonly updateSelection: (update: SelectionUpdate) => void
}

/** Put `selection` in the address bar, replacing the current entry's query. */
const writeSelectionToUrl = (selection: Selection): void => {
  const url = new URL(window.location.href)
  url.search = encodeSelection(selection).toString()
  window.history.replaceState(window.history.state, '', url)
}

/**
 * The selection, whose only home is the URL: read once with `decodeSelection`
 * when the page opens, and written back with `encodeSelection` through
 * `history.replaceState` after every change (never `pushState` — a checkbox
 * is not a navigation).
 *
 * @remarks
 * Every change is an updater over the latest selection, so a range change and
 * a series change made in one tick compose rather than the second replacing
 * the first with a copy of a stale selection.
 *
 * Nothing is written until the selection first changes: before the handshake
 * completes the URL still carries the OAuth `code` / `state` fhirclient reads,
 * and replacing the query would lose them.
 */
const useUrlSelection = (): UrlSelection => {
  const [openedSelection] = useState(() =>
    decodeSelection(new URLSearchParams(window.location.search))
  )
  const [selection, setSelection] = useState(openedSelection)
  useEffect(() => {
    if (selection !== openedSelection) writeSelectionToUrl(selection)
  }, [selection, openedSelection])
  const updateSelection = useCallback((update: SelectionUpdate) => {
    setSelection(update)
  }, [])
  return { selection, updateSelection }
}

export { useUrlSelection, type SelectionUpdate, type UrlSelection }
