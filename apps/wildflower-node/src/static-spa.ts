import { existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { webAssetsDir } from 'wildflower-react/web-assets-dir'

const indexFile = join(webAssetsDir, 'index.html')

// Block path traversal: reject pathnames that escape the dist root after
// normalization. Returns the cleaned path (without leading slashes) or null
// if the input is unsafe / empty.
const safeRelativePath = (pathname: string): string | null => {
  if (pathname === '' || pathname === '/') return null
  const normalized = normalize(pathname).replace(/^\/+/, '')
  if (normalized === '' || normalized === '.' || normalized.startsWith('..')) return null
  if (normalized.includes('\0')) return null
  return normalized
}

// SPA fallback. Serves real files under dist-web verbatim (assets, etc.) and
// falls back to index.html for any other path so deep links rehydrate the
// router on refresh. Registered as a catch-all '*' on HttpApiBuilder.Router
// (the same router HttpApiBuilder.api endpoints land on), so the API's
// specific paths win and only unmatched requests fall through here.
const StaticSpaLive = HttpApiBuilder.Router.use((router) =>
  router.all(
    '*',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, 'http://localhost')
      const safe = safeRelativePath(url.pathname)
      if (safe !== null) {
        const candidate = join(webAssetsDir, safe)
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return yield* HttpServerResponse.file(candidate)
        }
      }
      return yield* HttpServerResponse.file(indexFile)
    })
  )
)

export { StaticSpaLive }
