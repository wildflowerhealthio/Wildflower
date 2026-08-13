# Design Handoff Extraction How-To

How to read a `.local-notes` design-handoff HTML file when implementing a screen against a reference design. These files (e.g. `.local-notes/Scope Picker (standalone).html`, ~1.1 MB) look like HTML but are **not** readable markup — each is a self-extracting JavaScript bundle whose real page is JSON-encoded inside a `<script>` tag. Opening one directly, or grepping it for class names, finds almost nothing. `.local-notes/` is gitignored, so these files are local-only; this recipe is the way to get usable markup out of one.

## Extract the Markup

The real content is nested two levels deep. Pull it out with a small Node script — regex the tag, `JSON.parse` the payload:

```js
import { readFileSync, writeFileSync } from 'node:fs'

const raw = readFileSync(process.argv[2], 'utf8')

// Stage 1 — the real page is JSON-encoded inside the bundler shell's template tag.
const shell = raw.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/)
if (!shell) throw new Error('no __bundler/template tag — not a design bundle?')
const page = JSON.parse(shell[1])

// Stage 2 — the decoded page carries a map of named sub-component templates...
const inline = page.match(/<script type="application\/json" id="__dc_inline">([\s\S]*?)<\/script>/)
const components = inline ? JSON.parse(inline[1]) : {}

// ...and the main markup after </helmet>. The helmet is a full inlined Tundra CSS
// copy — skip it; the tokens you want are already on the elements below.
const body = page.slice(page.indexOf('</helmet>') + '</helmet>'.length)

writeFileSync('extracted-page.html', body)
writeFileSync('extracted-components.json', JSON.stringify(components, null, 2))
```

- **Stage 1** decodes the bundler shell: the page markup is the JSON string in `<script type="__bundler/template">`.
- **Stage 2** splits that page into its named sub-components (the `__dc_inline` map, keyed by component name — `PermissionStatement`, `FlagToggleRow`, …) and the main page markup, which follows the `</helmet>` tag. The helmet is an inlined copy of the whole Tundra stylesheet; it carries nothing you need, so drop it.

## Read the `DCLogic` Classes, Not Just the Templates

Each component is two parts:

1. A mustache-ish `<x-dc>` **template** — the markup and layout.
2. A **`DCLogic` class** — the interaction model: state machine, serialization rules, and how the component responds to input.

The `DCLogic` class specifies **behavior, not just looks**. When a reference design has any interactivity — a toggle that gates other fields, a picker that serializes a selection, a multi-step state — the class is the source of truth for how it must behave. Read it; the template alone will mislead you into building the right-looking screen with the wrong behavior.

## Translate Styles, Don't Copy Them

The extracted templates reference the repo's **real** CSS custom properties (`--color-raised`, `--space-*`, and the rest of the Tundra token set). That means styles translate almost 1:1 into the codebase's token-driven CSS modules — reuse the same custom properties rather than lifting hard-coded values out of the inlined helmet stylesheet.

## See Also

- [Documentation How-To](../Documentation/How-To.md) — naming and placing any docs this work produces
- [Doc Comments Reference](../Documentation/Doc%20Comments%20Reference.md) — conventions for the doc comments the implemented components carry
