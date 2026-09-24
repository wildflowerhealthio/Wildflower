//! The gatekeeper's domain vocabulary — pure types and business rules
//! shared by every other layer. No `crate::http` dependency runs here — the
//! domain types carry diesel derives that name their [`crate::db`] `table!` for
//! the bind/read mapping, but no transport code lives in this layer: the
//! [`GatekeeperStore`] port abstracts persistence ([`crate::db`]'s
//! `SqliteGatekeeperStore` owns the SQL behind it); the store-touching logic
//! lives with each entity module (the refresh-token rotation, the session
//! revoke) or inside a [`capabilities`] capability (the scope-gated `/access`
//! operations, generic over the store port); and everything fails with the
//! domain's own [`gatekeeper_error`] vocabulary. Persistence mappings live in
//! [`crate::db`], transport in [`crate::http`], the router state (which builds
//! the capabilities) in [`crate::live_bindings`].

// The persistence port. Mirrors collector's `remotes_store`.
pub mod gatekeeper_store;

// The authority proofs every privileged write demands — the typed answer to "on
// what authority is this row written?". Constructed only by the one function
// that checks the rule each proof stands for.
pub(crate) mod authority;

// The capabilities, generic over the store port: the scope-gated `/access`
// surface (`access/`), the pre-auth `/oauth` front door (`oauth/`), the
// caller's own session (`session/`), and the proof-gated privileged writers
// (`writers/`). The bindings to the concrete state live in
// `crate::live_bindings`.
pub(crate) mod capabilities;

// The in-memory `FakeGatekeeperStore` + fixtures the domain unit tests share.
#[cfg(test)]
pub(crate) mod test_fake;

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
// The `client_id` / `client_secret` pair a client presents (RFC 6749 §2.3.1),
// zeroized on drop; how it arrived is the HTTP layer's `PresentedCredentials`.
pub mod client_credentials;
// Pure builders for the OAuth client-callback URLs (`redirect_uri` + `code`/`error`
// + `state`) — no axum/store coupling, so the `/oauth` surface and the Owner
// consent action can return the same URL. Lifted out of `http::routes::oauth`.
pub mod client_redirect;
// The trust-on-first-use registration verdict: how a pending authorization-code
// request compares against the `clients` row it names right now. Derived on every
// read, never stored, so `/authorize` and the consent surfaces agree.
pub(crate) mod client_registration;
// The domain's failure vocabulary (collector's `RemoteError` is the model):
// semantic client-facing variants plus the opaque `Infrastructure`.
pub mod gatekeeper_error;
pub mod grant;
// The closed set of OAuth error codes (RFC 6749 §5.2 + the redirect/device
// codes) — a pure domain vocabulary lifted out of the OAuth route tree so the
// error model can name it without reaching into `http`.
pub mod oauth_error_code;
// The `/oauth/authorize` failures rendered as a local page rather than a
// redirect; the HTML lives in `http::errors`.
pub mod oauth_error_kind;
// URL/path builders for the gatekeeper's user-facing `/gatekeeper/*` webview
// pages — pure string builders (no axum/state), duplicated TS ⇄ Rust and
// drift-tested against `gatekeeper-core/src/page-paths.ts`.
pub mod page_paths;
// The head of the single pending-consent queue the host popup surfaces —
// device-code and authorization-code requests share one FIFO slot, so the head
// carries whichever key its consent surface reads by.
pub mod pending_consent;
pub mod refresh_token;
// The retention windows for the three accumulating tables plus the sweep that
// applies them — the policy half of the startup/daily reaper `setup_gatekeeper`
// spawns. Lives here (not in `db`) because the windows are a domain decision;
// the store only takes cutoffs.
pub mod retention;
// The logout session-token revoke over the `Revocation` port.
pub(crate) mod session;
pub mod signing_key;
pub mod token;
// The `/oauth/token` failure vocabulary: specific reasons the HTTP layer
// collapses onto the generic RFC 6749 §5.2 descriptions.
pub(crate) mod token_exchange_error;

pub use authorization_code::PendingCodeRequest;
pub use gatekeeper_store::{GatekeeperStore, GatekeeperTx};

/// Shared helpers for the crate's **source-guard** tests — the advisory-strength
/// tests that enumerate source files and assert a textual invariant (a handler
/// never names the store, a privileged call never leaves the writers, a proof is
/// constructed in one place). One enumerator, so every guard walks the tree the
/// same way.
#[cfg(test)]
pub(crate) mod source_guard {
    use std::path::{Path, PathBuf};

