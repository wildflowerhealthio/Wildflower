# AGENTS.md — apps/health-viewer/health-viewer-core-js

The health viewer's **assembly**: the closed list of domain sources a
patient's record is read through, and the decisions that span sources — the
catalogue panel, the x-axis range presets, and the URL a selection is shared
through. Chart math lives in `health-viewer-fundamentals`; what a record means
lives in each domain package.

## Shape

- `src/series-sources.ts` — `SERIES_SOURCES` (the closed list:
  `observationSource`, then `medicationSource`), `readRecord` (hands each source its resources and
  files every series under the group the source names, summing the `undated` /
  `dropped` accounting), `CATALOG_GROUPS` (each source's groups, source by
  source) and `isKnownSeriesId` (some source can read the id).
- `src/catalog.ts` — `groupForPanel` (filed series → non-empty groups in
  `CATALOG_GROUPS` order, one row per series with its kind, count and span) and the
  search (`normaliseForSearch`, `matchesSearch`).
- `src/selection-url.ts` — `encodeSelection` / `decodeSelection`: series ids
  (opaque here, in selection order, distinct and at most `ValueAxis.CAP`) and
  the range preset as query parameters; `withSelection` writes them into a
  query that keeps every other key (the app's `?patient=`, which is
  `smart-app-react`'s).
- `src/time-range.ts` — the range presets (`all`, `5y`, `1y`, `90d`, `28d`,
  `7d`, `24h`) and `xDomain`, the window a preset selects.

## Rules

- **Adding a domain is one entry in `SERIES_SOURCES`**, plus its resources on
  `RecordResources` and one line in `readRecord`. Prefixes and group ids must
  stay distinct across sources — `series-sources.test.ts` checks both.
- **Ids are opaque here.** The codec keeps an `s` parameter only when some
  source's `parseSeriesId` reads it, and each parser only reads the spelling
  its own `seriesIdOf` writes. An id whose source is not assembled — an
  unknown prefix — is dropped like any other stale entry, never raised.
- **Range presets stay here, not in fundamentals.** Which windows the viewer
  offers is a product choice the URL codec validates against, not plot
  vocabulary; the `TimeDomain` they produce is fundamentals'.
- **Search tokenizes locally rather than reusing `medication-core`'s
  `normalizeName`.** That one drops numbers and dosage units as matching noise,
  which is right for drug names and wrong here: `a1c`, `24h` and `mmol` are
  exactly what a reader types into a catalogue.
- **A series filed under an undeclared group throws.** A source whose
  `groupIdOf` names a group it does not declare would otherwise lose the
  series' row silently.

## References

- [apps/health-viewer/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [health-viewer-fundamentals AGENTS.md](../health-viewer-fundamentals/AGENTS.md)
- [health-viewer-observations AGENTS.md](../health-viewer-observations/AGENTS.md)
- [health-viewer-medications AGENTS.md](../health-viewer-medications/AGENTS.md)
