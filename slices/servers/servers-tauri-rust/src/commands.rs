//! The servers commands: thin wrappers that parse their arguments, call
//! [`servers_rust`] (with a [`ReqwestRelayClient`] for a Wildflower relay's
//! enrolment), push what they wrote to `TauriUnitRunner` through
//! [`ServerUnits`](crate::ServerUnits), and log the outcome by domain.
//!
//! A command that writes the registry holds
//! [`ServersState::registry_writes`] from before its write until after its
//! push, so `TauriUnitRunner` gets the servers' changes in the order they
//! were written.
//!
//! Each takes its arguments as top-level parameters, which Tauri reads from
//! the invoke payload under their camelCase names (`tunnel_name` is
//! `tunnelName`). A failure the command reaches answers with its error as
//! `{kind, message}`: an [`EnrolmentError`], a [`ServerChangeError`] or, for
//! `servers_list`, a [`RegistryError`]. A payload Tauri can't decode into the
//! parameters (a missing key, a value of the wrong JSON type, an unknown
//! relay or choice `kind`, an unknown field) never reaches the command: Tauri
//! rejects it with a plain string, ``invalid args `<parameter>` for command
//! `<command>`: <reason>``. The values a user types (the tunnel name, the
//! token, a base URL, a rathole relay's settings, a launcher URL) are all
//! taken as strings and checked here, so a bad one is the command's own
//! error; only a webview bug gets the plain string.

use std::sync::Arc;

use chrono::Utc;
use rathole_settings_rust::TunnelName;
use servers_rust::{
    EnrolmentError, EnteredRelay, ListedServer, RegistryError, RelayClient, ReqwestRelayClient,
    RunPolicy, RunPolicyChoice, ServerChangeError, ServerRegistry, TunnelToken,
};
use tauri_plugin_log::log;
use url::Url;

use crate::ServersState;

/// Every registered server, in the order they were added, each with its
/// status on `TauriUnitRunner`. Invoked as `invoke('servers_list')`.
///
/// # Errors
///
/// The [`RegistryError`] `servers.json` couldn't be read with, so the base
/// can show it.
#[tauri::command]
pub async fn servers_list(
    servers: tauri::State<'_, ServersState>,
) -> Result<Vec<ListedServer>, RegistryError> {
    list(&servers).await
}

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

/// Set a server's run policy to `choice`, then give `TauriUnitRunner` the
/// policy stored; answers with that [`RunPolicy`]. Invoked as
/// `invoke('server_set_run_policy', { domain, choice })`, `choice` being a
/// [`RunPolicyChoice`]: `{kind: "for", seconds}` is stored as
/// `{kind: "until", at}`, counted from now. Every other server keeps its
/// policy.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it, with nothing written or
/// pushed.
#[tauri::command]
pub async fn server_set_run_policy(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    choice: RunPolicyChoice,
) -> Result<RunPolicy, ServerChangeError> {
    set_run_policy(&servers, domain, choice).await
}

/// Set the launcher a server opens apps from, and whether its certificates come
/// from the ACME staging directory; answers with nothing. Invoked as
/// `invoke('server_update', { domain, launcherUrl, stagingCertificates })`.
/// When a field a run reads changed, the server is pushed to `TauriUnitRunner`
/// again, which replaces a run of the old record.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it, with nothing written or
/// pushed.
#[tauri::command]
pub async fn server_update(
    servers: tauri::State<'_, ServersState>,
    domain: String,
    launcher_url: String,
    staging_certificates: bool,
) -> Result<(), ServerChangeError> {
    update(&servers, domain, launcher_url, staging_certificates).await
}

/// Stop a server and delete it: once its run has ended and it is off the
/// runner, its folder, with its databases and certificates, then its
/// record. Answers with nothing. Invoked as
/// `invoke('server_remove', { domain })`.
///
/// # Errors
///
/// The [`ServerChangeError`] that stopped it. A server whose folder couldn't be
/// deleted is still registered, and is pushed to `TauriUnitRunner` again.
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

