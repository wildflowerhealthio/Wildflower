import { docSources } from './sources.ts'
import { BEARER_SCHEME_NAME, preparedSpec, type OpenApiDocument } from './spec.ts'

/**
 * The Scalar configuration this console renders with — built as pure data so
 * the choices that matter (where requests go, what the page loads, where the
 * access token may end up) are assertable in tests rather than buried in the
 * DOM wiring.
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

/**
 * The bearer-scheme prefill. Scalar's `authentication` block sits beside the
 * sources rather than inside them, so one signed-in token reaches all six
 * documents at once.
 */
export interface ConsoleAuthentication {
  preferredSecurityScheme: typeof BEARER_SCHEME_NAME
  securitySchemes: Record<typeof BEARER_SCHEME_NAME, { token: string }>
}

/** The subset of Scalar's configuration this console sets. */
export interface ConsoleConfiguration {
  sources: ScalarSource[]
  /**
   * Empty on purpose. Scalar's `web` layout otherwise defaults to routing
   * every "send" through `https://proxy.scalar.com`, which would hand a
   * reader's request — bearer token included — to a service we don't run, and
   * could not reach a loopback server anyway. Requests go straight from the
   * browser to the chosen server; see the CORS caveat in the README.
   */
  proxyUrl: ''
  /** No webfont fetch from `fonts.scalar.com`: the page must be self-contained. */
  withDefaultFonts: false
  /**
   * Never `true`. Scalar's persistence plugin writes the whole auth block —
   * the access token included — to `localStorage` when this is on. The console
   * is a public page and the token it signs in with can be admin-capable, so it
   * is held in memory for the life of the tab and nowhere else; see the token
   * custody note in `sign-in.ts`.
   */
  persistAuth: false
  darkMode: boolean
  authentication: ConsoleAuthentication
}

/**
 * The configuration rendering every documented slice against `serverUrl`. One
 * source per slice, so the sidebar groups by slice under the same names the
 * running host uses at `/docs`.
 *
 * `accessToken` prefills the bearer field every source shares, so a reader who
 * has signed in can send an authorised request without pasting anything. Signed
 * out it is empty, and the field is theirs to fill by hand.
 */
export const consoleConfiguration = (
  serverUrl: string,
  options: { readonly prefersDarkMode: boolean; readonly accessToken?: string }
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
  persistAuth: false,
  darkMode: options.prefersDarkMode,
  authentication: {
    preferredSecurityScheme: BEARER_SCHEME_NAME,
    securitySchemes: { [BEARER_SCHEME_NAME]: { token: options.accessToken ?? '' } },
  },
})
