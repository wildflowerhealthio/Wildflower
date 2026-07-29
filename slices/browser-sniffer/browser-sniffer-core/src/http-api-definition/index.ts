import { HttpApi } from '@effect/platform'
import * as Sniffer from './sniffer.ts'

/**
 * Browser-sniffer slice HTTP API — the `/sniffer` control endpoints a
 * collector client drives a sniffing session with (`OpenSnifferWebview`,
 * `SetSnifferStatus`, `ShowSnifferWebview`, `SendPageAction`,
 * `CancelSnifferRequest`, `DisposeSnifferWebview`).
 *
 * The host→client half of the surface — the captured-activity stream — is the
 * `/sniffer/events` WebSocket, which is deliberately NOT modeled here:
 * OpenAPI has no WebSocket operation shape. Its message contract is the
 * tagged-JSON schemas in `../messages.ts` (plus the `UserDismissed` /
 * `SnifferDisposed` lifecycle tags declared by the collector's transport),
 * pinned from the Rust side by tag drift-guard tests.
 *
 * ⚠️ **All endpoints drive an on-device webview and MUST be gated at the
 * composition site** (the Tauri host wraps the router with its gatekeeper
 * bearer gate). Each operation is additionally scope-gated in the Rust
 * handlers (`wildflower/Sniffer.c` for the control plane, `.r` for the event
 * stream).
 */
const BrowserSnifferApi = HttpApi.make('BrowserSnifferApi').add(Sniffer.httpApiGroup)

export { BrowserSnifferApi, Sniffer }
