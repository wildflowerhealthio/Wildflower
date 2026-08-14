import { defineConfig } from 'vite-plus'

import base from '../../vite.config.base.ts'

/**
 * The static "Wildflower server docs" console published at
 * `/wildflower-server-docs`: a Scalar API reference over the six committed
 * slice OpenAPI snapshots, pointed at whichever running server the reader
 * names via `?server=`.
 *
 * Everything is bundled — the Scalar reference comes from its npm package and
 * the specs are imported from `slices/**`, so the published page loads no CDN
 * script and no remote document. A relative `base` so the assets resolve from
 * the site sub-path (`apps/github-pages` copies `dist/` there verbatim).
 *
 * Tests here are pure unit tests over the `?server=` parsing and the spec
 * transforms, so the default node environment is enough.
 */
export default defineConfig({
  ...base,
  base: './',
  build: {
    // Vendoring the whole Scalar reference (plus the bundled OpenAPI
    // snapshots, the FHIR one alone ~300 kB) is the point of this package —
    // the alternative is the CDN script, which a self-contained published page
    // must not load. So a multi-megabyte chunk is expected, not a packaging
    // mistake, and the warning would only be noise.
    chunkSizeWarningLimit: 4000,
  },
  test: {
    ...base.test,
  },
})
