import { createApiReference } from '@scalar/api-reference'

import '@scalar/api-reference/style.css'
import './styles.css'

import { consoleConfiguration } from './configuration.ts'
import { searchWithServerUrl, serverUrlFromSearch } from './server-target.ts'

/**
 * Boots the static Wildflower server-docs console: a Scalar API reference over
 * the six committed slice snapshots, targeted at whichever running server the
 * `?server=` parameter names (see `server-target.ts`).
 *
 * DOM and history wiring only — the `?server=` parsing, the spec transforms and
 * the Scalar configuration are pure functions in their own modules, where they
 * are unit-tested.
 */

/** Look up a required element, narrowing to the concrete DOM class. */
const requireElement = <T extends Element>(
  selector: string,
  Constructor: abstract new () => T
): T => {
  const element = document.querySelector(selector)
  if (!(element instanceof Constructor)) {
    throw new Error(`Missing ${Constructor.name} at "${selector}"`)
  }
  return element
}

const referenceContainer = requireElement('#reference', HTMLElement)
const serverForm = requireElement('#server-form', HTMLFormElement)
const serverInput = requireElement('#server-url', HTMLInputElement)

const prefersDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches

let reference: ReturnType<typeof createApiReference> | undefined

/**
 * Mount (or re-mount) the reference against `serverUrl`. Re-targeting tears the
 * previous instance down rather than patching its configuration: the documents
 * themselves differ between targets, so a clean mount is the honest update.
 */
const render = (serverUrl: string): void => {
  reference?.destroy()
  reference = createApiReference(
    referenceContainer,
    consoleConfiguration(serverUrl, { prefersDarkMode })
  )
}

/**
 * Point the console at `candidate`, writing the canonical value back into both
 * the URL (so the configured console stays shareable) and the input, then
 * re-rendering. An unusable candidate falls back to the default target, exactly
 * as a fresh load of the resulting URL would.
 */
const applyServerUrl = (candidate: string): void => {
  const search = searchWithServerUrl(window.location.search, candidate)
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  )
  const serverUrl = serverUrlFromSearch(search)
  serverInput.value = serverUrl
  render(serverUrl)
}

serverForm.addEventListener('submit', (event) => {
  event.preventDefault()
  applyServerUrl(serverInput.value)
})

const initialServerUrl = serverUrlFromSearch(window.location.search)
serverInput.value = initialServerUrl
render(initialServerUrl)
