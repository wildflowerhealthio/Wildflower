# AGENTS.md — slices/authorization

OAuth 2.0 / SMART-on-FHIR authorization slice. Read the [Jargon Explanation](./docs/Jargon%20Explanation.md) before touching auth flows — the domain vocabulary is precise and reviewers hold names to it.

The slice is the TypeScript half every signing-in app shares: `authorization-core` and `authorization-react`. The server, `authorization-server-rust`, and the revocation store it shares with the FHIR server, `token-revocation-rust`, are used by the host alone, so they live in [`apps/host/wildflower-server/`](../../apps/host/wildflower-server/AGENTS.md); `authorization-server-rust/…` paths below are relative to that folder.

## Guardrails

- **Page paths have one source**: `authorization-core/src/page-paths.ts`, drift-tested against the route tree by `authorization-react/src/routes.test.tsx`. Changing a route means changing both together — the drift test fails otherwise.

## Traps

- The bootstrap-URL / `?token=` minting path is **dev-only** (NODE_ENV-gated) — not a shipping pattern to extend.
- The bearer store keeps its token in page memory only — see the [Auth Token Storage Explanation](./docs/Auth%20Token%20Storage%20Explanation.md) before changing where it lives.
- `authorization-server-rust` has a committed OpenAPI snapshot, which `authorization-core`'s drift test and `generate:openapi-schemas` read across folders; regenerate a stale one per the [OpenAPI Spec Drift How-To](../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md).

## References

- [Scope-Gated Endpoints How-To](../../docs/Authorization/Scope-Gated%20Endpoints%20How-To.md) — the `/authorization` surface's scope-gated `Scoped<F>`/capability pattern (machinery shared from `scopes/scope-capabilities-rust`); `domain/capabilities/access/` is the worked fixed-scope example (capabilities generic over the store port, bound to the concrete store in `src/live_bindings/`); `domain/capabilities/session/` the authenticated-only one; `domain/capabilities/oauth/` the pre-auth front door, acquired through the `Live<…>` extractor
- **Authority proofs** — every privileged write (approve a request, issue a code, record a grant, mint a token, issue a refresh token) happens in a `domain/capabilities/writers/` method that takes a proof type from `domain/authority/` (`AuthenticatedClient`, `DelegatedScopes`, `StandingGrantCoverage`, the redemptions, `HostOwnerEntitlement`). Audit by reading each proof's single constructor and each writer; source guards pin the privileged store methods to the writers, the host-owner entitlement to `seeding.rs`, and every handler and middleware file to the capability extractors. See the How-To's "Authority proofs" section
- [authorization-core README](./authorization-core/README.md) — tables, OAuth routes, page-path drift test
- [Jargon Explanation](./docs/Jargon%20Explanation.md) — the domain vocabulary
- [Auth Token Storage Explanation](./docs/Auth%20Token%20Storage%20Explanation.md) — token storage policies
- [Retention Explanation](../../apps/host/wildflower-server/authorization-server-rust/docs/Retention%20Explanation.md) — the 90-day / 7-day windows, why they are measured past `expires_at`, and the startup+daily sweep that applies them
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) — the webview ↔ host bridge this slice speaks over
