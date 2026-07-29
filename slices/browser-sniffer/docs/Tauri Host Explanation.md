# Tauri Host Explanation

How the browser-sniffer slice's host side is layered: `browser-sniffer-rust`
(the pure-Axum `/sniffer` HTTP surface) and `browser-sniffer-tauri-rust` (the
Tauri adapter behind it), running the sniffer inside a native webview presented
by [`tauri-plugin-native-webview`](../../../plugins/tauri-plugin-native-webview/docs/Explanation.md)
— on iOS, Android, and desktop alike.

## The two crates

- **`browser-sniffer-rust`** — the slice's HTTP surface, with no Tauri
  dependency. The `/sniffer` REST control plane (open/navigate, status,
  visibility, page actions, cancellations, dispose), the `/sniffer/events`
  WebSocket that streams captured activity, the `wildflower/Sniffer.{c,r}`
  scope-gated capabilities, and the committed OpenAPI snapshot. It drives the
  host through the `SnifferWebviewHandle` port and fans out whatever the host
  publishes into its `SnifferEvents` broadcast channel.
- **`browser-sniffer-tauri-rust`** — the Tauri adapter:
  `TauriSnifferWebviewHandle` implements the port over the native-webview
  plugin, and `attach_browser_sniffer` wires the page→host side (the plugin
  channel + the desktop data-plane command) into the `SnifferEvents` stream.

This replaced the collector's Tauri `BRIDGE_EVENT` control/data planes: any
HTTP client holding the right scopes — the SPA on-device, or a browser
reaching the phone through the tunnel — can drive a collection run.

## The control plane (client → host)

| Endpoint                                                    | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sniffer/webview`                                     | Validate the `WebViewSource` and present the sniffer's native webview: `native_webview().open_url(...)` (navigate, building hidden if absent) then `show()`. Idempotent-in-place: a call while it is up rebinds the existing native webview (channel + initScript + chrome + URL — see "Re-wire" below). Replaces the bridge's `RequestSniffableWebView` **and** `Open` (identical host effect). A rejected source is now a modelled `400 InvalidSource` — the bridge could only warn-and-drop. |
| `DELETE /sniffer/webview`                                   | Dispose the native webview — the sniff is done, its background runtime is torn down and resources freed. Replaces `SniffingComplete`; still strictly client-driven and terminal.                                                                                                                                                                                                                                                                                                                |
| `PUT /sniffer/status`                                       | Write the per-step label to the sniffer chrome **subtitle** via `patch_window_text` ("Entering email", "Waiting for prescriptions to load"). Replaces `SetSnifferStatus`.                                                                                                                                                                                                                                                                                                                       |
| `POST /sniffer/visibility`                                  | (Re-)present the existing native webview via `show()` — the collector's fire-and-advance `EnsureWindowVisible` step. Does **not** navigate; idempotent no-op when none exists (`show` can't distinguish "absent" from "already visible", so a 204 acknowledges dispatch, not that a window appeared). Replaces `EnsureSnifferVisible`.                                                                                                                                                          |
| `POST /sniffer/page-actions`, `POST /sniffer/cancellations` | Forwarded **into** the sniffed page via `native_webview().evaluate_js(...)` calling the page's `window.__nativeWebviewReceive` — on every platform (the bridge era had a desktop direct-bus path; HTTP clients have no bus). `PageAction` carries the scripted interaction (`Click` / `Fill`, demuxed page-side by `action.kind`).                                                                                                                                                              |

Every control endpoint is gated by `wildflower/Sniffer.c` (`Scoped<SnifferDriver>`),
behind the host's gatekeeper bearer gate like the rest of the admin API.

## The data plane (host → client)

The `/sniffer/events` WebSocket (gated by `wildflower/Sniffer.r`) streams every
host→client event as tagged JSON in publish order — **one socket, all tags**,
because cross-tag FIFO is load-bearing: the chunked page-content stream
interleaves `ResponseStart` / `ResponseData` / `ResponseFinished` with
`PageLoaded`, and the collector's tracker depends on their order. A lagging
subscriber is closed with an error rather than silently resumed (dropped
chunks would corrupt reassembly).

The page→host leg is host-mediated on **both** platforms: the content webview
loads untrusted third-party content, so its `ResponseStart` / `ResponseData` /
`PageLoaded` / etc. never reach the event stream straight from the page — the
host allowlists the inner `_tag` (the data-plane set, excluding
control/lifecycle tags) and publishes into the `SnifferEvents` channel. Two
transports, one gate:

- **Mobile**: the native webview's native bridge
  (`webkit.messageHandlers.nativeWebview` / `window.nativeWebview`) into the
  plugin's `Channel<NativeWebviewEvent>` → `native_webview_bridge::dispatch_body`
  → `validate_native_webview_message` (allowlist + duplicate-key rejection) →
  `events.publish(...)`.
- **Desktop**: the content webview is a Tauri webview but holds **no event-bus
  grants at all**; its data plane rides the `native_webview_data_plane_emit`
  command → `data_plane_value_is_allowed` (the same allowlist) →
  `events.publish(...)`.

### Why the content webview gets no bus or HTTP path

The sniffed page is arbitrary third-party content. If it could publish
control or lifecycle tags it could forge `UserDismissed` / `SnifferDisposed`
(cutting an `AwaitUserDismiss` hold short and ending collection early). So:

- the two host-synthesized lifecycle tags are **excluded** from the page
  allowlist by construction (`spoofed_control_tag_is_rejected` /
  `desktop_data_plane_rejects_spoofed_control_tags` pin this);
- the page never talks HTTP to the `/sniffer` surface — its only outbound is
  the gated command/channel, and its only inbound is the Rust-initiated
  `evaluate_js`, which bypasses capabilities and can't be reached from page
  script;
- the client→host direction is protected separately by the gatekeeper bearer
  gate + `wildflower/Sniffer.c` scope on the REST endpoints.

## Why the plugin and not `WebviewWindow`

The sniffer used to present the external URL in a Tauri `WebviewWindow`,
drawing fake browser chrome in-page and exposing the **entire**
