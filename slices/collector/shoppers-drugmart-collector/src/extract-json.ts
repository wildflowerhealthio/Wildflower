/**
 * Pull a JSON payload out of either raw JSON or the HTML envelope
 * mobile WebViews wrap around a `application/(fhir+)json` response
 * (Chrome / Safari render the bytes inside a `<html><body><pre>…</pre></body></html>`
 * shell). The handler streams `document.documentElement.outerHTML` as
 * the synthetic page content, so by the time the collector entity sees
 * the response body, the JSON we actually want has been wrapped twice:
 * once by the viewer (`<pre>` injection) and once by HTML escaping
 * (`<` → `&lt;`, `&` → `&amp;`, etc.).
 *
 * The Shoppers SPA's profile/prescription payloads arrive as XHR intercepts
 * (raw JSON, so the fast path returns them untouched); the `<pre>` unwrap
 * covers the fallback where the host snapshots a rendered JSON viewer
 * instead. This is a verbatim copy of `fhir-r4-client-collector`'s
 * `extract-json.ts` (also copied into `rexall-be-well-collector`) — slice
 * layering forbids one `*-client-collector` importing another.
 *
 * Strategy:
 *   1. If `text` already looks like JSON (`{` or `[` as the first
 *      non-whitespace character), return it as-is. This keeps direct
 *      XHR captures (where the sniffer intercepts the actual response
 *      stream before any viewer wrap) on a fast path.
 *   2. Otherwise, look for `<pre>…</pre>`. The match is greedy — most
 *      viewers emit a single pre with the whole payload inside. We pick
 *      the *longest* match to avoid clipping at a JSON-string `</pre>`
 *      substring (unlikely in FHIR but cheap to guard).
 *   3. Decode the four HTML entities the viewers emit (`&lt;`, `&gt;`,
 *      `&quot;`, `&amp;`) — order matters: `&amp;` last so a literal
 *      `&amp;lt;` round-trips as `&lt;` not `<`.
 *   4. If neither path produces a JSON-looking string, return the
 *      original text so the downstream `Schema.decode(parseJson)` step
 *      surfaces a `ParseError` with a usable cause.
 *
 * Not in scope:
 *   - Multi-byte / surrogate-pair entities (`&#xFFFD;` etc.) — the
 *     payloads are predominantly ASCII inside string values; the JSON
 *     stays valid after the basic entity sweep.
 *   - Pretty-print viewers that inject `<span class="key">…</span>`
 *     spans inside the `<pre>`. The Chrome viewer doesn't do this for
 *     `application/json`; if the portal ever serves `text/html`
 *     directly, the parse fails downstream and the surfaced error makes
 *     the boundary obvious.
 */
const extractJson = (text: string): string => {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return text

  const preMatches = [...text.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
  const longest = preMatches.reduce<string | null>((best, match) => {
    const body = match[1] ?? ''
    if (best === null || body.length > best.length) return body
    return best
  }, null)
  if (longest === null) return text

  return longest
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export { extractJson }
