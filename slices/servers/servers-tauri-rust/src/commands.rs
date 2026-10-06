//! The servers commands: thin wrappers that parse their arguments, call
//! [`servers_rust`] (with a [`ReqwestRelayClient`] for a Wildflower relay's
//! enrolment), run the reconciler after every change, and log the outcome by
//! domain.
//!
//! Each takes its arguments as top-level parameters, which Tauri reads from
//! the invoke payload under their camelCase names (`tunnel_name` is
//! `tunnelName`). A failure the command reaches answers with its error as
//! `{kind, message}`: an [`EnrolmentError`], a [`ServerChangeError`] or, for
//! `servers_list`, a [`RegistryError`]. A payload Tauri can't decode into the
//! parameters (a missing key, a value of the wrong JSON type, an unknown
//! relay or policy `kind`, an unknown field) never reaches the command: Tauri
//! rejects it with a plain string, ``invalid args `<parameter>` for command
//! `<command>`: <reason>``. The values a user types (the tunnel name, the
//! token, a base URL, a rathole relay's settings, a launcher URL) are all
//! taken as strings and checked here, so a bad one is the command's own
//! error; only a webview bug gets the plain string.

use std::sync::Arc;

use chrono::Utc;
use rathole_settings_rust::TunnelName;
use serde::Serialize;
use servers_rust::{
    EnrolmentError, EnteredRelay, RegistryError, RelayClient, RelayKind, ReqwestRelayClient,
    RunPolicy, RunPolicyChoice, ServerChangeError, ServerRecord, TunnelToken,
};
use tauri_plugin_log::log;
use url::Url;

use crate::{ServerStatus, ServersState};

/// One registered server as `servers_list` answers it: what the base shows of
/// its record, and its current status. Neither its token nor the relay's dial
/// settings are sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedServer {
    pub domain: String,
    pub relay: RelayKind,
    pub tunnel_name: TunnelName,
    pub launcher_url: Url,
    pub staging_certificates: bool,
    pub run_policy: RunPolicy,
    pub status: ServerStatus,
}

impl ListedServer {
    /// `record` as listed, with `status`.
    fn of(record: ServerRecord, status: ServerStatus) -> Self {
        Self {
            domain: record.domain(),
            relay: record.relay,
            tunnel_name: record.tunnel_name,
            launcher_url: record.launcher_url,
            staging_certificates: record.staging_certificates,
            run_policy: record.run_policy,
            status,
        }
    }
}

/// Every registered server, in the order they were added, with its current
/// status. Invoked as `invoke('servers_list')`.
///
/// # Errors
///
/// The [`RegistryError`] `servers.json` couldn't be read with.
#[tauri::command]
pub async fn servers_list(
    servers: tauri::State<'_, ServersState>,
) -> Result<Vec<ListedServer>, RegistryError> {
    list(&servers).await
}

/// Enrol and register a server; answers with its domain. Invoked as
/// `invoke('server_add', { relay, tunnelName, token })`, `relay` being an
/// [`EnteredRelay`]. The token is trimmed. No parameter is logged, and the
/// token never is.
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
/// once for a rathole relay; answers with nothing. Invoked as
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

/// Set a server's run policy, every other server's to `Off` unless `policy`
/// is `Off`; answers with the [`RunPolicy`] stored. Invoked as
/// `invoke('server_set_run_policy', { domain, policy })`, `policy` being a
/// [`RunPolicyChoice`]: `{kind: "for", seconds}` is stored as
/// `{kind: "until", at}`, counted from now.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_set_run_policy(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    policy: RunPolicyChoice,
) -> Result<RunPolicy, ServerChangeError> {
    set_run_policy(&servers, domain, policy).await
}

/// Set the launcher a server opens apps from, and whether its certificates
/// come from the ACME staging directory; answers with nothing. Invoked as
/// `invoke('server_update', { domain, launcherUrl, stagingCertificates })`.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it, with nothing written.
#[tauri::command]
pub async fn server_update(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    launcher_url: String,
    staging_certificates: bool,
) -> Result<(), ServerChangeError> {
    update(&servers, domain, launcher_url, staging_certificates).await
}

