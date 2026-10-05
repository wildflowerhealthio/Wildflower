//! The servers commands: thin wrappers that parse their arguments, call
//! [`servers_rust`]'s enrolment and log the outcome by domain.

use std::sync::Arc;

use rathole_settings_rust::TunnelName;
use serde::Deserialize;
use servers_rust::{EnrolmentError, Relay, RelayPin, TunnelToken};
use tauri_plugin_log::log;

use crate::ServersState;

/// [`server_add`]'s arguments. No `Debug`, since it holds the token.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerAddArgs {
    pub relay: Relay,
    /// The relay settings entered under "Advanced", checked against the
    /// relay's `GET /rathole` and not stored.
    pub relay_pin: Option<RelayPin>,
    /// As entered; parsed into a [`TunnelName`] here.
    pub tunnel_name: String,
    pub token: String,
}

/// [`server_set_credentials`]'s arguments. No `Debug`, since it holds the
/// token.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSetCredentialsArgs {
    /// The registered server's domain.
    pub domain: String,
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
    add(&servers, args).await
}

/// Replace a registered server's token once its relay accepts it.
///
/// # Errors
///
/// The [`EnrolmentError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_set_credentials(
    servers: tauri::State<'_, ServersState>,
    args: ServerSetCredentialsArgs,
) -> Result<(), EnrolmentError> {
    set_credentials(&servers, args).await
}

async fn add(servers: &ServersState, args: ServerAddArgs) -> Result<String, EnrolmentError> {
    let ServerAddArgs {
        relay,
        relay_pin,
        tunnel_name,
        token,
    } = args;
    let result = async {
        let tunnel_name = TunnelName::parse(tunnel_name)?;
        servers_rust::add_server(
            Arc::clone(&servers.registry),
            servers.relay_site.as_ref(),
            relay,
            relay_pin.as_ref(),
            tunnel_name,
            TunnelToken::new(token),
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

async fn set_credentials(
    servers: &ServersState,
    args: ServerSetCredentialsArgs,
) -> Result<(), EnrolmentError> {
    let ServerSetCredentialsArgs { domain, token } = args;
    match servers_rust::set_server_credentials(
        Arc::clone(&servers.registry),
        servers.relay_site.as_ref(),
        &domain,
        TunnelToken::new(token),
    )
    .await
    {
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
    use servers_rust::{JsonServerRegistry, RelaySite};
    use url::Url;

    use super::*;

    const TOKEN: &str = "s3cret-tunnel-token";

    /// A relay site at `relay.example.com` that accepts `ruth` with
    /// [`TOKEN`].
    struct FakeRelaySite;

    fn served_settings() -> PublicRatholeSettings {
        serde_json::from_value(serde_json::json!({
            "remote_addr": "relay.example.com:2333",
            "transport": "noise",
            "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
            "public_key": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
            "domain": "relay.example.com",
        }))
        .unwrap()
    }

    #[async_trait::async_trait]
    impl RelaySite for FakeRelaySite {
        async fn fetch_public_settings(
            &self,
            _relay_base: &Url,
        ) -> Result<PublicRatholeSettings, EnrolmentError> {
            Ok(served_settings())
        }

        async fn fetch_tunnel_host(
            &self,
            _relay_base: &Url,
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

    fn servers() -> (tempfile::TempDir, ServersState) {
        let data_root = tempfile::tempdir().unwrap();
        let servers = ServersState::new(
            Arc::new(JsonServerRegistry::in_data_root(data_root.path())),
            Arc::new(FakeRelaySite),
        );
        (data_root, servers)
    }

    /// `server_add`'s arguments as the webview sends them.
    fn add_args(tunnel_name: &str, token: &str) -> ServerAddArgs {
        serde_json::from_value(serde_json::json!({
            "relay": {"kind": "custom", "base_url": "https://relay.example.com"},
            "relay_pin": {
                "remote_addr": "relay.example.com:2333",
                "public_key": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
            },
            "tunnel_name": tunnel_name,
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

    #[tokio::test]
    async fn server_add_answers_with_the_domain_and_registers_the_server() {
        let (_data_root, servers) = servers();
        let result = add(&servers, add_args("ruth", TOKEN)).await;
        assert_eq!(answer(&result), r#""ruth.relay.example.com""#);
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].token.expose(), TOKEN);
    }

    #[tokio::test]
    async fn server_add_refuses_a_tunnel_name_that_is_not_a_dns_label() {
        let (_data_root, servers) = servers();
        for tunnel_name in ["Ruth", "ru.th", "", "admin"] {
            let result = add(&servers, add_args(tunnel_name, TOKEN)).await;
            assert!(
                matches!(result, Err(EnrolmentError::InvalidTunnelName(_))),
                "{tunnel_name:?}"
            );
            assert!(answer(&result).contains(r#""kind":"invalid_tunnel_name""#));
        }
        assert_eq!(servers.registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn server_set_credentials_replaces_the_token() {
        let (_data_root, servers) = servers();
        add(&servers, add_args("ruth", TOKEN)).await.unwrap();
        let result = set_credentials(
            &servers,
            set_credentials_args("ruth.relay.example.com", TOKEN),
        )
        .await;
        assert_eq!(answer(&result), "null");

        let result = set_credentials(
            &servers,
            set_credentials_args("lab.relay.example.com", TOKEN),
        )
        .await;
        assert!(answer(&result).contains(r#""kind":"not_registered""#));
    }

    /// Neither command's answer nor anything either logs holds a token, the
    /// right one or a rejected one.
    #[tokio::test]
    async fn the_token_appears_in_no_answer_or_log() {
        let logs = captured_logs();
        let (_data_root, servers) = servers();
        let wrong_token = "the-wrong-s3cret";

        let answers = [
            answer(&add(&servers, add_args("ruth", wrong_token)).await),
            answer(&add(&servers, add_args("ruth", TOKEN)).await),
            answer(&add(&servers, add_args("ruth", TOKEN)).await),
            answer(
                &set_credentials(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", wrong_token),
                )
                .await,
            ),
            answer(
                &set_credentials(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", TOKEN),
                )
                .await,
            ),
        ];

        assert!(answers[0].contains(r#""kind":"credentials_rejected""#));
        assert!(answers[2].contains(r#""kind":"already_registered""#));
        assert!(answers[3].contains(r#""kind":"credentials_rejected""#));
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
