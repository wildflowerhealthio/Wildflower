# AGENTS.md — apps/plots/plots-core-js

Plots' **assembly**: the closed list of domain sources a
patient's record is read through, and the decisions that span sources — the
catalogue panel, the x-axis range presets, the views a selection is shown in,
and the URL a selection is shared through. Chart math lives in `plots-fundamentals`; what a record means
lives in each domain package.

## Shape

- `src/series-sources.ts` — `SERIES_SOURCES` (the closed list:
  `observationSource`, then `medicationSource`), `readRecord` (hands each source its resources and
  files every series under the group the source names, summing the `undated` /
  `dropped` accounting), `CATALOG_GROUPS` (each source's groups, source by
  source) and `seriesKindOfId` (the kind of series an id names, through the
  source that can read it; `null` when none can).
- `src/catalog.ts` — `groupForPanel` (filed series → non-empty groups in
  `CATALOG_GROUPS` order, one row per series with its kind, count — readings,
  levels or spans — and span) and the
  search (`normaliseForSearch`, `matchesSearch`).
- `src/selection-url.ts` — `encodeSelection` / `decodeSelection`: series ids
  (opaque here, in selection order, distinct, and at most `ValueAxis.CAP`
  point or level series and `SpanSeries.LANE_CAP` span series, each counted by
  `seriesKindOfId`) and
  the range preset and the view as query parameters (`r`, `v`);
  `withSelection` writes them into a query that keeps every other key (the
  app's `?patient=`, which is `smart-app-react`'s). `selectionCapsOf` and `capIsFull` are that one
  counting rule, shared with the series panel.
- `src/plot-view.ts` — the views (`chart`, `table`, `scatter`);
  `scatterAxesOf`, which series a scatter of the selected ids plots (the
  first two point or level series, X then Y, lanes aside) or that there are
  too few or too many; and `shownViewOf`, the chart in place of a scatter the
  selection cannot make.
- `src/time-range.ts` — the range presets (`all`, `5y`, `1y`, `90d`, `28d`,
  `7d`, `24h`) and `xDomain`, the window a preset selects.

## Rules

- **Adding a domain is one entry in `SERIES_SOURCES`**, plus its resources on
  `RecordResources` and one line in `readRecord`. Prefixes and group ids must
  stay distinct across sources — `series-sources.test.ts` checks both.
- **Ids are opaque here.** The codec keeps an `s` parameter only when some
  source's `parseSeriesId` reads it — and asks that source's `seriesKindOf`
  which cap it counts against — and each parser only reads the spelling
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

- [apps/plots/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [plots-fundamentals AGENTS.md](../plots-fundamentals/AGENTS.md)
- [plots-observations AGENTS.md](../plots-observations/AGENTS.md)
- [plots-medications AGENTS.md](../plots-medications/AGENTS.md)
