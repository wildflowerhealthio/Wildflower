// Dev-only placeholder. The real `html` constant is emitted by
// `vite.config.ts`'s `emitHtmlAsModule` plugin during `vp run build:html`
// and lives at `dist-html/html.js`. The package's `./html` export resolves
// to that build artifact in the `default` condition; this file is only
// resolved under the `source` condition (used by TypeScript and dev
// tools) so type-checking and source-mode imports don't require a build.
const html = ''

export { html }
