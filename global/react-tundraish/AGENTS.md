# AGENTS.md — global/react-tundraish

Tundra-CSS-styled React DOM primitives plus the palette every Wildflower surface
paints itself from. The palette lives in `src/colors-custom.css` — one `:root`
block for light, one `:root[data-color-scheme='dark']` block for dark, and no
`prefers-color-scheme` rule anywhere (both runtimes resolve the scheme in JS and
write the attribute; see `src/color-scheme.ts`).

## Categorical series tokens

`--color-series-1` … `--color-series-4` are the chart-identity slots, with
`--color-series-N-soft` as each slot's low-alpha band fill (`color-mix()` off
the same slot, so a re-stepped slot carries its band with it). Both sets are
defined in **both** palette blocks.

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
  the light canvas, so a light-mode chart ships visible direct labels or a table
  view; colour alone is not enough. Dark clears 3:1 on all four.
- **Four slots hold for stacks, bars, and lines only.** Those forms compare
  _adjacent_ slots. A scatter, bubble, choropleth, or small-multiples chart puts
  every pair on screen at once, and slot 4 (yellow) beside slot 2 (orange) fails
  there — those forms carry three series and fold the rest.

The four are validated as a **set** per mode against the page canvas
(`--color-canvas`: `#dedede` light, `#161616` dark) — lightness band, chroma
floor, protan/deutan ΔE, normal-vision ΔE, contrast. Changing one value means
re-running the validator over all four in both modes and snapping to a passing
step, not eyeballing the one slot:

```bash
node <dataviz-skill>/scripts/validate_palette.js \
  "#3d66d0,#eb6834,#1baf7a,#eda100" --mode light --surface "#dedede"
node <dataviz-skill>/scripts/validate_palette.js \
  "#426dd7,#d95926,#199e70,#c98500" --mode dark --surface "#161616"
```

`src/colors-custom.test.ts` parses the stylesheet and holds the structural half
of the above: both blocks define every slot and companion, slots are literal
hexes (never a `var()` alias that could drift when a ramp is re-stepped), no
hue repeats within a mode, no slot equals a status value, and each `-soft`
mixes from its own slot.

## References

- [global AGENTS.md](../AGENTS.md) — the project-agnostic rule these packages live by.
- [Testing Reference](../../docs/Testing/Testing%20Reference.md) — how tests here are written.
- [Doc Comments Reference](../../docs/Documentation/Doc%20Comments%20Reference.md) — TSDoc conventions.
