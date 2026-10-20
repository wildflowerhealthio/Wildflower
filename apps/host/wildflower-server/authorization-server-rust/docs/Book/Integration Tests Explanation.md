# Integration Tests

The domain chapters show each rule on its own, against the fake store. The integration tests hold the whole server to its promises through the surface the outside world sees: HTTP. **Each test is one promise**, stated in the terms an app, a browser or the Owner would use ("a disabled client is refused", "a launch works once"), and checked by sending requests to the real router over a real database.

Nothing listens on a port. Each test builds the server's `axum` router over a fresh in-memory SQLite database, sends it requests one at a time with `tower`'s `oneshot`, and reads the responses. Every store, migration, seed, capability and route is the production one. The stand-ins are few: the database lives in memory, the tests mint their own tokens instead of earning them through a flow, and the authorization start gate admits everything unless a test passes its own.

## How they are run

All the files under `tests/integration/` build into one test binary, `integration`. Its `main.rs` only declares the modules, one per file, plus {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/main.rs common}}, the fixtures they share.

```sh
cargo test -p wildflowerhealthio-authorization-server --test integration
```

## How to read the sub-chapters

Each sub-chapter covers one test file. It opens with the part of the server's promise that file holds it to, then gives each test a section: its doc comment states the promise, then comes the test, then the domain and capability sections the promise rests on. The first test on a page to use a fixture links it on the [Test Fixtures](<Integration Tests/Test Fixtures Explanation.md>) page, which holds the shared fixtures and each file's own helpers.

The files follow the order the Domain part builds its concepts in. The first ones hold the server to its tokens: the signing key and the bearer gates ([Smoke](<Integration Tests/Smoke Explanation.md>), [Bearer Only](<Integration Tests/Bearer Only Explanation.md>), [Scope Gating](<Integration Tests/Scope Gating Explanation.md>), [Request Caller](<Integration Tests/Request Caller Explanation.md>)) and revoking them ([Revocation](<Integration Tests/Revocation Explanation.md>)). Then the Owner's own browser signs in ([Same-Device Sign-In](<Integration Tests/Same Device Sign In Explanation.md>)), and clients authenticate and are managed ([Client Auth](<Integration Tests/Client Auth Explanation.md>), [Client Management](<Integration Tests/Client Management Explanation.md>)). The authorization-code flow comes next, end to end in [Grant Flows](<Integration Tests/Grant Flows Explanation.md>), then door by door and page by page. The polled requests follow: devices and paired browsers. Last come what ends a browser's or an app's access, and the rules laid across the whole surface: cache suppression and the limit on starting requests.
