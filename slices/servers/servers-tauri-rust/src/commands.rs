//! The servers commands: thin wrappers that parse their arguments, call
//! [`servers_rust`]'s enrolment with a [`ReqwestRelayClient`] for a
//! Wildflower relay, push the server they wrote to `TauriUnitRunner`, and log
//! the outcome by domain.
//!
//! Each takes its arguments as top-level parameters, which Tauri reads from
//! the invoke payload under their camelCase names (`tunnel_name` is
//! `tunnelName`). A failure the command reaches answers with the
//! [`EnrolmentError`] as `{kind, message}`. A payload Tauri can't decode into
//! the parameters (a missing key, a value of the wrong JSON type, an unknown
//! relay `kind` or field) never reaches the command: Tauri rejects it with a
//! plain string, ``invalid args `<parameter>` for command `<command>`:
//! <reason>``. The values a user types (the tunnel name, the token, a base
//! URL, a rathole relay's settings) are all taken as strings and checked
//! here, so a bad one is an [`EnrolmentError`]; only a webview bug gets the
//! plain string.

use std::sync::Arc;

use rathole_settings_rust::TunnelName;
use servers_rust::{EnrolmentError, EnteredRelay, RelayClient, ReqwestRelayClient, TunnelToken};
use tauri_plugin_log::log;
use url::Url;

use crate::ServersState;

/// Enrol and register a server, then push it to `TauriUnitRunner`; answers with
/// its domain. Invoked as `invoke('server_add', { relay, tunnelName, token })`,
/// `relay` being an [`EnteredRelay`]. The token is trimmed. No parameter is
/// logged, and the token never is.
///
/// # Errors
///
/// The [`EnrolmentError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_add(
    servers: tauri::State<'_, ServersState>,
    relay: EnteredRelay,
    tunnel_name: String,
    token: String,
) -> Result<String, EnrolmentError> {
    add(&servers, relay, tunnel_name, token, ReqwestRelayClient::new).await
}

