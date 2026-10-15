/**
 * Pull a JSON payload out of a captured response body that is either raw
 * JSON or a browser's rendering of it. When a browser navigates straight to
 * an `application/(fhir+)json` URL, Chrome and Safari show the bytes inside
 * a `<html><body><pre>…</pre></body></html>` shell, and a capture of that
 * page holds the JSON wrapped twice: once by the viewer (`<pre>` injection)
 * and once by HTML escaping (`<` → `&lt;`, `&` → `&amp;`, etc.). JSON
 * response kinds run their bodies through this before decoding, so either
 * shape reaches `Schema.decode(parseJson)` as plain JSON.
 *
 * Strategy:
 *   1. If `text` already looks like JSON (`{` or `[` as the first
 *      non-whitespace character), return it as-is. This keeps direct
 *      XHR captures (where the sniffer intercepts the actual response
 *      stream before any viewer wrap) on a fast path.
 *   2. Otherwise, look for `<pre>…</pre>`. Each match is lazy (it ends
 *      at the first `</pre>`) — most viewers emit a single pre with the
 *      whole payload inside, and when there are several we keep the
 *      *longest*.
 *   3. Decode the HTML entities the viewers emit (`&lt;`, `&gt;`,
 *      `&quot;`, `&#x27;`, `&#39;`, `&amp;`) — order matters: `&amp;`
 *      last so a literal `&amp;lt;` round-trips as `&lt;` not `<`.
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
 *     `application/json`; if the source ever serves `text/html`
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
