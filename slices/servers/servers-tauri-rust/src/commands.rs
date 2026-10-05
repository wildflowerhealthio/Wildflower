//! The servers commands: thin wrappers that parse their arguments, call
//! [`servers_rust`]'s enrolment with a [`RelaySiteClient`] for the relay's
//! site, and log the outcome by domain.

use std::sync::Arc;

use rathole_settings_rust::TunnelName;
use serde::Deserialize;
use servers_rust::{EnrolmentError, EnteredRelay, RelaySite, RelaySiteClient, TunnelToken};
use tauri_plugin_log::log;
use url::Url;

use crate::ServersState;

/// [`server_add`]'s arguments, `{relay, tunnelName, token}`. No `Debug`,
/// since it holds the token.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerAddArgs {
    pub relay: EnteredRelay,
    /// As entered; parsed into a [`TunnelName`] here.
    pub tunnel_name: String,
    /// As entered; surrounding whitespace is trimmed here.
    pub token: String,
}

/// [`server_set_credentials`]'s arguments, `{domain, token}`. No `Debug`,
/// since it holds the token.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerSetCredentialsArgs {
    /// The registered server's domain.
    pub domain: String,
    /// As entered; surrounding whitespace is trimmed here.
    pub token: String,
}

/// Enrol and register a server; answers with its domain.
///
/// # Errors
///
/// The [`EnrolmentError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_add(
    servers: tauri::State<'_, ServersState>,
    args: ServerAddArgs,
) -> Result<String, EnrolmentError> {
    add(&servers, args, RelaySiteClient::new).await
}

/// Replace a registered server's token once its relay accepts it, or at
/// once for a manual relay.
///
/// # Errors
///
/// The [`EnrolmentError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_set_credentials(
    servers: tauri::State<'_, ServersState>,
    args: ServerSetCredentialsArgs,
) -> Result<(), EnrolmentError> {
    set_credentials(&servers, args, RelaySiteClient::new).await
}

/// The token as entered, without its surrounding whitespace, as the relay
/// reads its own copy.
///
/// # Errors
///
/// [`EnrolmentError::EmptyToken`] when nothing is left.
fn entered_token(token: &str) -> Result<TunnelToken, EnrolmentError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(EnrolmentError::EmptyToken);
    }
    Ok(TunnelToken::new(token))
}