/// Replace a registered server's token once its relay accepts it, or at
/// once for a rathole relay, then push the server to `TauriUnitRunner`, which
/// restarts a run of it with the new token; answers with nothing. Invoked as
/// `invoke('server_set_credentials', { domain, token })`. The token is
/// trimmed.
///
/// # Errors
///
/// The [`EnrolmentError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_set_credentials(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    token: String,
) -> Result<(), EnrolmentError> {
    set_credentials(&servers, domain, token, ReqwestRelayClient::new).await
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

async fn add<S: RelayClient>(
    servers: &ServersState,
    relay: EnteredRelay,
    tunnel_name: String,
    token: String,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<String, EnrolmentError> {
    let _registry_write = servers.registry_writes.lock().await;
    let result = async {
        let tunnel_name = TunnelName::parse(tunnel_name)?;
        let token = entered_token(&token)?;
        servers_rust::add_server(
            Arc::clone(&servers.registry),
            relay,
            tunnel_name,
            token,
            relay_client,
            chrono::Utc::now(),
        )
        .await
    }
    .await;
    match result {
        Ok(record) => {
            let domain = record.domain();
            log::info!("[servers] added {domain}");
            servers.server_units.push(record);
            Ok(domain)
        }
        Err(error) => {
            log::warn!("[servers] adding a server failed: {error}");
            Err(error)
        }
    }
}

async fn set_credentials<S: RelayClient>(
    servers: &ServersState,
    domain: String,
    token: String,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<(), EnrolmentError> {
    let _registry_write = servers.registry_writes.lock().await;
    let result = async {
        servers_rust::set_server_credentials(
            Arc::clone(&servers.registry),
            &domain,
            entered_token(&token)?,
            relay_client,
        )
        .await
    }
    .await;
    match result {
        Ok(record) => {
            log::info!("[servers] replaced the token of {domain}");
            servers.server_units.push(record);
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

    use gatekeeper_rust::NoLoopbackConsentPrompt;
    use rathole_settings_rust::{PublicRatholeSettings, TunnelHost};
    use serde::Deserialize;
    use servers_rust::{JsonServerRegistry, RelayKind, ServerDetail, ServerRecord};
    use shared_structures_rust::OnDeviceWebviewHandle;
    use tauri_unit_runner::{
        BackgroundServiceStartConfig, RunPolicy, TauriUnitRunner, UnitId, UnitStatus,
    };
    use tokio::sync::{mpsc, watch};
    use wildflower_server_rust::HostPorts;

    use crate::ServerUnits;

    use super::*;

    /// `server_add`'s parameters as the webview sends them, each decoded
    /// under the camelCase name Tauri reads it from (`tunnel_name` from
    /// `tunnelName`), so the tests build them from the payload the docs give.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AddArgs {
        relay: EnteredRelay,
        tunnel_name: String,
        token: String,
    }

    /// `server_set_credentials`'s parameters, likewise.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SetCredentialsArgs {
        domain: String,
        token: String,
    }

    async fn add_with<S: RelayClient>(
        servers: &ServersState,
        args: AddArgs,
        relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
    ) -> Result<String, EnrolmentError> {
        add(
            servers,
            args.relay,
            args.tunnel_name,
            args.token,
            relay_client,
        )
        .await
    }

    async fn set_credentials_with<S: RelayClient>(
        servers: &ServersState,
        args: SetCredentialsArgs,
        relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
    ) -> Result<(), EnrolmentError> {
        set_credentials(servers, args.domain, args.token, relay_client).await
    }

    const TOKEN: &str = "s3cret-tunnel-token";
    const PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";

    /// A relay client for `relay.example.com` that accepts `ruth` with
    /// [`TOKEN`].
    struct FakeRelayClient;

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
    impl RelayClient for FakeRelayClient {
        async fn public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError> {
            Ok(served_settings())
        }

        async fn tunnel_host(
            &self,
            tunnel_name: &TunnelName,
            token: &TunnelToken,
        ) -> Result<TunnelHost, EnrolmentError> {
            if tunnel_name.as_str() != "ruth" || token.expose() != TOKEN {
                return Err(EnrolmentError::SignedRequestRejected {
                    tunnel_name: tunnel_name.clone(),
                });
            }
            Ok(TunnelHost {
                tunnel_name: TunnelName::parse("ruth").unwrap(),
                public_host: "ruth.relay.example.com".to_owned(),
            })
        }
    }

    /// What the commands build their relay client with in these tests.
    #[allow(clippy::unnecessary_wraps)]
    fn fake_client(_relay_base: Url) -> Result<FakeRelayClient, EnrolmentError> {
        Ok(FakeRelayClient)
    }

    /// A builder for relays that have no relay client to build.
    fn no_client(relay_base: Url) -> Result<FakeRelayClient, EnrolmentError> {
        panic!("built a relay client for {relay_base}")
    }

    /// An on-device webview handle with no popup: no server runs here.
    struct NoOnDeviceWebview;

    impl OnDeviceWebviewHandle for NoOnDeviceWebview {
        fn open(&self, _app_id: String, _title: String, _url: String) {}
    }

    /// The commands' state over a registry in a fresh data root, pushing to
    /// `runner`. The app is never present here, so a `whileOpen` server never
    /// runs, and no run builds a config.
    fn servers_on(runner: &TauriUnitRunner<ServerDetail>) -> (tempfile::TempDir, ServersState) {
        let data_root = tempfile::tempdir().unwrap();
        let (host_owner_token_sender, _) = watch::channel(None);
        let (active_pending_consent_sender, _) = watch::channel(None);
        let (forwarded_request_sender, _) = mpsc::channel(1);
        let server_units = ServerUnits::new(
            runner.clone(),
            Arc::new(|record: &ServerRecord| {
                anyhow::bail!("no config for {} in these tests", record.domain())
            }),
            HostPorts {
                loopback_consent_prompt: Arc::new(NoLoopbackConsentPrompt),
                on_device_webview_handle: Arc::new(NoOnDeviceWebview),
                host_owner_token_sender,
                active_pending_consent_sender,
            },
            forwarded_request_sender,
        );
        let servers = ServersState::new(
            Arc::new(JsonServerRegistry::in_data_root(data_root.path())),
            server_units,
        );
        (data_root, servers)
    }

    fn runner() -> TauriUnitRunner<ServerDetail> {
        TauriUnitRunner::new(BackgroundServiceStartConfig {
            service_label: "Wildflower server is running".to_owned(),
            foreground_service_type: "specialUse".to_owned(),
        })
    }

    fn servers() -> (tempfile::TempDir, ServersState) {
        servers_on(&runner())
    }

    /// `server_add`'s arguments for a self-hosted Wildflower relay, as the
    /// webview sends them.
    fn add_args(tunnel_name: &str, token: &str) -> AddArgs {
        serde_json::from_value(serde_json::json!({
            "relay": {
                "kind": "selfHostedWildflower",
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

    /// `server_add`'s arguments for a rathole relay, as the webview sends
    /// them.
    fn rathole_add_args(token: &str) -> AddArgs {
        serde_json::from_value(serde_json::json!({
            "relay": {
                "kind": "rathole",
                "remoteAddr": "rathole.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": "rathole.example.com",
            },
            "tunnelName": "ruth",
            "token": token,
        }))
        .unwrap()
    }

    fn set_credentials_args(domain: &str, token: &str) -> SetCredentialsArgs {
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

    /// The parameters are top-level: the old `{args: {...}}` wrapper and
    /// snake_case names don't decode.
    #[test]
    fn the_parameters_are_top_level_and_camel_case() {
        let relay = serde_json::json!({"kind": "wildflowerOfficial"});
        assert!(serde_json::from_value::<AddArgs>(
            serde_json::json!({"relay": relay, "tunnelName": "ruth", "token": TOKEN})
        )
        .is_ok());
        for json in [
            serde_json::json!({"args": {"relay": relay, "tunnelName": "ruth", "token": TOKEN}}),
            serde_json::json!({"relay": relay, "tunnel_name": "ruth", "token": TOKEN}),
        ] {
            assert!(
                serde_json::from_value::<AddArgs>(json.clone()).is_err(),
                "{json}"
            );
        }
    }

    #[tokio::test]
    async fn server_add_names_a_base_url_no_relay_site_can_be_asked_at() {
        let (_data_root, servers) = servers();
        let args: AddArgs = serde_json::from_value(serde_json::json!({
            "relay": {"kind": "selfHostedWildflower", "baseUrl": "http://relay.example.com"},
            "tunnelName": "ruth",
            "token": TOKEN,
        }))
        .unwrap();
        let result = add_with(&servers, args, no_client).await;
        assert!(
            answer(&result).contains(r#""kind":"invalidRelaySetting""#)
                && answer(&result).contains("baseUrl"),
            "{}",
            answer(&result)
        );
    }

    #[tokio::test]
    async fn server_add_answers_with_the_domain_and_registers_the_server() {
        let (_data_root, servers) = servers();
        let result = add_with(&servers, add_args("ruth", TOKEN), fake_client).await;
        assert_eq!(answer(&result), r#""ruth.relay.example.com""#);
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered.len(), 1);
        assert_eq!(registered[0].token.expose(), TOKEN);
    }

    /// The server a command wrote is set on `TauriUnitRunner`, under its
    /// domain; a failed command sets nothing.
    #[tokio::test]
    async fn the_commands_push_what_they_wrote_to_the_runner() {
        let runner = runner();
        let (_data_root, servers) = servers_on(&runner);
        add_with(&servers, add_args("ruth", "the-wrong-s3cret"), fake_client)
            .await
            .unwrap_err();
        assert!(runner.statuses().is_empty());

        add_with(&servers, add_args("ruth", TOKEN), fake_client)
            .await
            .unwrap();
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered[0].run_policy, RunPolicy::WhileOpen);
        let statuses = runner.statuses();
        assert_eq!(
            statuses.keys().collect::<Vec<_>>(),
            [&UnitId::from("ruth.relay.example.com")]
        );
        assert_eq!(
            statuses[&UnitId::from("ruth.relay.example.com")],
            UnitStatus::never_run(),
            "the app isn't present, so a whileOpen server waits"
        );

        set_credentials_with(
            &servers,
            set_credentials_args("ruth.relay.example.com", TOKEN),
            fake_client,
        )
        .await
        .unwrap();
        assert_eq!(runner.statuses().len(), 1);
    }

    #[tokio::test]
    async fn server_add_refuses_a_tunnel_name_that_is_not_a_dns_label() {
        let (_data_root, servers) = servers();
        for tunnel_name in ["Ruth", "ru.th", "", "admin"] {
            let result = add_with(&servers, add_args(tunnel_name, TOKEN), fake_client).await;
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
            let result = add_with(&servers, add_args("ruth", token), fake_client).await;
            assert!(
                answer(&result).contains(r#""kind":"emptyToken""#),
                "{token:?}"
            );
        }
        assert_eq!(servers.registry.read_all().unwrap(), Vec::new());

        let result = add_with(
            &servers,
            add_args("ruth", &format!("  {TOKEN}\n")),
            fake_client,
        )
        .await;
        assert_eq!(answer(&result), r#""ruth.relay.example.com""#);
        assert_eq!(
            servers.registry.read_all().unwrap()[0].token.expose(),
            TOKEN
        );
    }

    #[tokio::test]
    async fn server_add_registers_a_rathole_relay_without_a_request() {
        let (_data_root, servers) = servers();
        let result = add_with(&servers, rathole_add_args(" any-token "), no_client).await;
        assert_eq!(answer(&result), r#""ruth.rathole.example.com""#);
        let registered = servers.registry.read_all().unwrap();
        assert_eq!(registered[0].relay, RelayKind::Rathole);
        assert_eq!(registered[0].token.expose(), "any-token");
        assert_eq!(
            registered[0].public_settings.remote_addr,
            "rathole.example.com:2333"
        );
    }

    #[tokio::test]
    async fn server_add_names_a_rathole_relay_s_invalid_setting() {
        let (_data_root, servers) = servers();
        let mut args = rathole_add_args(TOKEN);
        if let EnteredRelay::Rathole { identity, .. } = &mut args.relay {
            identity.public_key = "not-a-key".to_owned();
        }
        let result = add_with(&servers, args, no_client).await;
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
        add_with(&servers, add_args("ruth", TOKEN), fake_client)
            .await
            .unwrap();
        let result = set_credentials_with(
            &servers,
            set_credentials_args("ruth.relay.example.com", TOKEN),
            fake_client,
        )
        .await;
        assert_eq!(answer(&result), "null");

        let result = set_credentials_with(
            &servers,
            set_credentials_args("lab.relay.example.com", TOKEN),
            fake_client,
        )
        .await;
        assert!(answer(&result).contains(r#""kind":"notRegistered""#));
    }

    #[tokio::test]
    async fn server_set_credentials_trims_the_token_and_refuses_an_empty_one() {
        let (_data_root, servers) = servers();
        add_with(&servers, rathole_add_args(TOKEN), no_client)
            .await
            .unwrap();

        let result = set_credentials_with(
            &servers,
            set_credentials_args("ruth.rathole.example.com", " \t "),
            no_client,
        )
        .await;
        assert!(answer(&result).contains(r#""kind":"emptyToken""#));
        assert_eq!(
            servers.registry.read_all().unwrap()[0].token.expose(),
            TOKEN
        );

        let result = set_credentials_with(
            &servers,
            set_credentials_args("ruth.rathole.example.com", "  the-new-token\n"),
            no_client,
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
            answer(&add_with(&servers, add_args("ruth", wrong_token), fake_client).await),
            answer(&add_with(&servers, add_args("ruth", TOKEN), fake_client).await),
            answer(&add_with(&servers, add_args("ruth", TOKEN), fake_client).await),
            answer(
                &set_credentials_with(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", wrong_token),
                    fake_client,
                )
                .await,
            ),
            answer(
                &set_credentials_with(
                    &servers,
                    set_credentials_args("ruth.relay.example.com", TOKEN),
                    fake_client,
                )
                .await,
            ),
        ];

        assert!(answers[0].contains(r#""kind":"signedRequestRejected""#));
        assert!(answers[2].contains(r#""kind":"alreadyRegistered""#));
        assert!(answers[3].contains(r#""kind":"signedRequestRejected""#));
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