/// Run `operation` on the registry on a blocking thread: the registry is a
/// file, read and replaced synchronously.
async fn on_registry<T, E>(
    servers: &ServersState,
    operation: impl FnOnce(&dyn ServerRegistry) -> Result<T, E> + Send + 'static,
) -> Result<T, E>
where
    T: Send + 'static,
    E: From<RegistryError> + Send + 'static,
{
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
    Ok(ListedServer::list(
        records,
        &servers.server_units.statuses(),
    ))
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

async fn set_run_policy(
    servers: &ServersState,
    domain: String,
    choice: RunPolicyChoice,
) -> Result<RunPolicy, ServerChangeError> {
    let _registry_write = servers.registry_writes.lock().await;
    let changed_domain = domain.clone();
    let result = on_registry(servers, move |registry| {
        servers_rust::set_run_policy(registry, &changed_domain, choice, Utc::now())
    })
    .await;
    match result {
        Ok(run_policy) => {
            log::info!("[servers] set the run policy of {domain} to {run_policy:?}");
            servers.server_units.set_run_policy(&domain, run_policy);
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
    let _registry_write = servers.registry_writes.lock().await;
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
    match result {
        Ok(update) => {
            if update.run_inputs_changed {
                log::info!("[servers] updated {domain}; its runs read the change");
                servers.server_units.push(update.record);
            } else {
                log::info!("[servers] updated {domain}");
            }
            Ok(())
        }
        Err(error) => {
            log::warn!("[servers] updating {domain} failed: {error}");
            Err(error)
        }
    }
}

async fn remove(servers: &ServersState, domain: String) -> Result<(), ServerChangeError> {
    let _registry_write = servers.registry_writes.lock().await;
    servers.server_units.remove(&domain).await;
    let removed_domain = domain.clone();
    let data_root = servers.data_root.clone();
    let result = on_registry(servers, move |registry| {
        servers_rust::remove_server(registry, &data_root, &removed_domain)
    })
    .await;
    match result {
        Ok(()) => {
            log::info!("[servers] removed {domain}");
            Ok(())
        }
        Err(error) => {
            log::warn!("[servers] removing {domain} failed: {error}");
            put_back_on_the_unit_runner(servers, &domain).await;
            Err(error)
        }
    }
}

/// Push the server `domain` to `TauriUnitRunner` again, as `servers.json`
/// holds it, after a removal that took it off `TauriUnitRunner` but failed to
/// delete it.
async fn put_back_on_the_unit_runner(servers: &ServersState, domain: &str) {
    match on_registry(servers, |registry| registry.read_all()).await {
        Ok(records) => {
            if let Some(record) = records.into_iter().find(|record| record.domain() == domain) {
                servers.server_units.push(record);
            }
        }
        Err(error) => {
            log::error!(
                "[servers] {domain} is off the unit runner until the app restarts: {error}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use gatekeeper_rust::NoLoopbackConsentPrompt;
    use rathole_settings_rust::{PublicRatholeSettings, TunnelHost};
    use serde::Deserialize;
    use servers_rust::{
        JsonServerRegistry, RelayKind, ServerDetail, ServerRecord, SERVERS_FILE_NAME,
    };
    use shared_structures_rust::OnDeviceWebviewHandle;
    use tauri_unit_runner::{
        BackgroundServiceStartConfig, RunContext, RunState, RunStop, StopReason, TauriUnitRunner,
        Unit, UnitId, UnitStatus,
    };
    use tokio::sync::{mpsc, watch};
    use tokio_util::sync::CancellationToken;
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
            data_root.path().to_path_buf(),
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

    /// The domain [`rathole_add_args`] registers.
    const RATHOLE_DOMAIN: &str = "ruth.rathole.example.com";

    /// How long a test waits for `TauriUnitRunner` before it fails rather than
    /// hangs.
    const RUNNER_TIMEOUT: Duration = Duration::from_secs(10);

    /// What a [`HeldUnit`]'s run left behind for its test to read.
    #[derive(Default)]
    struct HeldRun {
        /// The run's shutdown token, once it has started.
        shutdown: Mutex<Option<CancellationToken>>,
        /// Whether `folder` still existed when the run was asked to stop.
        folder_existed_at_stop: Mutex<Option<bool>>,
    }

    /// A unit that is up as soon as it starts, and runs until it is asked to
    /// stop; the test reads its run's shutdown token and whether the server's
    /// folder still existed when it stopped.
    struct HeldUnit {
        folder: PathBuf,
        run: Arc<HeldRun>,
    }

    impl Unit for HeldUnit {
        type Detail = ServerDetail;

        async fn run(self, ctx: RunContext<ServerDetail>) -> anyhow::Result<()> {
            *self.run.shutdown.lock().unwrap() = Some(ctx.shutdown_token().clone());
            ctx.announce_running();
            ctx.shutdown_token().cancelled().await;
            *self.run.folder_existed_at_stop.lock().unwrap() = Some(self.folder.exists());
            Ok(())
        }
    }

    /// A registered rathole server, [`RATHOLE_DOMAIN`], with its folder,
    /// whose unit on `runner` is a [`HeldUnit`] that is running.
    async fn running_server(
        runner: &TauriUnitRunner<ServerDetail>,
    ) -> (tempfile::TempDir, ServersState, Arc<HeldRun>) {
        let (data_root, servers) = servers_on(runner);
        add_with(&servers, rathole_add_args(TOKEN), no_client)
            .await
            .unwrap();
        let folder = data_root.path().join("servers").join(RATHOLE_DOMAIN);
        std::fs::create_dir_all(&folder).unwrap();
        let run = Arc::new(HeldRun::default());
        let unit_run = Arc::clone(&run);
        runner.set_unit(UnitId::from(RATHOLE_DOMAIN), RunPolicy::Always, move || {
            Ok(HeldUnit {
                folder: folder.clone(),
                run: Arc::clone(&unit_run),
            })
        });
        status_on(runner, |status| {
            status.is_some_and(|status| status.run_state == RunState::Running)
        })
        .await;
        (data_root, servers, run)
    }

    /// The status of [`RATHOLE_DOMAIN`] on `runner` once `reached` holds for
    /// it; `None` once `TauriUnitRunner` doesn't hold it.
    async fn status_on(
        runner: &TauriUnitRunner<ServerDetail>,
        reached: impl Fn(Option<&UnitStatus<ServerDetail>>) -> bool,
    ) -> Option<UnitStatus<ServerDetail>> {
        let mut statuses = runner.subscribe();
        let unit_id = UnitId::from(RATHOLE_DOMAIN);
        let statuses = tokio::time::timeout(
            RUNNER_TIMEOUT,
            statuses.wait_for(|statuses| reached(statuses.get(&unit_id))),
        )
        .await
        .expect("the unit runner reached the status in time")
        .expect("the unit runner is alive")
        .clone();
        statuses.get(&unit_id).cloned()
    }

    fn shutdown_of(run: &HeldRun) -> CancellationToken {
        run.shutdown
            .lock()
            .unwrap()
            .clone()
            .expect("the run started")
    }

    fn stored_policy(servers: &ServersState) -> RunPolicy {
        servers.registry.read_all().unwrap()[0].run_policy
    }

    #[tokio::test]
    async fn setting_the_policy_off_stops_a_running_server() {
        let runner = runner();
        let (_data_root, servers, _run) = running_server(&runner).await;

        let stored = set_run_policy(&servers, RATHOLE_DOMAIN.to_owned(), RunPolicyChoice::Off)
            .await
            .unwrap();

        assert_eq!(stored, RunPolicy::Off);
        assert_eq!(stored_policy(&servers), RunPolicy::Off);
        let status = status_on(&runner, |status| {
            status.is_some_and(|status| matches!(status.run_state, RunState::Stopped { .. }))
        })
        .await
        .unwrap();
        assert!(
            matches!(
                status.run_state,
                RunState::Stopped {
                    last_stop: Some(RunStop {
                        reason: StopReason::PolicyInactive,
                        ..
                    })
                }
            ),
            "{status:?}"
        );
    }

    #[tokio::test]
    async fn a_policy_for_a_while_is_stored_and_pushed_as_until_its_deadline() {
        let runner = runner();
        let (_data_root, servers, run) = running_server(&runner).await;
        let before = Utc::now();

        let stored = set_run_policy(
            &servers,
            RATHOLE_DOMAIN.to_owned(),
            RunPolicyChoice::For { seconds: 1800 },
        )
        .await
        .unwrap();

        let RunPolicy::Until { at } = stored else {
            panic!("stored {stored:?}")
        };
        assert!(at >= before + chrono::TimeDelta::seconds(1800), "{at}");
        assert!(at <= Utc::now() + chrono::TimeDelta::seconds(1800), "{at}");
        assert_eq!(stored_policy(&servers), stored);
        assert!(
            !shutdown_of(&run).is_cancelled(),
            "an until ahead keeps the server running"
        );
    }

    #[tokio::test]
    async fn a_refused_policy_is_neither_stored_nor_pushed() {
        let runner = runner();
        let (_data_root, servers, run) = running_server(&runner).await;

        let result = set_run_policy(
            &servers,
            RATHOLE_DOMAIN.to_owned(),
            RunPolicyChoice::For { seconds: 0 },
        )
        .await;

        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
            "nonPositiveDuration"
        );
        assert_eq!(stored_policy(&servers), RunPolicy::WhileOpen);
        assert!(!shutdown_of(&run).is_cancelled());
    }

    #[tokio::test]
    async fn an_update_pushes_the_server_again_only_when_its_runs_read_the_change() {
        let runner = runner();
        let (_data_root, servers, run) = running_server(&runner).await;

        update(
            &servers,
            RATHOLE_DOMAIN.to_owned(),
            "http://localhost:5200/app".to_owned(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            servers.registry.read_all().unwrap()[0]
                .launcher_url
                .as_str(),
            "http://localhost:5200/app"
        );
        assert!(
            !shutdown_of(&run).is_cancelled(),
            "only the base reads the launcher"
        );

        update(
            &servers,
            RATHOLE_DOMAIN.to_owned(),
            "http://localhost:5200/app".to_owned(),
            true,
        )
        .await
        .unwrap();
        assert!(servers.registry.read_all().unwrap()[0].staging_certificates);
        assert!(
            shutdown_of(&run).is_cancelled(),
            "the certificate source is a run's, so the run is replaced"
        );
        status_on(&runner, |status| {
            status.is_some_and(|status| {
                matches!(
                    &status.run_state,
                    RunState::Stopped { last_stop: Some(stop) } if stop.reason == StopReason::Replaced
                )
            })
        })
        .await;
    }

    #[tokio::test]
    async fn removal_stops_the_server_before_deleting_its_folder_and_record() {
        let runner = runner();
        let (data_root, servers, run) = running_server(&runner).await;

        remove(&servers, RATHOLE_DOMAIN.to_owned()).await.unwrap();

        assert_eq!(
            *run.folder_existed_at_stop.lock().unwrap(),
            Some(true),
            "the run had stopped before the folder went"
        );
        assert!(!data_root
            .path()
            .join("servers")
            .join(RATHOLE_DOMAIN)
            .exists());
        assert_eq!(servers.registry.read_all().unwrap(), Vec::new());
        assert!(runner.statuses().is_empty());
    }

    #[tokio::test]
    async fn a_removal_that_fails_puts_the_server_back_on_the_runner() {
        let runner = runner();
        let (data_root, servers, _run) = running_server(&runner).await;
        // A file where the folder should be can't be deleted as a folder.
        let folder = data_root.path().join("servers").join(RATHOLE_DOMAIN);
        std::fs::remove_dir(&folder).unwrap();
        std::fs::write(&folder, "not a folder").unwrap();

        let result = remove(&servers, RATHOLE_DOMAIN.to_owned()).await;

        assert_eq!(
            serde_json::to_value(result.unwrap_err()).unwrap()["kind"],
            "deletingFolder"
        );
        assert_eq!(servers.registry.read_all().unwrap().len(), 1);
        assert!(runner
            .statuses()
            .contains_key(&UnitId::from(RATHOLE_DOMAIN)));
    }

    #[tokio::test]
    async fn the_list_joins_each_record_with_its_status() {
        let runner = runner();
        let (_data_root, servers, _run) = running_server(&runner).await;

        let listed = list(&servers).await.unwrap();

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].record.domain(), RATHOLE_DOMAIN);
        assert_eq!(listed[0].unit_status.run_state, RunState::Running);
        let listed = serde_json::to_value(&listed).unwrap();
        assert_eq!(listed[0]["status"]["runState"], "running");
        assert_eq!(
            listed[0]["runPolicy"],
            serde_json::json!({"kind": "whileOpen"})
        );
    }

    #[tokio::test]
    async fn the_list_answers_with_the_error_an_unreadable_registry_gives() {
        let (data_root, servers) = servers();
        std::fs::write(data_root.path().join(SERVERS_FILE_NAME), "not json").unwrap();

        let result = list(&servers).await;

        let error = serde_json::to_value(result.unwrap_err()).unwrap();
        assert_eq!(error["kind"], "registry");
        assert!(
            error["message"].as_str().unwrap().contains("servers.json"),
            "{error}"
        );
    }

    /// The parameters are top-level and camelCase, as the docs give them.
    #[test]
    fn the_change_parameters_decode_from_the_documented_payloads() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct SetRunPolicyArgs {
            domain: String,
            choice: RunPolicyChoice,
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
                "domain": RATHOLE_DOMAIN,
                "choice": {"kind": "for", "seconds": 900},
            }))
            .is_ok()
        );
        assert!(serde_json::from_value::<UpdateArgs>(serde_json::json!({
            "domain": RATHOLE_DOMAIN,
            "launcherUrl": "http://localhost:5200/app",
            "stagingCertificates": true,
        }))
        .is_ok());
    }
}
