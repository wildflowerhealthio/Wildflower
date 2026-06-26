/**
 * Source-condition placeholder for `wildflower-react/single-web-html`.
 * The real artifact at `dist-single-web/html.{js,d.ts}` is built by
 * `vp run build:single-web`. Node tooling (`vp test`, `vp build`)
 * resolves the import through the package's `exports.source` condition
 * and lands on this file.
 *
 * This stub is only ever served when `dist-single-web/html.js`
 * is absent — i.e. the build hasn't been run. Running `vp run -r build`
 * (or `vp run build:single-web` inside `apps/wildflower-react`) produces
 * the real artifact.
 */
export const html: string = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>wildflower-react: not built</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.5; font-size: 2.5rem; }
    code { background: #f3f3f3; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>wildflower-react is not built</h1>
  <p>
    The single-file web embedded HTML bundle is missing. Run
    <code>vp run -r build</code>
    (or <code>vp run build:single-web</code> in <code>apps/wildflower-react</code>)
    to produce <code>dist-single-web/html.js</code>.
  </p>
  <p>
    This stub is served when no built artifact exists — a consumer resolved
    <code>wildflower-react/single-web-html</code> through the
    <code>source</code> export condition because
    <code>dist-single-web/html.js</code> wasn't on disk.
  </p>
</body>
</html>
`