    /// Every `.rs` file under `dir`, recursively, sorted for stable failures.
    pub(crate) fn rs_files_under(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("readable dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files.sort();
        files
    }

    /// `path` relative to `root`, with forward slashes, for matching against the
    /// guards' allow-lists.
    pub(crate) fn relative_to(path: &Path, root: &Path) -> String {
        path.strip_prefix(root)
            .expect("enumerated under root")
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// The production code of a source file, one entry per line that has any,
    /// numbered from 1. A guard scans these: comments and string literals may
    /// name anything (they are blanked out, so a trailing `// …` never trips a
    /// needle), and every `#[cfg(test)]`-gated item — the unit-test module, a
    /// test-only helper method, a test-only `use` — may arrange state directly
    /// (planting rows, constructing proofs) without being the production path
    /// the guard exists to pin. Only the gated item itself is skipped, so
    /// production code after it is still scanned.
    pub(crate) fn production_lines(source: &str) -> Vec<(usize, String)> {
        let code = code_only(source);
        let test_items = cfg_test_items(&code);
        code.iter()
            .enumerate()
            .filter(|(i, _)| !test_items.iter().any(|item| item.lines.contains(i)))
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(i, line)| (i + 1, line.clone()))
            .collect()
    }

    /// The line (numbered from 1) of the first production code after the file's
    /// inline unit-test module (`#[cfg(test)] mod … { … }`), or `None` when the
    /// test module comes last. Production code belongs above the tests, so a
    /// reader who reaches the test module has seen the whole implementation.
    pub(crate) fn production_code_after_test_module(source: &str) -> Option<usize> {
        let code = code_only(source);
        let test_items = cfg_test_items(&code);
        let first_module_end = test_items
            .iter()
            .find(|item| item.is_inline_module)?
            .lines
            .end;
        (first_module_end..code.len())
            .filter(|i| !test_items.iter().any(|item| item.lines.contains(i)))
            .find(|&i| !code[i].trim().is_empty())
            .map(|i| i + 1)
    }

    /// One `#[cfg(test)]`-gated item: its lines (the attribute through the
    /// item's closing `}` or `;`, 0-based, end exclusive), and whether it is an
    /// inline `mod … { … }`.
    struct CfgTestItem {
        lines: std::ops::Range<usize>,
        is_inline_module: bool,
    }

    /// Every `#[cfg(test)]`-gated item in `code` (the output of [`code_only`],
    /// so braces inside comments and strings are already gone).
    fn cfg_test_items(code: &[String]) -> Vec<CfgTestItem> {
        let mut items = Vec::new();
        let mut i = 0;
        while i < code.len() {
            if code[i].trim() != "#[cfg(test)]" {
                i += 1;
                continue;
            }
            let start = i;
            // Skip any further attributes and blank lines to the item itself.
            let mut item_start = i + 1;
            while item_start < code.len() {
                let trimmed = code[item_start].trim();
                if trimmed.is_empty() || trimmed.starts_with("#[") {
                    item_start += 1;
                } else {
                    break;
                }
            }
            let end = item_end(code, item_start);
            let is_inline_module = code
                .get(item_start)
                .is_some_and(|line| is_mod_header(line) && line.contains('{'));
            items.push(CfgTestItem {
                lines: start..end,
                is_inline_module,
            });
            i = end;
        }
        items
    }

    /// The line after the item that starts at `start`: the line where its
    /// braces balance again, or — for a braceless item (`use …;`, `mod x;`) —
    /// the line holding its terminating `;`.
    fn item_end(code: &[String], start: usize) -> usize {
        let mut depth: usize = 0;
        let mut opened = false;
        for (i, line) in code.iter().enumerate().skip(start) {
            for ch in line.chars() {
                match ch {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth = depth.saturating_sub(1),
                    ';' if !opened => return i + 1,
                    _ => {}
                }
            }
            if opened && depth == 0 {
                return i + 1;
            }
        }
        code.len()
    }

    /// Whether `line` opens a module declaration (`mod x`, `pub mod x`,
    /// `pub(crate) mod x`, …).
    fn is_mod_header(line: &str) -> bool {
        let trimmed = line.trim_start();
        let after_visibility = if let Some(rest) = trimmed.strip_prefix("pub") {
            let rest = rest.trim_start();
            match rest.strip_prefix('(') {
                Some(scoped) => scoped.split_once(')').map_or(rest, |(_, after)| after),
                None => rest,
            }
        } else {
            trimmed
        };
        after_visibility.trim_start().starts_with("mod ")
    }

    /// `source`, line for line, with every comment and every string / char
    /// literal replaced by spaces, so what remains is code alone. Handles
    /// line and (nested) block comments, escaped and raw strings (`r#"…"#`,
    /// byte variants), and tells a char literal (`'{'`) from a lifetime
    /// (`'a`).
    pub(crate) fn code_only(source: &str) -> Vec<String> {
        let chars: Vec<char> = source.chars().collect();
        let mut out = String::with_capacity(source.len());
        let mut i = 0;
        let blank = |c: char| if c == '\n' { '\n' } else { ' ' };
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            if c == '/' && next == Some('/') {
                while i < chars.len() && chars[i] != '\n' {
                    out.push(' ');
                    i += 1;
                }
            } else if c == '/' && next == Some('*') {
                let mut depth = 0;
                while i < chars.len() {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        depth += 1;
                        out.push_str("  ");
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        out.push_str("  ");
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        out.push(blank(chars[i]));
                        i += 1;
                    }
                }
            } else if let Some(hashes) = raw_string_hashes(&chars, i) {
                // `r`/`br`, the hashes, the opening quote, then up to the
                // closing quote followed by as many hashes.
                let mut j = i;
                while chars[j] != '"' {
                    j += 1;
                }
                j += 1;
                let closing: Vec<char> = std::iter::once('"')
                    .chain(std::iter::repeat_n('#', hashes))
                    .collect();
                while j < chars.len() && !chars[j..].starts_with(&closing) {
                    j += 1;
                }
                let end = (j + closing.len()).min(chars.len());
                out.extend(chars[i..end].iter().map(|&c| blank(c)));
                i = end;
            } else if c == '"' {
                out.push(' ');
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' {
                        out.push(' ');
                        i += 1;
                    }
                    if let Some(&escaped) = chars.get(i) {
                        out.push(blank(escaped));
                    }
                    i += 1;
                }
                out.push(' ');
                i += 1;
            } else if c == '\'' {
                // A char literal is `'x'` or `'\…'`; anything else is a lifetime.
                let literal_len = match next {
                    // Past the escaped char, so `'\''` closes on its last quote.
                    Some('\\') => chars
                        .get(i + 3..)
                        .and_then(|rest| rest.iter().position(|&c| c == '\''))
                        .map(|close| close + 4),
                    Some(_) if chars.get(i + 2) == Some(&'\'') => Some(3),
                    _ => None,
                };
                match literal_len {
                    Some(len) => {
                        out.extend(std::iter::repeat_n(' ', len));
                        i += len;
                    }
                    None => {
                        out.push(c);
                        i += 1;
                    }
                }
            } else {
                out.push(c);
                i += 1;
            }
        }
        out.lines().map(str::to_owned).collect()
    }

    /// The number of `#`s when a raw string literal (`r"…"`, `r#"…"#`,
    /// `br#"…"#`) starts at `i`, else `None`. An identifier that merely ends in
    /// `r` (`for`, `bar#`) is not a raw string.
    fn raw_string_hashes(chars: &[char], i: usize) -> Option<usize> {
        let prefix_len = match (chars.get(i), chars.get(i + 1)) {
            (Some('r'), _) => 1,
            (Some('b'), Some('r')) => 2,
            _ => return None,
        };
        let preceded_by_ident = i
            .checked_sub(1)
            .and_then(|p| chars.get(p))
            .is_some_and(|&p| p.is_alphanumeric() || p == '_');
        if preceded_by_ident {
            return None;
        }
        let hashes = chars[i + prefix_len..]
            .iter()
            .take_while(|&&c| c == '#')
            .count();
        (chars.get(i + prefix_len + hashes) == Some(&'"')).then_some(hashes)
    }

    mod tests {
        use super::{code_only, production_code_after_test_module, production_lines};

        fn scanned(source: &str) -> Vec<(usize, String)> {
            production_lines(source)
                .into_iter()
                .map(|(n, line)| (n, line.trim().to_owned()))
                .collect()
        }

        /// Comments and literals are blanked, so only code reaches a needle.
        #[test]
        fn code_only_blanks_comments_and_literals() {
            let source = "let a = \"x.store\"; // .store\n\
                          /* .store { */ let b = '{';\n\
                          let c = r#\"a \" .store\"#; fn f<'a>(x: &'a str) {}";
            let code = code_only(source);
            assert_eq!(code.len(), 3);
            assert!(code.iter().all(|line| !line.contains(".store")));
            assert!(!code[1].contains('{'), "a char literal brace is not code");
            assert!(code[2].contains("'a"), "a lifetime is kept");
            let escaped = code_only("let q = '\\''; let r = '\\n'; x.store");
            assert_eq!(escaped[0].trim_end(), "let q =     ; let r =     ; x.store");
        }

        /// A test-only method in the middle of an `impl` is skipped, and the
        /// production code after it is still scanned — the scan does not stop
        /// at the first `#[cfg(test)]`.
        #[test]
        fn skips_only_the_gated_item() {
            let source = "impl S {\n\
                          #[cfg(test)]\n\
                          fn helper() { tx.upsert_client(); }\n\
                          fn prod() { tx.upsert_client(); }\n\
                          }";
            let lines = scanned(source);
            assert!(
                lines.iter().all(|(n, _)| *n != 3),
                "the gated fn is skipped"
            );
            assert!(lines.contains(&(4, "fn prod() { tx.upsert_client(); }".to_owned())));
        }

        /// A braceless gated item (`#[cfg(test)] mod x;`, `use …;`) skips just
        /// that item.
        #[test]
        fn skips_a_braceless_gated_item() {
            let source = "#[cfg(test)]\nmod fake;\n#[cfg(test)]\nuse a::b;\nfn prod() {}";
            assert_eq!(scanned(source), vec![(5, "fn prod() {}".to_owned())]);
        }

        /// Production code below the unit-test module is reported; a file whose
        /// tests come last, or that has none, is not. A braceless gated `mod x;`
        /// above the code is not a test module.
        #[test]
        fn reports_production_code_after_the_test_module() {
            let tests_last = "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() {}\n}\n";
            assert_eq!(production_code_after_test_module(tests_last), None);
            assert_eq!(production_code_after_test_module("fn a() {}"), None);
            let gated_decl = "#[cfg(test)]\nmod fake;\nfn a() {}";
            assert_eq!(production_code_after_test_module(gated_decl), None);

            let code_after = "#[cfg(test)]\nmod tests {\n}\n\n// prose\nimpl S {}\n";
            assert_eq!(production_code_after_test_module(code_after), Some(6));
            let second_module_is_fine = "#[cfg(test)]\nmod a {\n}\n#[cfg(test)]\nmod b {\n}\n";
            assert_eq!(
                production_code_after_test_module(second_module_is_fine),
                None
            );
        }
    }
}

