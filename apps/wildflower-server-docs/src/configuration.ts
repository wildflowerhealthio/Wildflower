import { docSources } from './sources.ts'
import { preparedSpec, type OpenApiDocument } from './spec.ts'

/**
 * The Scalar configuration this console renders with — built as pure data so
 * the choices that matter (where requests go, what the page loads) are
 * assertable in tests rather than buried in the DOM wiring.
 */

/** One entry of Scalar's multi-source sidebar: a slice and its document. */
export interface ScalarSource {
  title: string
  slug: string
  content: OpenApiDocument
  /** Whether this is the source shown on first load. */
  default: boolean
  /** Scalar's hosted AI assistant, off — this console talks to no third party. */
  agent: { disabled: true }
}

/** The subset of Scalar's configuration this console sets. */
export interface ConsoleConfiguration {
  sources: ScalarSource[]
  /**
   * Empty on purpose. Scalar's `web` layout otherwise defaults to routing
   * every "send" through `https://proxy.scalar.com`, which would hand a
   * reader's request — bearer token included — to a third party, and could not
   * reach a loopback server anyway. Requests go straight from the browser to
   * the chosen server; see the CORS caveat in the README.
   */
  proxyUrl: ''
  /** No webfont fetch from `fonts.scalar.com`: the page must be self-contained. */
  withDefaultFonts: false
  darkMode: boolean
}

/**
 * The configuration rendering every documented slice against `serverUrl`. One
 * source per slice, so the sidebar groups by slice under the same names the
 * running host uses at `/docs`.
 */
export const consoleConfiguration = (
  serverUrl: string,
  options: { readonly prefersDarkMode: boolean }
): ConsoleConfiguration => ({
  sources: docSources.map((source, index) => ({
    title: source.title,
    slug: source.slug,
    content: preparedSpec(source.spec, serverUrl),
    default: index === 0,
    agent: { disabled: true },
  })),
  proxyUrl: '',
  withDefaultFonts: false,
  darkMode: options.prefersDarkMode,
})
