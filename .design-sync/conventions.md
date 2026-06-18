# Tundraish Design System — conventions

React DOM component primitives styled with **tundra-css** (utility classes +
design tokens). These are the building blocks the Wildflower apps
(gatekeeper, collector, tunnel, apps) share. Compose primitives; reach for a
raw element only when no primitive fits.

## Styling vocabulary

Components are styled by **tundra-css utility classes** plus their own hashed
module CSS. When composing previews or app screens, prefer these classes over
ad-hoc inline styles:

- **Text** — `text-body-{1..4}`, `text-label-{1..4}`, `text-heading-{1..5}`.
- **Inputs** — `input-{1..4}` (apps standardise on `input-2`). Checkboxes and
  radios take `checkbox-{1..4}` / `radio-{1..4}` on the `<input>`.
- **Buttons** — `button-{1..4}` with a `filled` or `outline` variant, e.g.
  `button-2 outline`. Accent a button with `accent-{red,blue,green,yellow,…}`
  to repoint the `--app-accent-*` token chain (e.g. `button-2 filled accent-red`
  for a destructive action).

## Tokens & theming

- Spacing, radius, color, and type scale come from tundra-css custom
  properties (`--color-neutral-*`, `--radius-*`, `--font-size-*`,
  `--font-weight-*`). Use tokens, not literal values.
- **Dark mode** is driven by the `:root[data-color-scheme='dark']` attribute
  (set in JS), **not** `prefers-color-scheme`.
- **Fonts** — no custom `@font-face`; tundra uses system font stacks sized by
  the type tokens. There is nothing to load.

## Composition notes

- A screen renders exactly one `PageHeader` as the first child of its shell —
  never stack two headings.
- `Field` labels a single control (`htmlFor` ties the label to it);
  `FieldGroup` labels a *set* of controls (checkboxes/radios) via
  `role="group"`. `RadioGroup` already renders a named `<fieldset>`, so it
  needs no outer `Field`/`FieldGroup`.
- Destructive menu items use `destructive: true`; blocking dialogs use
  `dismissable={false}` (no × button, ESC/backdrop swallowed).