#[cfg(test)]
mod test_layout_guard {
    use super::source_guard::{production_code_after_test_module, relative_to, rs_files_under};

    /// Production code goes above the unit-test module: a reader (or a
    /// reviewer) who reaches `#[cfg(test)] mod tests` has then seen the whole
    /// implementation. This test enumerates `src/` and fails on any file with
    /// production code after its test module.
    #[test]
    fn production_code_precedes_the_test_module() {
        let src = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut violations = Vec::new();
        for path in rs_files_under(src) {
            let relative = relative_to(&path, src);
            let source =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
            if let Some(line) = production_code_after_test_module(&source) {
                violations.push(format!("{relative}:{line}"));
            }
        }
        assert!(
            violations.is_empty(),
            "production code after the unit-test module (move it above the tests): {violations:?}",
        );
    }
}

#[cfg(test)]
mod http_free_guard {
    use super::source_guard::{production_lines, rs_files_under};

    /// `domain/` must never depend on `crate::http` — the capabilities live here
    /// and are built from `crate::live_bindings`, so a stray `use crate::http::…` would
    /// re-couple the domain to the transport layer. This test enumerates the
    /// `domain/` tree and fails if any non-comment line names `crate::http`, so
    /// the invariant can't silently regress.
    #[test]
    fn domain_never_references_crate_http() {
        // Assembled from parts so this guard's own source doesn't contain the
        // literal it scans for (which would make it flag itself).
        let needle = concat!("crate", "::", "http");
        let domain_dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/domain"));
        for path in rs_files_under(domain_dir) {
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            for (n, line) in production_lines(&source) {
                assert!(
                    !line.contains(needle),
                    "domain/ file {} line {n} imports the transport layer (`{needle}`) — domain \
                     must stay transport-free; route the dependency through a port or `crate::live_bindings`",
                    path.display(),
                );
            }
        }
    }
}
