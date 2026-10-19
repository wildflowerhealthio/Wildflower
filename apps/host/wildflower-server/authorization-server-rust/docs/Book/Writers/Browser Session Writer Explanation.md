# Browser Session Writer

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs}}

A [browser session](<../Domain/Browser Session Explanation.md>) holds a grant, and the tokens minted under it name it as their `sid`. **Starting one takes the proof that the browser may hold it.** There are two ways in: the Owner signs in on the same device with a one-time code the base minted, or a browser the Owner approved at the pairing page claims its approval. Each has its proof, and the session the writer stores is the one the proof carries, built by the proof's constructor. The writer adds nothing to it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::within}}

`within` builds the writer over the caller's open write scope. In both flows the same scope then mints the session's token, so a session is never stored without its token, nor a token minted for a session that wasn't stored.

## `start_owner_session`

The Owner session a [redeemed same-device sign-in code](<../Authority/Same Device Sign In Explanation.md>) starts, holding the Owner's grant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::start_owner_session}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs tests::start_owner_session_stores_the_proof_s_session}}

A code redeemed for an Owner grant starts a session; the stored row is exactly the one the proof carries.

Exercised end to end by [`a_sign_in_starts_an_owner_session_its_token_names`](<../Integration Tests/Browser Sessions Explanation.md#a_sign_in_starts_an_owner_session_its_token_names>) and [`a_code_signs_in_once`](<../Integration Tests/Same Device Sign In Explanation.md#a_code_signs_in_once>).

## `start_approved_session`

The approved session a [claimed browser pairing](<../Authority/Browser Pairing Explanation.md>) starts, named after the browser and holding the scopes the Owner granted it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/browser_session_writer.rs BrowserSessionWriter::start_approved_session}}

No unit test of its own. Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>).
