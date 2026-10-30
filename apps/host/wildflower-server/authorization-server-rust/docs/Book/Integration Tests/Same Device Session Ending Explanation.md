# Same-Device Session Ending

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs}}

An Owner session a launch's sign-in started lasts only as long as the server's launch views stay open. The base ends it by the [sign-in code](<../Domain/Same Device Sign In Codes Explanation.md>) it opened the view with, through the server's current run, once the server's last launch view closes ([`SameDeviceSignInCodeMinter::end_signed_in_sessions`](<../Assembly/OAuth Bindings Explanation.md#item-SameDeviceSignInCodeMinter--end_signed_in_sessions>)), and a server start ends every same-device session but those of the launch views still open, as each is next used. **Ending a session expires it**, or, at a start, has the token verifier refuse it as an expired one: the browser's cookie no longer counts, so `/oauth/authorize` sends the browser to pairing, and the next launch's code signs it in again. A paired browser's session survives a start. The flow is the [same-device session ender](<../Capabilities/OAuth/Same Device Session Ender Explanation.md>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationsame_device_session_ending>) page, with the shared ones.

## `integration::same_device_session_ending`

### `closing_a_launch_ends_only_its_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs closing_a_launch_ends_only_its_session}}

Relies on [`SameDeviceSessionEnder::end_sessions_signed_in_with`](<../Capabilities/OAuth/Same Device Session Ender Explanation.md#item-SameDeviceSessionEnder--end_sessions_signed_in_with>) and [`ensure_own_session_live`](<../Capabilities/Session/Token Verifier Explanation.md#item-ensure_own_session_live>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`launch`](<Test Fixtures Explanation.md#item-launch>), [`authorize_destination`](<Test Fixtures Explanation.md#item-authorize_destination>), [`is_consent_card`](<Test Fixtures Explanation.md#item-is_consent_card>), [`is_pairing_page`](<Test Fixtures Explanation.md#item-is_pairing_page>), [`stored_session`](<Test Fixtures Explanation.md#item-stored_session>), [`sid_of`](<Test Fixtures Explanation.md#item-same_device_session_ending--sid_of>) and [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>).

### `a_code_that_signed_nobody_in_ends_nothing_and_is_withdrawn`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs a_code_that_signed_nobody_in_ends_nothing_and_is_withdrawn}}

### `a_second_launch_reaches_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs a_second_launch_reaches_consent}}

### `a_restart_ends_same_device_sessions_but_open_views_and_paired_ones`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs a_restart_ends_same_device_sessions_but_open_views_and_paired_ones}}

Relies on [`EndedAtRunStart`](<../Capabilities/OAuth/Same Device Session Ender Explanation.md#item-EndedAtRunStart>). Fixtures first used here: [`restart`](<Test Fixtures Explanation.md#item-restart>).