async fn add<S: RelaySite>(
    servers: &ServersState,
    args: ServerAddArgs,
    relay_site: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<String, EnrolmentError> {
    let ServerAddArgs {
        relay,
        tunnel_name,
        token,
    } = args;
    let result = async {
        let tunnel_name = TunnelName::parse(tunnel_name)?;
        let token = entered_token(&token)?;
        servers_rust::add_server(
            Arc::clone(&servers.registry),
            relay,
            tunnel_name,
            token,
            relay_site,
        )
        .await
    }
    .await;
    match result {
        Ok(record) => {
            let domain = record.domain();
            log::info!("[servers] added {domain}");
            Ok(domain)
        }
        Err(error) => {
            log::warn!("[servers] adding a server failed: {error}");
            Err(error)
        }
    }
}

async fn set_credentials<S: RelaySite>(
    servers: &ServersState,
    args: ServerSetCredentialsArgs,
    relay_site: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<(), EnrolmentError> {
    let ServerSetCredentialsArgs { domain, token } = args;
    let result = async {
        servers_rust::set_server_credentials(
            Arc::clone(&servers.registry),
            &domain,
            entered_token(&token)?,
            relay_site,
        )
        .await
    }
    .await;
    match result {
        Ok(_) => {
            log::info!("[servers] replaced the token of {domain}");
            Ok(())
        }
        Err(error) => {
            log::warn!("[servers] replacing the token of {domain} failed: {error}");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use rathole_settings_rust::{PublicRatholeSettings, TunnelHost};
    use servers_rust::{JsonServerRegistry, Relay};

    use super::*;

    const TOKEN: &str = "s3cret-tunnel-token";
    const PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";

    /// A relay site at `relay.example.com` that accepts `ruth` with
    /// [`TOKEN`].
    struct FakeRelaySite;

    fn served_settings() -> PublicRatholeSettings {
        serde_json::from_value(serde_json::json!({
            "remote_addr": "relay.example.com:2333",
            "transport": "noise",
            "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
            "public_key": PUBLIC_KEY,
            "domain": "relay.example.com",
        }))
        .unwrap()
    }

    #[async_trait::async_trait]
    impl RelaySite for FakeRelaySite {
        async fn fetch_public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError> {
            Ok(served_settings())
        }

        async fn fetch_tunnel_host(
            &self,
            tunnel_name: &TunnelName,
            token: &TunnelToken,
        ) -> Result<TunnelHost, EnrolmentError> {
            if tunnel_name.as_str() != "ruth" || token.expose() != TOKEN {
                return Err(EnrolmentError::CredentialsRejected {
                    tunnel_name: tunnel_name.clone(),
                });
            }
            Ok(TunnelHost {
                tunnel_name: "ruth".to_owned(),
                public_host: "ruth.relay.example.com".to_owned(),
            })
        }
    }

    /// What the commands build their relay site with in these tests.
    #[allow(clippy::unnecessary_wraps)]
    fn fake_site(_relay_base: Url) -> Result<FakeRelaySite, EnrolmentError> {
        Ok(FakeRelaySite)
    }

    /// A builder for relays that have no site to build.
    fn no_site(relay_base: Url) -> Result<FakeRelaySite, EnrolmentError> {
        panic!("built a relay site for {relay_base}")
    }

    fn servers() -> (tempfile::TempDir, ServersState) {
        let data_root = tempfile::tempdir().unwrap();
        let servers =
            ServersState::new(Arc::new(JsonServerRegistry::in_data_root(data_root.path())));
        (data_root, servers)
    }

    /// `server_add`'s arguments for a custom relay, as the webview sends
    /// them.
    fn add_args(tunnel_name: &str, token: &str) -> ServerAddArgs {
        serde_json::from_value(serde_json::json!({
            "relay": {
                "kind": "custom",
                "baseUrl": "https://relay.example.com",
                "pin": {
                    "remoteAddr": "relay.example.com:2333",
                    "publicKey": PUBLIC_KEY,
                },
            },
            "tunnelName": tunnel_name,
            "token": token,
        }))
        .unwrap()
    }

    /// `server_add`'s arguments for a manual relay, as the webview sends
    /// them.
    fn manual_add_args(token: &str) -> ServerAddArgs {
        serde_json::from_value(serde_json::json!({
            "relay": {
                "kind": "manual",
                "remoteAddr": "rathole.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": "rathole.example.com",
            },
            "tunnelName": "ruth",
            "token": token,
        }))
        .unwrap()
    }

    fn set_credentials_args(domain: &str, token: &str) -> ServerSetCredentialsArgs {
        serde_json::from_value(serde_json::json!({"domain": domain, "token": token})).unwrap()
    }

    /// What either command answers, as the webview receives it.
    fn answer<T: serde::Serialize>(result: &Result<T, EnrolmentError>) -> String {
        match result {
            Ok(value) => serde_json::to_string(value).unwrap(),
            Err(error) => serde_json::to_string(error).unwrap(),
        }
    }

    /// Every log line of this test process, from the first call on.
    fn captured_logs() -> &'static Mutex<Vec<String>> {
        struct CapturingLogger(&'static Mutex<Vec<String>>);

        impl log::Log for CapturingLogger {
            fn enabled(&self, _metadata: &log::Metadata<'_>) -> bool {
                true
            }

            fn log(&self, record: &log::Record<'_>) {
                self.0.lock().unwrap().push(record.args().to_string());
            }

            fn flush(&self) {}
        }

        static LOGS: OnceLock<&'static Mutex<Vec<String>>> = OnceLock::new();
        LOGS.get_or_init(|| {
            let logs: &'static Mutex<Vec<String>> = Box::leak(Box::default());
            log::set_boxed_logger(Box::new(CapturingLogger(logs)))
                .expect("no other test sets a logger");
            log::set_max_level(log::LevelFilter::Trace);
            logs
        })
    }

    #[test]
    fn snake_case_arguments_are_refused() {
        for json in [
            serde_json::json!({
                "relay": {"kind": "wildflower"},
                "tunnel_name": "ruth",
                "token": TOKEN,
            }),
            serde_json::json!({
                "relay": {"kind": "custom", "base_url": "https://relay.example.com"},
                "tunnelName": "ruth",
                "token": TOKEN,
            }),
            serde_json::json!({
                "relay": {"kind": "custom", "baseUrl": "https://relay.example.com"},
                "relayPin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY},
                "tunnelName": "ruth",
                "token": TOKEN,
            }),
        ] {
            assert!(
                serde_json::from_value::<ServerAddArgs>(json.clone()).is_err(),
                "{json}"
            );
        }
    }

    #[tokio::test]
    async fn server_add_answers_with_the_domain_and_registers_the_server() {
        let (_data_root, servers) = servers();
        let result = add(&servers, add_args("ruth", TOKEN), fake_site).await;
        assert_eq!(answer(&result), r#""ruth.relay.example.com""#);
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].token.expose(), TOKEN);
    }

    #[tokio::test]
    async fn server_add_refuses_a_tunnel_name_that_is_not_a_dns_label() {
        let (_data_root, servers) = servers();
        for tunnel_name in ["Ruth", "ru.th", "", "admin"] {
            let result = add(&servers, add_args(tunnel_name, TOKEN), fake_site).await;
            assert!(
                matches!(result, Err(EnrolmentError::InvalidTunnelName(_))),
                "{tunnel_name:?}"
            );
            assert!(answer(&result).contains(r#""kind":"invalidTunnelName""#));
        }
        assert_eq!(servers.registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn server_add_trims_the_token_and_refuses_an_empty_one() {
        let (_data_root, servers) = servers();
        for token in ["", "   ", "\n\t"] {
            let result = add(&servers, add_args("ruth", token), fake_site).await;
            assert!(
                answer(&result).contains(r#""kind":"emptyToken""#),
                "{token:?}"
            );
        }
        assert_eq!(servers.registry.read_all().unwrap(), Vec::new());

        let result = add(
            &servers,
            add_args("ruth", &format!("  {TOKEN}\n")),
            fake_site,
        )
        .await;
        assert_eq!(answer(&result), r#""ruth.relay.example.com""#);
        assert_eq!(
            servers.registry.read_all().unwrap()[0].token.expose(),
            TOKEN
        );
    }

    #[tokio::test]
    async fn server_add_registers_a_manual_relay_without_a_site() {
        let (_data_root, servers) = servers();
        let result = add(&servers, manual_add_args(" any-token "), no_site).await;
        assert_eq!(answer(&result), r#""ruth.rathole.example.com""#);
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered[0].relay, Relay::Manual);
        assert_eq!(registered[0].token.expose(), "any-token");
        assert_eq!(
            registered[0].public_settings.remote_addr,
            "rathole.example.com:2333"
        );
    }

    #[tokio::test]
    async fn server_add_names_a_manual_relay_s_invalid_setting() {
        let (_data_root, servers) = servers();
        let mut args = manual_add_args(TOKEN);
        if let EnteredRelay::Manual { public_key, .. } = &mut args.relay {
            *public_key = "not-a-key".to_owned();
        }
        let result = add(&servers, args, no_site).await;
        assert!(
            answer(&result).contains(r#""kind":"invalidRelaySetting""#),
            "{}",
            answer(&result)
        );
        assert!(answer(&result).contains("publicKey"), "{}", answer(&result));
    }

    #[tokio::test]
    async fn server_set_credentials_replaces_the_token() {
        let (_data_root, servers) = servers();
        add(&servers, add_args("ruth", TOKEN), fake_site)
            .await
            .unwrap();
        let result = set_credentials(
            &servers,
            set_credentials_args("ruth.relay.example.com", TOKEN),
            fake_site,
        )
        .await;
        assert_eq!(answer(&result), "null");

        let result = set_credentials(
            &servers,
            set_credentials_args("lab.relay.example.com", TOKEN),
            fake_site,
        )
        .await;
        assert!(answer(&result).contains(r#""kind":"notRegistered""#));
    }

    #[tokio::test]
    async fn server_set_credentials_trims_the_token_and_refuses_an_empty_one() {
        let (_data_root, servers) = servers();
        add(&servers, manual_add_args(TOKEN), no_site)
            .await
            .unwrap();

        let result = set_credentials(
            &servers,
            set_credentials_args("ruth.rathole.example.com", " \t "),
            no_site,
        )
        .await;
        assert!(answer(&result).contains(r#""kind":"emptyToken""#));
        assert_eq!(
            servers.registry.read_all().unwrap()[0].token.expose(),
            TOKEN
        );

        let result = set_credentials(
            &servers,
            set_credentials_args("ruth.rathole.example.com", "  the-new-token\n"),
            no_site,
        )
        .await;
        assert_eq!(answer(&result), "null");
        assert_eq!(
            servers.registry.read_all().unwrap()[0].token.expose(),
            "the-new-token"
        );
    }

    /// Neither command's answer nor anything either logs holds a token, the
    /// right one or a rejected one.
    #[tokio::test]
    async fn the_token_appears_in_no_answer_or_log() {
        let logs = captured_logs();
        let (_data_root, servers) = servers();
        let wrong_token = "the-wrong-s3cret";

        let answers = [
            answer(&add(&servers, add_args("ruth", wrong_token), fake_site).await),
            answer(&add(&servers, add_args("ruth", TOKEN), fake_site).await),
            answer(&add(&servers, add_args("ruth", TOKEN), fake_site).await),
            answer(
                &set_credentials(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", wrong_token),
                    fake_site,
                )
                .await,
            ),
            answer(
                &set_credentials(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", TOKEN),
                    fake_site,
                )
                .await,
            ),
        ];

        assert!(answers[0].contains(r#""kind":"credentialsRejected""#));
        assert!(answers[2].contains(r#""kind":"alreadyRegistered""#));
        assert!(answers[3].contains(r#""kind":"credentialsRejected""#));
        let logged = logs.lock().unwrap().join("\n");
        assert!(
            logged.contains("[servers] added ruth.relay.example.com"),
            "{logged}"
        );
        assert!(
            logged.contains("[servers] adding a server failed"),
            "{logged}"
        );
        for rendered in answers.iter().chain([&logged]) {
            for token in [TOKEN, wrong_token] {
                assert!(!rendered.contains(token), "token leaked: {rendered}");
            }
        }
    }
}
