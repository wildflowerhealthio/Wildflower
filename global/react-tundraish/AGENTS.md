# AGENTS.md — global/react-tundraish

Tundra-CSS-styled React DOM primitives plus the palette every Wildflower surface
paints itself from. The palette lives in `src/colors-custom.css`, keyed on two
selectors: `:root` for light and `:root[data-color-scheme='dark']` for dark.
Each is written across more than one rule (the light tokens follow an `:root`
block of `--app-accent` aliases; the dark ones follow a `color-scheme` rule and
precede the dark button overrides), and every rule on a selector cascades onto
the same target — so a token can be read from any of them. There is no
`prefers-color-scheme` rule anywhere: both runtimes resolve the scheme in JS and
write the attribute (see `src/color-scheme.ts`).

## Loading the styles

An app's entry imports `react-tundraish/styles` before anything else that
carries CSS. It is `src/styles.ts`, a module of side-effect imports in the
load-bearing order: `tundra-css` (base tokens and reset), then this package's
`styles.css` (which re-points them), then the Atkinson Hyperlegible faces
`--font-sans` / `--font-mono` resolve to. It is a module rather than a
stylesheet of `@import`s because `index.ts` imports `./styles.css` too: the
bundler dedupes a stylesheet by module id, so an app that still imports
`tundra-css` or `react-tundraish/styles.css` directly gets one copy of each,
while an `@import` would be inlined and ship twice. `tundra-css` and the two
`@fontsource-variable` packages are peers, so the app lists them.

## Categorical series tokens

`--color-series-1` … `--color-series-4` are the chart-identity slots, with
`--color-series-N-soft` as each slot's low-alpha band fill (`color-mix()` off
the same slot, so a re-stepped slot carries its band with it). Both sets are
defined under **both** selectors.

- **Fixed order, never cycled.** A chart takes slot 1, then 2, then 3, then 4.
  A fifth series folds into an "Other" series or takes a facet — it never comes
  back around to slot 1. The order _is_ the CVD-safety mechanism; re-ordering
  invalidates the validation below.
- **Never a status colour, in either direction.** Success / warning / danger are
  reserved for state and always ship with an icon and a label; a series never
  borrows one, and a status never stands in for "series 4". A series that
  genuinely _means_ good/bad wears the status tokens instead — never both in one
  chart.
- **Text stays in the text tokens.** Values, axis labels, and legend text wear
  `--color-neutral-*`; the swatch beside the text carries the identity. A series
  colour is for marks and band fills only.
- **`-soft` is a backdrop.** It is the fill behind a reference range — never a
  mark, never a text colour.
- **Light mode owes the reader a second channel.** Slots 2-4 sit below 3:1 on
  the light canvas _and_ on the lighter card surface a chart usually sits on
  (`--color-background`, `#f2f2f2`), so a light-mode chart ships visible direct
  labels or a table view; colour alone is not enough. Dark clears 3:1 on both of
  its surfaces, so the obligation is light-mode only.
- **Four slots hold for stacks, bars, and lines only.** Those forms compare
  _adjacent_ slots. A scatter, bubble, choropleth, or small-multiples chart puts
  every pair on screen at once, and slot 4 (yellow) beside slot 2 (orange) fails
  there — those forms carry three series and fold the rest.

The four are validated as a **set** per mode against the page canvas
(`--color-canvas`: `#dedede` light, `#161616` dark) — lightness band, chroma
floor, protan/deutan ΔE, normal-vision ΔE, contrast. Only the contrast check
moves with the surface, so the card surface (`--color-background`: `#f2f2f2`
light, `#1c1c1c` dark) is worth a second run when a chart lands on a card; it
does not change either mode's verdict. Changing one value means re-running the
validator over all four in both modes and snapping to a passing step, not
eyeballing the one slot:

```bash
node <dataviz-skill>/scripts/validate_palette.js \
  "#3d66d0,#eb6834,#1baf7a,#eda100" --mode light --surface "#dedede"
node <dataviz-skill>/scripts/validate_palette.js \
  "#426dd7,#d95926,#199e70,#c98500" --mode dark --surface "#161616"
```

`src/colors-custom.test.ts` parses the stylesheet and holds the structural half
of the above: both selectors define every slot and companion, slots are literal
hexes (never a `var()` alias that could drift when a ramp is re-stepped), slot 1
still equals `--color-accent-5` in both modes, no two slots share a value within
a mode, no slot equals a status value, and each `-soft` mixes from its own slot.
Hue _separation_ is not something the stylesheet can assert — that is the
validator's job, which is why re-stepping any slot means re-running it.

## References

- [global AGENTS.md](../AGENTS.md) — the project-agnostic rule these packages live by.
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — how tests here are written.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md) — TSDoc conventions.
