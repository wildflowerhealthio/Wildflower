# Session Widening

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs self}}

The Owner's side is the [session widening consents](<../Capabilities/Access/Session Widening Consents Explanation.md>); the browser's, the [session widening](<../Capabilities/OAuth/Session Widening Explanation.md>) capability, over the [session widening routes](<../HTTP/Routes/Session Widening Routes Explanation.md>).

## `integration::session_widening`

### `an_approved_widening_lets_the_next_code_carry_what_the_session_lacked`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs an_approved_widening_lets_the_next_code_carry_what_the_session_lacked}}

### `a_declined_widening_leaves_the_session_as_it_was`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs a_declined_widening_leaves_the_session_as_it_was}}

### `another_browser_can_neither_ask_nor_poll`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs another_browser_can_neither_ask_nor_poll}}

### This file's fixtures

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs app_query_prompting_consent}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs seed_app}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs limited_browser}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs post_with_session}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs as_owner}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs ask_to_widen}}

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_widening.rs session_token_set_by}}
