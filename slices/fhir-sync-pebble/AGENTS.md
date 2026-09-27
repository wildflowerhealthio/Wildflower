# AGENTS.md — slices/fhir-sync-pebble

**FHIR Sync for Pebble**: a Pebble watchapp that syncs the steps, sleep and
heart rate the Pebble records to any FHIR server. This slice holds what its
settings page decides; the page itself is
[`apps/fhir-sync-pebble-web`](../../apps/fhir-sync-pebble-web/AGENTS.md), and
the watchapp's PebbleKit JS is the consumer of the settings it hands off.

## Packages

- `fhir-sync-pebble-core` — the pure layer, and currently the whole slice.
  Three namespace modules, re-exported from the package index:
  `PebbleSettings` (the watch's wire shape, built from the SMART grant and the
  patient read), `ReturnTarget` (the allow-listed Pebble `return_to` and the
  hand-off URL), and `ReturnTargetStore` (keeps `return_to` across the SMART
  login over a Web Storage–shaped store the app passes in). No DOM, no React,
  no platform imports.

## Rules

- **The core owns every decision the hand-off makes.** What the watch receives,
  where it may be sent, and what survives the login are pure functions here,
  so they are property-tested without a DOM. The app reads the handshake and
  the patient, and renders what this package returns.
- **`PebbleSettings.toJson` is external contract.** It is what the watchapp's
  `webviewclosed` handler parses; change the shape together with the watchapp.
- **`ReturnTarget` is a security boundary.** The settings carry a live access
  token, so only the Pebble phone app's `pebblejs:` scheme and loopback
  `http(s)` (the `pebble` tool's emulator) decode. Widening the allow-list lets
  a crafted link collect a token for the user's record.
- **Storage is a parameter.** `ReturnTargetStore.fromWebStorage` takes a
  structural `WebStorage`, the way `gatekeeper-core`'s sign-in takes its
  `PendingStore`, so the core names no DOM type and the app is the one place
  `sessionStorage` appears.

## References

- [Architecture / slice layering](../AGENTS.md)
- [apps/fhir-sync-pebble-web AGENTS.md](../../apps/fhir-sync-pebble-web/AGENTS.md) — the settings page, the handoff steps, and the scopes
- [Property Testing Reference](../../docs/Testing/Property%20Testing%20Reference.md)
