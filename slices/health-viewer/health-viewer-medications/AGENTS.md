# AGENTS.md — slices/health-viewer/health-viewer-medications

The health viewer's **medication source**: how a patient's FHIR R4
`MedicationRequest`s become plottable dose lines, exported as one
`SeriesSource` value — `medicationSource`. Reading a dose regimen off a request
is medication knowledge and lives in `medication-core/fhir`
(`medicationRequestsToDoseRegimens`); turning regimens into level series is
viewer knowledge and lives here. The chart math it feeds lives in
`health-viewer-fundamentals`.

## Shape

- `src/medication-series.ts` — `doseRegimensToSeries` (regimens →
  `MedicationSeries`: a `LevelSeries` plus its `key`, whose levels are
  `DoseLevel`s naming the request each was read from) and
  `medicationRequestsToSeries` (the descriptor's `read`: requests → regimens →
  series, with `medication-core`'s `undated` / `dropped` counts passed
  through). Also the presentation: the basis as each level's `note`, a dashed
  line while a request is `on-hold`, `/d` on a daily total's unit, and a
  `'from-zero'` axis.
- `src/medication-series-key.ts` — `MedicationSeriesKey` (`medication`,
  `doseUnit`, `doseBasis`) and its id grammar under the `m` prefix:
  `m:<medication>|<doseUnit>|<doseBasis>`, written through `SeriesId`.
- `src/medication-groups.ts` — the one catalogue group, `medications`
  (`Medications`), which every series files under.
- `src/source.ts` — `medicationSource`, the package's surface: `name:
'medications'`, `idPrefix: 'm'`, the group, the reader, the key grammar and
  the grouping, in one value.

## Rules

- **The medication id is external contract.**
  `m:<medication>|<doseUnit>|<doseBasis>` is what a shared URL carries, so
  changing the field order, the prefix, the basis spellings (`administration`,
  `d`) or `SeriesId`'s escaping invalidates every link a patient has already
  saved. `medication-series-key.test.ts` pins it against an independent
  spelling of the grammar. `parseMedicationSeriesId` never throws and reads
  only the spelling `medicationSeriesIdOf` writes.
- **Dose unit and dose basis are part of a series' identity.** 500 mg per dose
  and 1000 mg per day of one drug are two series on two scales, and so are
  one drug's doses in `mg` and in `mL`. Nothing converts between them. The
  series' `unit` shows the basis (`mg` per dose, `mg/d` per day, `/d` for a
  unitless daily total) so the catalogue can tell the two rows apart.
- **An unnamed request is its own series.** A regimen whose name normalises to
  nothing keys on `#<requestId>` — `normalizeName` writes only `[a-z0-9 ]`, so
  the fallback never collides with a real name, and unrelated unnamed requests
  never merge into one line.
- **The later request takes over from its start.** A series' levels sort by
  start; of regimens starting together the longer-running sorts later (an open
  one last), and full ties keep input order. Each level ends no later than the
  next one's start, so the levels a series holds never overlap.
- **Nothing disappears silently.** Every request moves at most one of
  `undated` / `dropped` in `medication-core`, and every regimen lands in
  exactly one level here.

## To confirm

Carried over from PR #768 and #774; each is the current behaviour until
decided otherwise.

- **Zero-length requests.** A later zero-length regimen (a completed refill
  with no end) clips an open active one at its start, per "the later request
  takes over". Keep, or skip zero-length levels when they would clip an open
  one?
- **On-hold with no end.** `medication-core` ends a non-active request with no
  stated end at its start, so an on-hold level is a point and its dash is
  invisible. Extend it to the next request's start, or to now?
- **`Timing.repeat.boundsPeriod`.** Not read as an end, so a 10-day course with
  no validity period or supply plots as open-ended. Read it in
  `medication-core`'s timing reader?
- **Unnamed requests.** Each is its own series (above), rather than one shared
  "unknown medication" series.

## References

- [slices/health-viewer/AGENTS.md](../AGENTS.md) — the slice and its packages.
- [health-viewer-fundamentals AGENTS.md](../health-viewer-fundamentals/AGENTS.md)
  — the vocabulary this package reads into.
- [health-viewer-observations AGENTS.md](../health-viewer-observations/AGENTS.md)
  — the sibling source this one mirrors.
- [medication AGENTS.md](../../medication/AGENTS.md) — `medication-core`,
  where dose regimens are read.
