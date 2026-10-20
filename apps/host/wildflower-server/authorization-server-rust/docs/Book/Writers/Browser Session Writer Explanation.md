# Browser Session Writer

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs}}

A [browser session](<../Domain/Browser Session Explanation.md>) holds a grant, and the tokens minted under it name it as their `sid`. **Starting one takes the proof that the browser may hold it.** There are two ways in: the Owner signs in on the same device with a code the base minted, or a browser the Owner approved claims its pairing. Each has its proof, and the session the writer stores is the one the proof carries, built by the proof's constructor. The writer adds nothing to it.

In both flows the same write scope then mints the session's token with the [access-token minter](<Access Token Minter Explanation.md>), so a session is never stored without its token, nor a token minted for a session that wasn't stored.

## `domain::capabilities::writers::browser_session_writer`

### `BrowserSessionWriter`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter}}

#### `within`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::within}}

#### `start_same_device_session`

The session a [redeemed same-device sign-in code](<../Authority/Same Device Sign In Explanation.md#item-RedeemedSameDeviceSignInCode>) starts.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::start_same_device_session tests="tests::start_same_device_session_stores_the_proof_s_session"}}

End to end, the [Browser Sessions](<../Integration Tests/Browser Sessions Explanation.md>) and [Same-Device Sign-In](<../Integration Tests/Same Device Sign In Explanation.md>) tests hold a sign-in to starting the session its token names.

#### `start_paired_session`

The session a [claimed browser pairing](<../Authority/Browser Pairing Explanation.md#item-ClaimedBrowserPairing>) starts. It has no unit test of its own; the [Browser Pairing](<../Integration Tests/Browser Pairing Explanation.md>) tests hold it end to end.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::start_paired_session}}
