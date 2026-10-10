# AGENTS.md — fhir-utility

Small FHIR-shaped helpers reused across slices. Does **not** import the
`fhir-r4` wire schemas — every export speaks in plain field shapes (each slot
nullable to mirror the resource that would feed in), so a caller can hand it
either a decoded resource or its own mirror of the same slot.

## Today

- `supplyDurationToParts(supply)` — parse a `SupplyDuration` (`value` + UCUM
  `code` and/or spelled `unit`) into an Effect `DateTime.add` parts object.
  Rounded to an integer, day-fallback for an unknown or absent unit, `null`
  for a non-positive or absent value. UCUM codes take precedence over the
  spelled unit when both are set.
- `SupplyDuration` — the plain shape the parser reads: mirrors FHIR
  `MedicationRequest.dispenseRequest.expectedSupplyDuration` and
  `MedicationDispense.daysSupply`, without importing their schemas.
- `UCUM_UNIT` / `SPELLED_UNIT` — the lookup tables, exported so a consumer
  can extend the vocabulary in place rather than reimplementing it.

## Rules

- **No FHIR wire imports.** This package sits _beside_ `fhir-r4`, not above
  it. If a helper needs the decoded resource type, add its plain field
  mirror here (as `SupplyDuration` does for `Duration`) and the caller does
  the resource-to-shape reshape at its own call site.
- **Additions are helpers many slices need, not one.** A one-off parser
  lives in the slice that reads it. Something two slices reach for is the
  reason this package exists.

## References

- [Architecture / slice layering](../../AGENTS.md)
- [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md)
