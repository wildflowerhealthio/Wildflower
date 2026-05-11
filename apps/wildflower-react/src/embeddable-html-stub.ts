/**
 * Source-condition fallback for `wildflower-react/embeddable-html`. The
 * real artifact at `dist-embedded/html.{js,d.ts}` is built by
 * `vp run build:embedded`; until then, consumers resolving with
 * `--conditions=source` (e.g. Expo dev) get this stub instead of a
 * silent blank screen.
 */
export const html: string = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>wildflower-react: not built</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.5; }
    code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>wildflower-react is not built</h1>
  <p>
    The embedded HTML bundle is missing. Run
    <code>vp run -r build</code>
    (or <code>vp run build:embedded</code> in <code>apps/wildflower-react</code>)
    to produce <code>dist-embedded/html.js</code>.
  </p>
  <p>
    This stub is served when a consumer resolves
    <code>wildflower-react/embeddable-html</code>
    with <code>--conditions=source</code> before a build has run.
  </p>
</body>
</html>
`
