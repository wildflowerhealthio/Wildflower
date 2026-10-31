# Session Shortfall

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs}}

A browser paired with read-only access may run an app that asks for write. A code earned in that browser carries only what its session holds, so **the person at the browser is told first, on the limited page, before the Owner is asked anything**. The [code authorization starter](<Code Authorization Starter Explanation.md>) parks such a request [awaiting the limited page](<../../Domain/Authorization Request/Code Request Explanation.md#the-limited-page>) and sends the browser there. The page reads what the session lacks, and the person goes on (the starter's [`continue_past_session_shortfall`](<Code Authorization Starter Explanation.md#item-CodeAuthorizationStarter--continue_past_session_shortfall>)) or cancels (here).

**Every operation answers only the browser session the request was made in**, so a leaked request id reads, continues and cancels nothing. No scope opens the capability: the caller is the browser that made the request, known by its browser session's `sid`. **What the session holds is read from its row**, not from its token, so a session the Owner widened since ([session widening](<Session Widening Explanation.md>)) lacks only what it still lacks, before the browser has taken its wider token.

The tests park code requests from the [session shortfall fixtures](<../Test Fixtures Explanation.md#session-shortfall>).

## `domain::capabilities::oauth::session_shortfall`

### `SessionShortfallView`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfallView}}

### `load_code_request_awaiting_limited_page`

The one load the page's read, its Cancel and the starter's Continue share.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs load_code_request_awaiting_limited_page tests="tests::only_the_requesting_session_reads_a_request_still_waiting_on_its_page"}}

### `browser_session_grant`

The one read of what a session holds, shared with the [code authorization starter](<Code Authorization Starter Explanation.md>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs browser_session_grant}}

### `SessionShortfall`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::new}}

#### `read`

The missing scopes come from {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}. `openid` isn't held access, so a session never lacks it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::read tests="tests::the_read_names_the_app_and_what_the_session_lacks tests::the_read_takes_what_the_session_holds_from_its_row_now"}}

#### `cancel`

The denial is the request's own [`deny_on_limited_page`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--deny_on_limited_page>), written through the [guarded replace](<../../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>). In the race test, the Cancel's denial, built from its earlier read, is still a valid transition on paper, but its replace finds the row gone on past the page and writes nothing.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_shortfall.rs SessionShortfall::cancel tests="tests::cancel_denies_the_request_and_answers_access_denied tests::a_cancel_racing_a_continue_leaves_the_continued_request_alone"}}