/// Stop a server and delete it: its folder, with its databases and
/// certificates, and its record. Answers with nothing. Invoked as
/// `invoke('server_remove', { domain })`.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it. A server that couldn't be
/// stopped, or whose folder couldn't be deleted, is still registered.
#[tauri::command]
pub async fn server_remove(
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), ServerChangeError> {
    remove(&servers, domain).await
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

/// Run `operation` on the registry off the async runtime.
async fn on_registry<T: Send + 'static, E: From<RegistryError> + Send + 'static>(
    servers: &ServersState,
    operation: impl FnOnce(&dyn servers_rust::ServerRegistry) -> Result<T, E> + Send + 'static,
) -> Result<T, E> {
    let registry = Arc::clone(&servers.registry);
    tokio::task::spawn_blocking(move || operation(registry.as_ref()))
        .await
        .map_err(|error| {
            E::from(RegistryError::storage(
                "running a registry operation",
                error,
            ))
        })?
}

async fn list(servers: &ServersState) -> Result<Vec<ListedServer>, RegistryError> {
    let records = on_registry(servers, |registry| registry.read_all())
        .await
        .inspect_err(|error| log::error!("[servers] listing the servers failed: {error}"))?;
    Ok(records
        .into_iter()
        .map(|record| {
            let status = servers.statuses.current(&record.domain());
            ListedServer::of(record, status)
        })
        .collect())
}

async fn add<S: RelayClient>(
    servers: &ServersState,
    relay: EnteredRelay,
    tunnel_name: String,
    token: String,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<String, EnrolmentError> {
    let result = async {
        let tunnel_name = TunnelName::parse(tunnel_name)?;
        let token = entered_token(&token)?;
        servers_rust::add_server(
            Arc::clone(&servers.registry),
            relay,
            tunnel_name,
            token,
            relay_client,
            Utc::now(),
        )
        .await
    }
    .await;
    servers.reconcile().await;
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

async fn set_credentials<S: RelayClient>(
    servers: &ServersState,
    domain: String,
    token: String,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<(), EnrolmentError> {
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
    servers.reconcile().await;
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

async fn set_run_policy(
    servers: &ServersState,
    domain: String,
    policy: RunPolicyChoice,
) -> Result<RunPolicy, ServerChangeError> {
    let changed_domain = domain.clone();
    let result = on_registry(servers, move |registry| {
        servers_rust::set_run_policy(registry, &changed_domain, policy, Utc::now())
    })
    .await;
    if result.is_ok() {
        servers.reconciler.retry_failed_start(&domain).await;
    }
    servers.reconcile().await;
    match result {
        Ok(run_policy) => {
            log::info!("[servers] set the run policy of {domain} to {run_policy:?}");
            Ok(run_policy)
        }
        Err(error) => {
            log::warn!("[servers] setting the run policy of {domain} failed: {error}");
            Err(error)
        }
    }
}

async fn update(
    servers: &ServersState,
    domain: String,
    launcher_url: String,
    staging_certificates: bool,
) -> Result<(), ServerChangeError> {
    let changed_domain = domain.clone();
    let result = on_registry(servers, move |registry| {
        servers_rust::update_server(
            registry,
            &changed_domain,
            &launcher_url,
            staging_certificates,
        )
    })
    .await;
    servers.reconcile().await;
    match result {
        Ok(()) => {
            log::info!("[servers] updated {domain}");
            Ok(())
        }
        Err(error) => {
            log::warn!("[servers] updating {domain} failed: {error}");
            Err(error)
        }
    }
}

async fn remove(servers: &ServersState, domain: String) -> Result<(), ServerChangeError> {
    let result = servers
        .reconciler
        .stop_and_remove(
            &domain,
            servers.service.as_ref(),
            |reason| ServerChangeError::StoppingServer {
                domain: domain.clone(),
                reason,
            },
            async || {
                let removed_domain = domain.clone();
                let data_root = servers.data_root.clone();
                on_registry(servers, move |registry| {
                    servers_rust::remove_server(registry, &data_root, &removed_domain)
                })
                .await
            },
        )
        .await;
    if result.is_ok() {
        servers.statuses.forget(&domain);
    }
    servers.reconcile().await;
    match result {
        Ok(()) => {
            log::info!("[servers] removed {domain}");
            Ok(())
        }
        Err(error) => {
            log::warn!("[servers] removing {domain} failed: {error}");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use rathole_settings_rust::{PublicRatholeSettings, TunnelHost};
    use serde::Deserialize;
    use servers_rust::{JsonServerRegistry, SERVERS_FILE_NAME};
    use shared_structures_rust::server_run_state::ServerRunState;

    use super::*;
    use crate::fake_service::{FakeServerService, ServiceCall};
    use crate::server_status::tests::collected_statuses;
    use crate::ServerService;

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

    /// The commands' state over a fresh data root, with a fake service and
    /// every status the commands emit collected.
    struct Harness {
        data_root: tempfile::TempDir,
        servers: ServersState,
        service: Arc<FakeServerService>,
        emitted: Arc<Mutex<Vec<ServerStatus>>>,
    }

    fn harness() -> Harness {
        let data_root = tempfile::tempdir().unwrap();
        let (statuses, emitted) = collected_statuses();
        let service = Arc::new(FakeServerService::new(statuses.clone()));
        let servers = ServersState::new(
            Arc::new(JsonServerRegistry::in_data_root(data_root.path())),
            data_root.path(),
            Arc::clone(&service) as Arc<dyn ServerService>,
            statuses,
        );
        Harness {
            data_root,
            servers,
            service,
            emitted,
        }
    }

    fn servers() -> (tempfile::TempDir, ServersState) {
        let Harness {
            data_root, servers, ..
        } = harness();
        (data_root, servers)
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

    const RUTH: &str = "ruth.relay.example.com";
    const LAB: &str = "lab.rathole.example.com";

    /// `server_set_run_policy`'s `policy` as the webview sends it.
    fn choice(json: serde_json::Value) -> RunPolicyChoice {
        serde_json::from_value(json).unwrap()
    }

    /// Register `ruth` on a self-hosted relay, then `lab` on a rathole relay,
    /// through `server_add`, and forget what that asked of the service.
    async fn add_ruth_and_lab(harness: &Harness) {
        add_with(&harness.servers, add_args("ruth", TOKEN), fake_client)
            .await
            .unwrap();
        let mut lab = rathole_add_args(TOKEN);
        lab.tunnel_name = "lab".to_owned();
        add_with(&harness.servers, lab, no_client).await.unwrap();
        harness.service.take_calls();
        harness.emitted.lock().unwrap().clear();
    }

    fn run_policies(harness: &Harness) -> Vec<RunPolicy> {
        harness
            .servers
            .registry
            .read_all()
            .unwrap()
            .into_iter()
            .map(|server| server.run_policy)
            .collect()
    }

    /// The run state of every status emitted, in order, by domain.
    fn emitted_run_states(harness: &Harness) -> Vec<(String, ServerRunState)> {
        harness
            .emitted
            .lock()
            .unwrap()
            .iter()
            .map(|status| (status.domain.clone(), status.run_state.clone()))
            .collect()
    }

    fn write_unreadable_registry(harness: &Harness) {
        std::fs::write(
            harness.data_root.path().join(SERVERS_FILE_NAME),
            r#"{"version": 2, "servers": []}"#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn the_first_server_added_starts_and_a_later_one_does_not() {
        let harness = harness();

        add_with(&harness.servers, add_args("ruth", TOKEN), fake_client)
            .await
            .unwrap();
        add_with(&harness.servers, rathole_add_args(TOKEN), no_client)
            .await
            .unwrap();

        assert_eq!(
            harness.service.take_calls(),
            vec![ServiceCall::Start(RUTH.to_owned())]
        );
        assert_eq!(
            emitted_run_states(&harness),
            vec![
                (RUTH.to_owned(), ServerRunState::Starting),
                (RUTH.to_owned(), ServerRunState::Running),
            ]
        );
    }

    #[tokio::test]
    async fn servers_list_answers_with_each_server_its_status_and_no_token() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;

        let listed = list(&harness.servers).await.unwrap();

        assert_eq!(
            listed
                .iter()
                .map(|server| (
                    server.domain.as_str(),
                    server.run_policy,
                    server.status.run_state.clone()
                ))
                .collect::<Vec<_>>(),
            vec![
                (RUTH, RunPolicy::WhileInUse, ServerRunState::Running),
                (LAB, RunPolicy::Off, ServerRunState::Stopped { error: None }),
            ]
        );
        let answer = serde_json::to_value(&listed).unwrap();
        assert_eq!(answer[0]["domain"], RUTH);
        assert_eq!(
            answer[0]["runPolicy"],
            serde_json::json!({"kind": "whileInUse"})
        );
        assert_eq!(
            answer[0]["status"]["runState"],
            serde_json::json!({"state": "running"})
        );
        assert!(answer[0]["status"]["startedAt"].is_string());
        assert_eq!(answer[1]["status"]["startedAt"], serde_json::Value::Null);
        assert!(
            !answer.to_string().contains(TOKEN),
            "token leaked: {answer}"
        );
    }

    #[tokio::test]
    async fn servers_list_answers_an_unreadable_registry_with_its_error() {
        let harness = harness();
        write_unreadable_registry(&harness);

        let result = list(&harness.servers).await;

        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap(),
            serde_json::json!({
                "kind": "registry",
                "message": "the server registry has format version 2, which this build doesn't read",
            })
        );
    }

    #[tokio::test]
    async fn setting_a_policy_on_another_server_stops_the_running_one_and_starts_it() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;

        let stored = set_run_policy(
            &harness.servers,
            LAB.to_owned(),
            choice(serde_json::json!({"kind": "always"})),
        )
        .await
        .unwrap();

        assert_eq!(stored, RunPolicy::Always);
        assert_eq!(
            run_policies(&harness),
            vec![RunPolicy::Off, RunPolicy::Always]
        );
        assert_eq!(
            harness.service.take_calls(),
            vec![
                ServiceCall::Stop(RUTH.to_owned()),
                ServiceCall::Start(LAB.to_owned()),
            ]
        );
        assert_eq!(
            emitted_run_states(&harness),
            vec![
                (RUTH.to_owned(), ServerRunState::Stopped { error: None }),
                (LAB.to_owned(), ServerRunState::Starting),
                (LAB.to_owned(), ServerRunState::Running),
            ]
        );
        assert_eq!(harness.service.running_domains(), vec![LAB.to_owned()]);
    }

    #[tokio::test]
    async fn setting_the_running_server_off_stops_it_and_runs_nothing() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;

        set_run_policy(
            &harness.servers,
            RUTH.to_owned(),
            choice(serde_json::json!({"kind": "off"})),
        )
        .await
        .unwrap();

        assert_eq!(run_policies(&harness), vec![RunPolicy::Off, RunPolicy::Off]);
        assert_eq!(
            harness.service.take_calls(),
            vec![
                ServiceCall::Stop(RUTH.to_owned()),
                ServiceCall::PublishNoServer("no server's run policy is active".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn for_is_answered_and_stored_as_until() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        let before = Utc::now();

        let stored = set_run_policy(
            &harness.servers,
            LAB.to_owned(),
            choice(serde_json::json!({"kind": "for", "seconds": 1800})),
        )
        .await
        .unwrap();

        let RunPolicy::Until { at } = stored else {
            panic!("For is stored as Until, not {stored:?}");
        };
        assert!(at >= before + chrono::TimeDelta::seconds(1800), "{at}");
        assert!(at <= Utc::now() + chrono::TimeDelta::seconds(1800), "{at}");
        assert_eq!(run_policies(&harness), vec![RunPolicy::Off, stored]);
        assert_eq!(
            serde_json::to_value(stored).unwrap()["kind"],
            serde_json::json!("until")
        );
    }

    #[tokio::test]
    async fn a_duration_of_zero_or_less_is_refused_and_changes_nothing() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;

        for seconds in [0, -60] {
            let result = set_run_policy(
                &harness.servers,
                LAB.to_owned(),
                choice(serde_json::json!({"kind": "for", "seconds": seconds})),
            )
            .await;
            assert_eq!(
                serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
                serde_json::json!("nonPositiveDuration")
            );
        }
        assert_eq!(
            run_policies(&harness),
            vec![RunPolicy::WhileInUse, RunPolicy::Off]
        );
        assert_eq!(harness.service.running_domains(), vec![RUTH.to_owned()]);
    }

    /// A server whose config can't be built doesn't run, and its status says
    /// why, in the event and in `servers_list`.
    #[tokio::test]
    async fn a_server_that_fails_to_start_is_stopped_with_the_error() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        let error = "the server's config couldn't be built: no owner UI base URL";
        harness
            .service
            .failing_starts
            .lock()
            .unwrap()
            .insert(LAB.to_owned(), error.to_owned());

        set_run_policy(
            &harness.servers,
            LAB.to_owned(),
            choice(serde_json::json!({"kind": "whileInUse"})),
        )
        .await
        .unwrap();

        let failed = ServerRunState::Stopped {
            error: Some(error.to_owned()),
        };
        assert_eq!(
            emitted_run_states(&harness).last(),
            Some(&(LAB.to_owned(), failed.clone()))
        );
        assert_eq!(
            list(&harness.servers).await.unwrap()[1].status.run_state,
            failed
        );

        // It isn't retried on an unrelated command.
        harness.service.take_calls();
        update(
            &harness.servers,
            RUTH.to_owned(),
            "https://wildflowerhealth.io/app".to_owned(),
            true,
        )
        .await
        .unwrap();
        assert_eq!(harness.service.take_calls(), Vec::new());

        // Setting its policy again tries it again.
        harness.service.failing_starts.lock().unwrap().clear();
        set_run_policy(
            &harness.servers,
            LAB.to_owned(),
            choice(serde_json::json!({"kind": "whileInUse"})),
        )
        .await
        .unwrap();
        assert_eq!(
            harness.service.take_calls(),
            vec![ServiceCall::Start(LAB.to_owned())]
        );
        assert_eq!(
            list(&harness.servers).await.unwrap()[1].status.run_state,
            ServerRunState::Running
        );
    }

    /// An `Until` that ended while the app was closed isn't started, and the
    /// record keeps it as it is.
    #[tokio::test]
    async fn an_expired_until_is_not_started_and_stays_in_the_file() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        let ended = RunPolicy::Until {
            at: Utc::now() - chrono::TimeDelta::hours(1),
        };
        harness
            .servers
            .registry
            .modify(Box::new(|servers| {
                servers[0].run_policy = ended;
                Ok(())
            }))
            .unwrap();
        let file_before =
            std::fs::read_to_string(harness.data_root.path().join(SERVERS_FILE_NAME)).unwrap();
        let restarted = {
            let (statuses, _emitted) = collected_statuses();
            let service = Arc::new(FakeServerService::new(statuses.clone()));
            let servers = ServersState::new(
                Arc::clone(&harness.servers.registry),
                harness.data_root.path(),
                Arc::clone(&service) as Arc<dyn ServerService>,
                statuses,
            );
            servers.reconcile().await;
            service
        };

        assert_eq!(
            restarted.take_calls(),
            vec![ServiceCall::PublishNoServer(
                "no server's run policy is active".to_owned()
            )]
        );
        assert_eq!(
            std::fs::read_to_string(harness.data_root.path().join(SERVERS_FILE_NAME)).unwrap(),
            file_before
        );
        assert_eq!(run_policies(&harness), vec![ended, RunPolicy::Off]);
    }

    /// With the registry unreadable at setup nothing starts, and a run the
    /// platform starts on its own is told why.
    #[tokio::test]
    async fn an_unreadable_registry_at_setup_runs_nothing_and_says_why() {
        let harness = harness();
        write_unreadable_registry(&harness);

        harness.servers.reconcile().await;

        let calls = harness.service.take_calls();
        assert!(
            matches!(
                calls.as_slice(),
                [ServiceCall::PublishNoServer(reason)]
                    if reason.contains("can't be read") && reason.contains("format version 2")
            ),
            "{calls:?}"
        );
    }

    /// A registry that becomes unreadable leaves the running server alone.
    #[tokio::test]
    async fn an_unreadable_registry_stops_nothing() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        write_unreadable_registry(&harness);

        harness.servers.reconcile().await;

        assert_eq!(harness.service.take_calls(), Vec::new());
        assert_eq!(harness.service.running_domains(), vec![RUTH.to_owned()]);
    }

    #[tokio::test]
    async fn server_update_sets_the_launcher_and_staging() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;

        update(
            &harness.servers,
            LAB.to_owned(),
            "http://localhost:5200/app".to_owned(),
            true,
        )
        .await
        .unwrap();
        let invalid = update(
            &harness.servers,
            LAB.to_owned(),
            "ftp://launcher.example.com/".to_owned(),
            false,
        )
        .await;

        let lab = &harness.servers.registry.read_all().unwrap()[1];
        assert_eq!(lab.launcher_url.as_str(), "http://localhost:5200/app");
        assert!(lab.staging_certificates);
        assert_eq!(
            serde_json::to_value(invalid.unwrap_err()).unwrap()["kind"],
            serde_json::json!("invalidLauncherUrl")
        );
    }

    #[tokio::test]
    async fn server_remove_stops_the_server_then_deletes_its_folder_and_record() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        let ruth_dir =
            harness.servers.registry.read_all().unwrap()[0].server_dir(harness.data_root.path());
        std::fs::create_dir_all(&ruth_dir).unwrap();
        std::fs::write(ruth_dir.join("wildflower.sqlite"), "data").unwrap();

        remove(&harness.servers, RUTH.to_owned()).await.unwrap();

        assert_eq!(
            harness.service.take_calls(),
            vec![
                ServiceCall::Stop(RUTH.to_owned()),
                ServiceCall::PublishNoServer("no server's run policy is active".to_owned()),
            ]
        );
        assert!(!ruth_dir.exists());
        let listed = list(&harness.servers).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|server| server.domain.as_str())
                .collect::<Vec<_>>(),
            vec![LAB]
        );
        assert_eq!(
            harness.servers.statuses.current(RUTH),
            ServerStatus::stopped(RUTH)
        );
    }

    #[tokio::test]
    async fn a_server_that_cannot_be_stopped_is_not_removed() {
        let harness = harness();
        add_ruth_and_lab(&harness).await;
        harness
            .service
            .failing_stops
            .lock()
            .unwrap()
            .insert(RUTH.to_owned(), "the plugin refused".to_owned());

        let result = remove(&harness.servers, RUTH.to_owned()).await;

        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
            serde_json::json!("stoppingServer")
        );
        assert_eq!(harness.servers.registry.read_all().unwrap().len(), 2);
        assert_eq!(harness.service.running_domains(), vec![RUTH.to_owned()]);
    }

    /// The parameters of the run-policy, update and remove commands are
    /// top-level and camelCase.
    #[test]
    fn the_server_commands_parameters_are_top_level_and_camel_case() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct SetRunPolicyArgs {
            domain: String,
            policy: RunPolicyChoice,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[allow(dead_code)]
        struct UpdateArgs {
            domain: String,
            launcher_url: String,
            staging_certificates: bool,
        }

        assert!(
            serde_json::from_value::<SetRunPolicyArgs>(serde_json::json!({
                "domain": RUTH,
                "policy": {"kind": "for", "seconds": 60},
            }))
            .is_ok()
        );
        assert!(serde_json::from_value::<UpdateArgs>(serde_json::json!({
            "domain": RUTH,
            "launcherUrl": "https://wildflowerhealth.io/app",
            "stagingCertificates": false,
        }))
        .is_ok());
        assert!(serde_json::from_value::<UpdateArgs>(serde_json::json!({
            "domain": RUTH,
            "launcher_url": "https://wildflowerhealth.io/app",
            "staging_certificates": false,
        }))
        .is_err());
    }

    /// The wire shapes shared with `servers-core`'s decoders, which read the
    /// same file, so neither side can change a field alone.
    const GOLDEN: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../servers-wire-golden.json"
    ));

    fn golden(pointer: &str) -> serde_json::Value {
        let golden: serde_json::Value =
            serde_json::from_str(GOLDEN).expect("servers-wire-golden.json parses");
        golden
            .pointer(pointer)
            .unwrap_or_else(|| panic!("servers-wire-golden.json has {pointer}"))
            .clone()
    }

    #[test]
    fn listed_servers_serialise_to_the_pinned_wire_format() {
        use chrono::TimeZone;
        use servers_rust::RunPolicy;
        use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};

        let at = |hour, minute| Utc.with_ymd_and_hms(2026, 10, 6, hour, minute, 0).unwrap();
        let ruth = ServerRecord {
            relay: RelayKind::SelfHostedWildflower {
                base_url: Url::parse("https://relay.example.com").unwrap(),
            },
            tunnel_name: TunnelName::parse("ruth").unwrap(),
            token: TunnelToken::new(TOKEN),
            public_settings: served_settings(),
            launcher_url: ServerRecord::default_launcher_url(),
            staging_certificates: false,
            run_policy: RunPolicy::Until { at: at(17, 42) },
        };
        let lab = ServerRecord {
            relay: RelayKind::Rathole,
            tunnel_name: TunnelName::parse("lab").unwrap(),
            public_settings: PublicRatholeSettings {
                domain: "rathole.example.com".to_owned(),
                ..served_settings()
            },
            launcher_url: Url::parse("http://localhost:5200/app").unwrap(),
            staging_certificates: true,
            run_policy: RunPolicy::Off,
            ..ruth.clone()
        };
        let ruth_status = ServerStatus {
            tunnel_liveness: Some(TunnelLiveness {
                settings_revision: Some(3),
                status: TunnelStatus::Verified,
                origin: "https://ruth.relay.example.com".to_owned(),
                public_host: Some("ruth.relay.example.com".to_owned()),
                error: None,
                dial_attempts: 1,
            }),
            ..ServerStatus::stopped(RUTH).with_run_state(ServerRunState::Running, at(17, 0))
        };
        let lab_status = ServerStatus {
            run_state: ServerRunState::Stopped {
                error: Some("the server's config couldn't be built".to_owned()),
            },
            ..ServerStatus::stopped(LAB)
        };

        let listed = vec![
            ListedServer::of(ruth, ruth_status),
            ListedServer::of(lab, lab_status),
        ];

        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            golden("/listedServers")
        );
        assert!(!serde_json::to_string(&listed).unwrap().contains(TOKEN));
    }

    #[test]
    fn run_policies_serialise_to_the_pinned_wire_format() {
        let policies: Vec<RunPolicy> =
            serde_json::from_value(golden("/runPolicies")).expect("the policies decode");
        assert_eq!(
            serde_json::to_value(&policies).unwrap(),
            golden("/runPolicies")
        );
        assert_eq!(policies.len(), 4);
    }

    #[test]
    fn every_pinned_run_policy_choice_decodes() {
        let choices: Vec<RunPolicyChoice> =
            serde_json::from_value(golden("/runPolicyChoices")).expect("the choices decode");
        assert_eq!(
            choices,
            vec![
                RunPolicyChoice::Off,
                RunPolicyChoice::WhileInUse,
                RunPolicyChoice::For { seconds: 1800 },
                RunPolicyChoice::Always,
            ]
        );
    }

    #[test]
    fn a_command_error_serialises_to_the_pinned_wire_format() {
        assert_eq!(
            serde_json::to_value(ServerChangeError::NonPositiveDuration { seconds: 0 }).unwrap(),
            golden("/commandError")
        );
    }
}
