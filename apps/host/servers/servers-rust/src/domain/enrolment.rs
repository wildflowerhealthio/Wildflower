//! Enrolment: adding a server from a relay and the credentials entered for
//! it, and re-entering a server's token.
//!
//! A Wildflower relay (the official one, or a self-hosted one entered by the
//! base URL of its relay site) is asked the same way both times, through a
//! [`RelayClient`] built for its base URL. Its `GET /rathole` is fetched and
//! checked, then compared with the [`RelayIdentity`] expected of it: the
//! user's pin when a server is added, and the identity the server was added
//! with when its token is re-entered. A server added with a claim code
//! ([`EnteredCredentials::ClaimCode`]) then redeems it with `POST /claim`,
//! only once the relay's identity is confirmed, for the tunnel name and
//! token it stands for, with the relay settings, which must be the ones its
//! `GET /rathole` served; the code is spent there and kept nowhere, and the
//! registry is written next. A code the relay answers as an access code
//! ([`EnrolmentError::AccessCodeNeedsDetails`], unburned) is entered again
//! with an email and, optionally, a subdomain
//! ([`EnteredCredentials::AccessCode`]), and redeemed with `POST /access`
//! for a new tunnel under them, checked and spent the same way. Entered with
//! a tunnel name and token instead, a
//! `GET /me` signed with the token confirms the relay holds that tunnel name
//! and token, and that it reaches the tunnel at
//! `<tunnel name>.<relay domain>`; only then is the registry written. The
//! response to `GET /rathole` becomes the record's `public_settings`; a pin
//! is checked and never stored.
//!
//! A rathole relay, a rathole server with no Wildflower relay site, is
//! entered as its settings, with a tunnel name and token: it redeems no
//! claim codes or access codes. The settings get the same checks a `GET /rathole` response
//! does and become the record's `public_settings`; no request is made, and
//! the tunnel coming up is the check. Its token is replaced without a
//! request too.

use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use url::Url;
use wildflowerhealthio_rathole_settings::{
    parse_public_addr, AccessRequest, ClaimedTunnel, NoisePattern, PublicRatholeSettings,
    RelayDomain, Transport, TunnelHost, TunnelName,
};
use wildflowerhealthio_unit_runner::RunPolicy;

use crate::domain::{EnrolmentError, RegistryError, RelayKind, ServerRecord, TunnelToken};
use crate::ports::{registered_mut, RelayClient, ServerRegistry};

/// The relay as the user entered it.
///
/// Deserialised from `{"kind": "wildflowerOfficial"}`,
/// `{"kind": "selfHostedWildflower", "baseUrl", "pin"?}` or
/// `{"kind": "rathole", "remoteAddr", "publicKey", "domain"}`, the pin being
/// `{"remoteAddr", "publicKey"}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EnteredRelay {
    /// The relay Wildflower runs.
    WildflowerOfficial,
    /// A Wildflower relay someone else runs, with its Wildflower relay site
    /// at `base_url`, which needn't share a host with the domain its
    /// `GET /rathole` serves.
    SelfHostedWildflower {
        /// As entered. [`add_server`] checks it is an `https` URL with a
        /// host and no credentials, query or fragment, so a bad one is an
        /// [`EnrolmentError::InvalidRelaySetting`] rather than an argument
        /// that fails to decode.
        base_url: String,
        /// The identity its `GET /rathole` must serve, checked and not
        /// stored.
        #[serde(default)]
        pin: Option<RelayIdentity>,
    },
    /// A rathole server with no Wildflower relay site, entered as the
    /// settings its `GET /rathole` would serve. The transport and noise
    /// pattern are the only ones a device runs.
    Rathole {
        #[serde(flatten)]
        identity: RelayIdentity,
        /// The relay domain the server's domain ends in.
        domain: String,
    },
}

/// What tells one relay from another, as a rathole client sees it: the
/// address it dials and the noise key it expects there. Entered by hand as a
/// pin or for a rathole relay, and taken from a record's `public_settings`
/// when its token is re-entered.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayIdentity {
    /// The `host:port` the rathole client dials. Compared ignoring ASCII
    /// case, as [`parse_public_addr`] folds it.
    pub remote_addr: String,
    /// The relay's X25519 noise public key, base64.
    pub public_key: String,
}

impl RelayIdentity {
    fn of(public_settings: &PublicRatholeSettings) -> Self {
        Self {
            remote_addr: public_settings.remote_addr.clone(),
            public_key: public_settings.public_key.clone(),
        }
    }

    /// The first setting `public_settings` serves differently from this
    /// identity: its name, as the command's arguments name it, this
    /// identity's value and the served one.
    fn first_difference(
        &self,
        public_settings: &PublicRatholeSettings,
    ) -> Option<(&'static str, String, String)> {
        if !self
            .remote_addr
            .eq_ignore_ascii_case(&public_settings.remote_addr)
        {
            return Some((
                "remoteAddr",
                self.remote_addr.clone(),
                public_settings.remote_addr.clone(),
            ));
        }
        if self.public_key != public_settings.public_key {
            return Some((
                "publicKey",
                self.public_key.clone(),
                public_settings.public_key.clone(),
            ));
        }
        None
    }
}

/// The credentials the user entered to add a server with.
///
/// Deserialised from `{"kind": "claimCode", "code"}`,
/// `{"kind": "accessCode", "code", "email", "tunnelName"?}` or
/// `{"kind": "token", "tunnelName", "token"}`. Each value is taken as typed
/// and checked by [`add_server`], so a bad one is an [`EnrolmentError`]
/// rather than an argument that fails to decode. `Debug` never prints the
/// code or the token.
#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EnteredCredentials {
    /// A claim code from the relay's admin, such as `ABCD-EFGH`, which a
    /// Wildflower relay redeems once for the tunnel's name and token. The
    /// relay ignores its case and the dash; [`add_server`] trims it.
    ClaimCode { code: String },
    /// An access code from the relay's admin, which a Wildflower relay
    /// redeems once for a new tunnel for `email`, named `tunnel_name` or,
    /// without one, a name the relay draws. [`add_server`] trims the code
    /// and the email.
    AccessCode {
        code: String,
        email: String,
        #[serde(default)]
        tunnel_name: Option<String>,
    },
    /// The tunnel's name and token at the relay, as its admin gave them.
    Token { tunnel_name: String, token: String },
}

impl std::fmt::Debug for EnteredCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClaimCode { .. } => f.debug_struct("ClaimCode").finish_non_exhaustive(),
            Self::AccessCode {
                email, tunnel_name, ..
            } => f
                .debug_struct("AccessCode")
                .field("email", email)
                .field("tunnel_name", tunnel_name)
                .finish_non_exhaustive(),
            Self::Token { tunnel_name, .. } => f
                .debug_struct("Token")
                .field("tunnel_name", tunnel_name)
                .finish_non_exhaustive(),
        }
    }
}

impl EnteredCredentials {
    /// The credentials, checked before any relay is asked: a claim code or
    /// access code and an email trimmed, a tunnel name parsed and a token
    /// trimmed.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::EmptyClaimCode`], [`EnrolmentError::EmptyEmail`],
    /// [`EnrolmentError::InvalidTunnelName`] or [`EnrolmentError::EmptyToken`].
    fn checked(self) -> Result<CheckedCredentials, EnrolmentError> {
        match self {
            Self::ClaimCode { code } => Ok(CheckedCredentials::ClaimCode(trimmed_code(&code)?)),
            Self::AccessCode {
                code,
                email,
                tunnel_name,
            } => {
                let code = trimmed_code(&code)?;
                let email = email.trim();
                if email.is_empty() {
                    return Err(EnrolmentError::EmptyEmail);
                }
                let tunnel_name = tunnel_name
                    .map(|tunnel_name| TunnelName::parse(tunnel_name).map(String::from))
                    .transpose()?;
                Ok(CheckedCredentials::AccessCode(AccessRequest {
                    code,
                    email: email.to_owned(),
                    tunnel_name,
                }))
            }
            Self::Token { tunnel_name, token } => Ok(CheckedCredentials::Token {
                tunnel_name: TunnelName::parse(tunnel_name)?,
                token: TunnelToken::entered(&token)?,
            }),
        }
    }
}

/// A claim code or access code, trimmed.
///
/// # Errors
///
/// [`EnrolmentError::EmptyClaimCode`] for one left empty.
fn trimmed_code(code: &str) -> Result<String, EnrolmentError> {
    let code = code.trim();
    if code.is_empty() {
        return Err(EnrolmentError::EmptyClaimCode);
    }
    Ok(code.to_owned())
}

/// [`EnteredCredentials`] once checked.
enum CheckedCredentials {
    /// A claim code, trimmed, for the relay to redeem.
    ClaimCode(String),
    /// An access code with the email and tunnel name to redeem it for, as
    /// `POST /access` takes them.
    AccessCode(AccessRequest),
    Token {
        tunnel_name: TunnelName,
        token: TunnelToken,
    },
}

/// A tunnel a relay has confirmed or claimed: its name and token, and the
/// relay's settings, as the record keeps them.
struct EnrolledTunnel {
    tunnel_name: TunnelName,
    token: TunnelToken,
    public_settings: PublicRatholeSettings,
}

/// Enrol a tunnel at `relay` with `credentials` and register the server, with
/// `default_launcher_url` and `default_authorization_url`, the launcher and
/// Authorization app the app gives a new server, and the default certificate
/// authority ([`ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY`]). Its
/// [`run_policy`](ServerRecord::run_policy) is [`RunPolicy::WhileOpen`] when
/// no registered server's policy wants it running at `now`, so the first
/// server added runs, and [`RunPolicy::Off`] otherwise, so a later one doesn't
/// start alongside it. An `Off` policy or an `Until` that has passed doesn't.
///
/// A claim code is redeemed at a Wildflower relay once its `GET /rathole`
/// has passed its checks and matched any pin, and the record holds the
/// tunnel name and token it redeemed for, as if they had been entered. No
/// signed `GET /me` follows: the code is spent once `POST /claim` answers,
/// so nothing after it may fail and leave the user retrying a spent code,
/// and the relay that answered, over TLS, is the one whose `GET /rathole`
/// the claimed settings must match. A code the relay answers as an access
/// code is [`EnrolmentError::AccessCodeNeedsDetails`], unspent; an access
/// code entered with an email is redeemed at `POST /access` the same way,
/// for the tunnel it creates. Entered tunnel names and tokens are confirmed
/// with a signed `GET /me`.
///
/// `relay_client` builds the [`RelayClient`] for a Wildflower relay from its
/// base URL; it is called once for an official or self-hosted Wildflower
/// relay, and never for [`EnteredRelay::Rathole`].
///
/// # Errors
///
/// [`EnrolmentError::EmptyClaimCode`], [`EnrolmentError::EmptyEmail`],
/// [`EnrolmentError::InvalidTunnelName`] or [`EnrolmentError::EmptyToken`]
/// for the entered credentials, before anything is asked;
/// [`EnrolmentError::InvalidRelaySetting`] for an entered base URL or rathole
/// relay setting; [`EnrolmentError::ClaimCodesNotOffered`] for a claim code
/// or access code entered for a rathole relay;
/// [`EnrolmentError::PinMismatch`] when the relay doesn't serve the pinned
/// identity; [`EnrolmentError::BadRelayResponse`] when the settings
/// `POST /claim` sends aren't the ones `GET /rathole` served; any
/// [`EnrolmentError`] from `relay_client` or the relay's site, with nothing
/// written; or [`EnrolmentError::Registry`], a server with the same domain
/// being [`RegistryError::AlreadyRegistered`].
pub async fn add_server<S: RelayClient>(
    registry: Arc<dyn ServerRegistry>,
    relay: EnteredRelay,
    credentials: EnteredCredentials,
    default_launcher_url: Url,
    default_authorization_url: Url,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
    now: DateTime<Utc>,
) -> Result<ServerRecord, EnrolmentError> {
    let credentials = credentials.checked()?;
    let (relay, enrolled) = match relay {
        EnteredRelay::WildflowerOfficial => {
            let relay_client = relay_client(RelayKind::wildflower_base_url())?;
            let enrolled = enrolled_tunnel(&relay_client, credentials, |_| Ok(())).await?;
            (RelayKind::WildflowerOfficial, enrolled)
        }
        EnteredRelay::SelfHostedWildflower { base_url, pin } => {
            let base_url = parse_base_url(&base_url)?;
            let relay_client = relay_client(base_url.clone())?;
            let enrolled = enrolled_tunnel(&relay_client, credentials, |served| {
                let Some(pin) = &pin else { return Ok(()) };
                if let Some((setting, pinned, served)) = pin.first_difference(served) {
                    return Err(EnrolmentError::PinMismatch {
                        setting,
                        pinned,
                        served,
                    });
                }
                Ok(())
            })
            .await?;
            (RelayKind::SelfHostedWildflower { base_url }, enrolled)
        }
        EnteredRelay::Rathole { identity, domain } => {
            let CheckedCredentials::Token { tunnel_name, token } = credentials else {
                return Err(EnrolmentError::ClaimCodesNotOffered);
            };
            let RelayIdentity {
                remote_addr,
                public_key,
            } = identity;
            let public_settings = checked_relay_settings(PublicRatholeSettings {
                remote_addr,
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key,
                domain,
            })
            .map_err(|problem| EnrolmentError::InvalidRelaySetting {
                setting: problem.setting,
                reason: problem.reason,
            })?;
            let enrolled = EnrolledTunnel {
                tunnel_name,
                token,
                public_settings,
            };
            (RelayKind::Rathole, enrolled)
        }
    };
    let EnrolledTunnel {
        tunnel_name,
        token,
        public_settings,
    } = enrolled;
    let record = run_blocking(registry, move |registry| {
        registry.insert(Box::new(|registered| ServerRecord {
            relay,
            tunnel_name,
            token,
            public_settings,
            launcher_url: default_launcher_url,
            authorization_url: default_authorization_url,
            certificate_authority: ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY,
            // The user is enrolling, so the app is present: a `WhileOpen`
            // policy wants its server running.
            run_policy: if registered
                .iter()
                .any(|server| server.run_policy.wants_running(now, true))
            {
                RunPolicy::Off
            } else {
                RunPolicy::WhileOpen
            },
        }))
    })
    .await?;
    Ok(record)
}

/// Replace the token of the server with `domain` by `token`; everything else
/// is kept.
///
/// Only the token and `public_settings` are written, onto the record as it is
/// when the relay has answered, in one registry change: a change made to the
/// server while the relay was being asked, such as its run policy, is kept.
///
/// For a Wildflower relay, the token is first checked with it the way
/// [`add_server`] does, through the [`RelayClient`] `relay_client` builds from
/// its base URL. The relay's identity was pinned when the server was added:
/// its current `GET /rathole` must serve the same domain, remote address and
/// noise key as the record's `public_settings`, before the signed `GET /me`
/// is sent. The record then takes that response as its `public_settings`. A
/// [`RelayKind::Rathole`] server's token is replaced without a request, and
/// `relay_client` is never called.
///
/// # Errors
///
/// [`RegistryError::NotRegistered`] when no server has `domain`, checked
/// before the relay is asked; [`EnrolmentError::DomainChanged`] when the relay
/// now serves another domain; [`EnrolmentError::RelayIdentityChanged`] when
/// it serves another remote address or noise key; any other
/// [`EnrolmentError`] from `relay_client` or the relay's site; or a registry
/// failure. Nothing is written on any of them.
pub async fn set_server_credentials<S: RelayClient>(
    registry: Arc<dyn ServerRegistry>,
    domain: &str,
    token: TunnelToken,
    relay_client: impl FnOnce(Url) -> Result<S, EnrolmentError>,
) -> Result<ServerRecord, EnrolmentError> {
    let wanted_domain = domain.to_owned();
    let registered = run_blocking(Arc::clone(&registry), move |registry| {
        registry.read(&wanted_domain)
    })
    .await?;
    let public_settings = match registered.relay.site_base_url() {
        None => registered.public_settings.clone(),
        Some(relay_base) => {
            let relay_client = relay_client(relay_base)?;
            let registered_settings = &registered.public_settings;
            let public_settings = expected_public_settings(&relay_client, |served| {
                if served.domain != registered_settings.domain {
                    return Err(EnrolmentError::DomainChanged {
                        registered: registered_settings.domain.clone(),
                        served: served.domain.clone(),
                    });
                }
                let registered_identity = RelayIdentity::of(registered_settings);
                if let Some((setting, registered, served)) =
                    registered_identity.first_difference(served)
                {
                    return Err(EnrolmentError::RelayIdentityChanged {
                        setting,
                        registered,
                        served,
                    });
                }
                Ok(())
            })
            .await?;
            confirm_tunnel(
                &relay_client,
                &registered.tunnel_name,
                &token,
                &public_settings.domain,
            )
            .await?;
            public_settings
        }
    };
    let wanted_domain = domain.to_owned();
    let record = run_blocking(registry, move |registry| {
        registry.modify(Box::new(|servers| {
            let current = registered_mut(servers, &wanted_domain)?;
            current.token = token;
            current.public_settings = public_settings;
            Ok(())
        }))?;
        registry.read(&wanted_domain)
    })
    .await?;
    Ok(record)
}

/// An entered self-hosted relay's base URL, if a relay site can be asked
/// there: an absolute `https` URL with a host, and no credentials, query or
/// fragment, since the signed requests are made under it.
///
/// # Errors
///
/// [`EnrolmentError::InvalidRelaySetting`] for `baseUrl`, saying why.
fn parse_base_url(entered: &str) -> Result<Url, EnrolmentError> {
    let invalid = |reason: String| EnrolmentError::InvalidRelaySetting {
        setting: "baseUrl",
        reason,
    };
    let base_url = Url::parse(entered)
        .map_err(|error| invalid(format!("{entered:?} is not a URL: {error}")))?;
    if base_url.scheme() != "https" {
        return Err(invalid(format!("{entered:?} is not an https URL")));
    }
    if base_url.host_str().is_none_or(str::is_empty) {
        return Err(invalid(format!("{entered:?} has no host")));
    }
    if !base_url.username().is_empty() || base_url.password().is_some() {
        return Err(invalid(format!("{entered:?} holds credentials")));
    }
    if base_url.query().is_some() || base_url.fragment().is_some() {
        return Err(invalid(format!("{entered:?} has a query or fragment")));
    }
    Ok(base_url)
}

/// The relay's `GET /rathole`, checked and passed to `expect`, which refuses
/// it if it isn't the relay expected.
async fn expected_public_settings(
    relay_client: &impl RelayClient,
    expect: impl FnOnce(&PublicRatholeSettings) -> Result<(), EnrolmentError>,
) -> Result<PublicRatholeSettings, EnrolmentError> {
    let public_settings =
        checked_relay_settings(relay_client.public_settings().await?).map_err(|problem| {
            EnrolmentError::BadRelayResponse {
                path: "/rathole",
                reason: format!("{} {}", problem.setting, problem.reason),
            }
        })?;
    expect(&public_settings)?;
    Ok(public_settings)
}

/// The tunnel `credentials` stand for at the Wildflower relay
/// `relay_client` asks, confirmed: its `GET /rathole`, checked and passed to
/// `expect`; then, for a claim code, its `POST /claim`, or, for an access
/// code, its `POST /access`, which must send the settings `GET /rathole`
/// served, for the tunnel name and token, and nothing more is asked; for a
/// tunnel name and token, a signed `GET /me`, which
/// confirms the relay holds them. `expect` runs before the code is redeemed
/// or the signed request is sent.
async fn enrolled_tunnel(
    relay_client: &impl RelayClient,
    credentials: CheckedCredentials,
    expect: impl FnOnce(&PublicRatholeSettings) -> Result<(), EnrolmentError>,
) -> Result<EnrolledTunnel, EnrolmentError> {
    let public_settings = expected_public_settings(relay_client, expect).await?;
    let (tunnel_name, token) = match credentials {
        CheckedCredentials::ClaimCode(code) => {
            let ClaimedTunnel {
                tunnel_name,
                token,
                rathole_settings,
            } = relay_client.claim(&code).await?;
            check_claimed_settings(&rathole_settings, &public_settings, "/claim")?;
            (tunnel_name, TunnelToken::new(token))
        }
        CheckedCredentials::AccessCode(request) => {
            let ClaimedTunnel {
                tunnel_name,
                token,
                rathole_settings,
            } = relay_client.access(&request).await?;
            check_claimed_settings(&rathole_settings, &public_settings, "/access")?;
            (tunnel_name, TunnelToken::new(token))
        }
        CheckedCredentials::Token { tunnel_name, token } => {
            confirm_tunnel(relay_client, &tunnel_name, &token, &public_settings.domain).await?;
            (tunnel_name, token)
        }
    };
    Ok(EnrolledTunnel {
        tunnel_name,
        token,
        public_settings,
    })
}

/// A signed `GET /me` confirms the relay holds `tunnel_name` and `token`, at
/// `<tunnel name>.<relay_domain>`.
async fn confirm_tunnel(
    relay_client: &impl RelayClient,
    tunnel_name: &TunnelName,
    token: &TunnelToken,
    relay_domain: &str,
) -> Result<(), EnrolmentError> {
    let tunnel_host = relay_client.tunnel_host(tunnel_name, token).await?;
    check_tunnel_host(&tunnel_host, tunnel_name, relay_domain)
}

/// Whether `POST /claim` or `POST /access`, `path`, sent the settings the
/// relay's `GET /rathole` served, `public_settings`: the same domain, dial
/// address and noise key.
fn check_claimed_settings(
    claimed_settings: &PublicRatholeSettings,
    public_settings: &PublicRatholeSettings,
    path: &'static str,
) -> Result<(), EnrolmentError> {
    let difference = if claimed_settings.domain == public_settings.domain {
        RelayIdentity::of(public_settings).first_difference(claimed_settings)
    } else {
        Some((
            "domain",
            public_settings.domain.clone(),
            claimed_settings.domain.clone(),
        ))
    };
    match difference {
        None => Ok(()),
        Some((setting, served, claimed)) => Err(EnrolmentError::BadRelayResponse {
            path,
            reason: format!("it sends {setting} {claimed:?}, not the {served:?} /rathole serves"),
        }),
    }
}

/// A relay setting a server can't be built on: the `setting`, named as the
/// command's arguments name it, and why.
struct RelaySettingProblem {
    setting: &'static str,
    reason: String,
}

/// Relay settings, served by `GET /rathole` or entered by hand, if a server
/// can be built on them: the `domain` is a [`RelayDomain`], since it ends the
/// server's domain and folder name, the `remote_addr` a `host:port` as
/// [`parse_public_addr`] reads one (and is case-folded by it), and the
/// `public_key` 32 bytes of base64, as `rathole --genkey` prints an X25519
/// key. These are the checks the relay applies to its own settings.
fn checked_relay_settings(
    public_settings: PublicRatholeSettings,
) -> Result<PublicRatholeSettings, RelaySettingProblem> {
    if let Err(error) = RelayDomain::parse(public_settings.domain.as_str()) {
        return Err(RelaySettingProblem {
            setting: "domain",
            reason: format!("{:?} is not a lowercase DNS name", error.domain),
        });
    }
    let remote_addr =
        parse_public_addr(&public_settings.remote_addr).map_err(|error| RelaySettingProblem {
            setting: "remoteAddr",
            reason: format!(
                "{:?} is not a usable host:port: {error}",
                public_settings.remote_addr
            ),
        })?;
    let public_key = &public_settings.public_key;
    let key_is_valid = BASE64
        .decode(public_key)
        .is_ok_and(|bytes| bytes.len() == 32);
    if !key_is_valid {
        return Err(RelaySettingProblem {
            setting: "publicKey",
            reason: format!("{public_key:?} is not 32 bytes of base64"),
        });
    }
    Ok(PublicRatholeSettings {
        remote_addr,
        ..public_settings
    })
}

/// Whether `GET /me` named the tunnel that signed, at `<tunnel name>.<domain>`
/// for the `domain` `GET /rathole` served.
fn check_tunnel_host(
    tunnel_host: &TunnelHost,
    tunnel_name: &TunnelName,
    domain: &str,
) -> Result<(), EnrolmentError> {
    let expected_server_domain = format!("{tunnel_name}.{domain}");
    if tunnel_host.tunnel_name != *tunnel_name || tunnel_host.public_host != expected_server_domain
    {
        return Err(EnrolmentError::BadRelayResponse {
            path: "/me",
            reason: format!(
                "it names {:?} at {:?}, not {:?} at {expected_server_domain:?}",
                tunnel_host.tunnel_name.as_str(),
                tunnel_host.public_host,
                tunnel_name.as_str()
            ),
        });
    }
    Ok(())
}

/// Run `operation` on the registry on a blocking thread, as the
/// [`ServerRegistry`] port asks of an async caller.
async fn run_blocking<T: Send + 'static>(
    registry: Arc<dyn ServerRegistry>,
    operation: impl FnOnce(&dyn ServerRegistry) -> Result<T, RegistryError> + Send + 'static,
) -> Result<T, RegistryError> {
    tokio::task::spawn_blocking(move || operation(registry.as_ref()))
        .await
        .map_err(|error| RegistryError::storage("running a registry operation", error))?
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::domain::fixtures::{
        authorization_url, launcher_url, official_record, token_credentials, TOKEN,
    };
    use crate::CertificateAuthority;
    use crate::JsonServerRegistry;

    const RELAY_DOMAIN: &str = "relay.example.com";
    const PUBLIC_KEY: &str = "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=";
    /// The claim code the fake relay redeems for `ruth` and [`TOKEN`].
    const CLAIM_CODE: &str = "ABCD-EFGH";
    /// The access code the fake relay redeems for a new tunnel with
    /// [`TOKEN`].
    const ACCESS_CODE: &str = "JKMN-PQRS";
    /// The name the fake relay draws for an access code redeemed without
    /// one.
    const DRAWN_NAME: &str = "drawn-name";

    fn served_settings() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: format!("{RELAY_DOMAIN}:2333"),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: PUBLIC_KEY.to_owned(),
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    /// A relay client that serves `public_settings` (or is unreachable when
    /// there are none), accepts `ruth` with [`TOKEN`], redeems
    /// [`CLAIM_CODE`] for them, answers [`ACCESS_CODE`] at `POST /claim` as
    /// an access code and redeems it at `POST /access` for the requested
    /// tunnel name, or [`DRAWN_NAME`], with [`TOKEN`]. Clones share their
    /// counts, so a test keeps one while enrolment gets another.
    #[derive(Clone)]
    struct FakeRelayClient {
        public_settings: Option<PublicRatholeSettings>,
        /// What `GET /me` answers, in place of the signing tunnel's host.
        tunnel_host: Option<TunnelHost>,
        /// How many `GET /me` requests were made.
        tunnel_host_fetches: Arc<AtomicUsize>,
        /// The code of every `POST /claim`, in order.
        claimed_codes: Arc<Mutex<Vec<String>>>,
        /// What `POST /claim` fails with, in place of redeeming.
        claim_refusal: Option<fn() -> EnrolmentError>,
        /// The body of every `POST /access`, in order.
        access_requests: Arc<Mutex<Vec<AccessRequest>>>,
        /// The settings `POST /claim` sends, in place of `public_settings`.
        claimed_settings: Option<PublicRatholeSettings>,
        /// The base URL of every relay client built for enrolment.
        built_for: Arc<Mutex<Vec<Url>>>,
        /// Run while `GET /me` is in flight, before it answers: a change
        /// another command makes during the relay's round trip.
        while_asked: Option<Arc<dyn Fn() + Send + Sync>>,
    }

    impl FakeRelayClient {
        fn serving(public_settings: PublicRatholeSettings) -> Self {
            Self {
                public_settings: Some(public_settings),
                tunnel_host: None,
                tunnel_host_fetches: Arc::default(),
                claimed_codes: Arc::default(),
                claim_refusal: None,
                access_requests: Arc::default(),
                claimed_settings: None,
                built_for: Arc::default(),
                while_asked: None,
            }
        }

        /// What enrolment builds its relay client with: this fake, for any base
        /// URL.
        fn builder(&self) -> impl FnOnce(Url) -> Result<Self, EnrolmentError> + '_ {
            |relay_base| {
                self.built_for.lock().unwrap().push(relay_base);
                Ok(self.clone())
            }
        }

        fn built_for(&self) -> Vec<Url> {
            self.built_for.lock().unwrap().clone()
        }

        fn claimed_codes(&self) -> Vec<String> {
            self.claimed_codes.lock().unwrap().clone()
        }

        fn access_requests(&self) -> Vec<AccessRequest> {
            self.access_requests.lock().unwrap().clone()
        }

        /// The settings a redeemed code sends.
        fn claimed_settings(&self) -> PublicRatholeSettings {
            self.claimed_settings
                .clone()
                .or_else(|| self.public_settings.clone())
                .unwrap()
        }
    }

    #[async_trait::async_trait]
    impl RelayClient for FakeRelayClient {
        async fn public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError> {
            self.public_settings
                .clone()
                .ok_or_else(|| EnrolmentError::RelayUnreachable {
                    relay_base: Url::parse(&format!("https://{RELAY_DOMAIN}")).unwrap(),
                    source: "connection refused".into(),
                })
        }

        async fn tunnel_host(
            &self,
            tunnel_name: &TunnelName,
            token: &TunnelToken,
        ) -> Result<TunnelHost, EnrolmentError> {
            self.tunnel_host_fetches.fetch_add(1, Ordering::SeqCst);
            if let Some(while_asked) = &self.while_asked {
                while_asked();
            }
            if tunnel_name.as_str() != "ruth" || token.expose() != TOKEN {
                return Err(EnrolmentError::SignedRequestRejected {
                    tunnel_name: tunnel_name.clone(),
                });
            }
            let domain = &self.public_settings.as_ref().unwrap().domain;
            Ok(self.tunnel_host.clone().unwrap_or_else(|| TunnelHost {
                tunnel_name: tunnel_name.clone(),
                public_host: format!("{tunnel_name}.{domain}"),
            }))
        }

        async fn claim(&self, code: &str) -> Result<ClaimedTunnel, EnrolmentError> {
            self.claimed_codes.lock().unwrap().push(code.to_owned());
            if let Some(claim_refusal) = self.claim_refusal {
                return Err(claim_refusal());
            }
            if code == ACCESS_CODE {
                return Err(EnrolmentError::AccessCodeNeedsDetails);
            }
            if code != CLAIM_CODE {
                return Err(EnrolmentError::ClaimCodeRejected);
            }
            Ok(ClaimedTunnel {
                tunnel_name: ruth(),
                token: TOKEN.to_owned(),
                rathole_settings: self.claimed_settings(),
            })
        }

        async fn access(&self, request: &AccessRequest) -> Result<ClaimedTunnel, EnrolmentError> {
            self.access_requests.lock().unwrap().push(request.clone());
            if request.code != ACCESS_CODE {
                return Err(EnrolmentError::AccessRefused {
                    reason: "the access code is unknown, used or expired".to_owned(),
                });
            }
            let tunnel_name = request.tunnel_name.as_deref().unwrap_or(DRAWN_NAME);
            Ok(ClaimedTunnel {
                tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
                token: TOKEN.to_owned(),
                rathole_settings: self.claimed_settings(),
            })
        }
    }

    /// A builder for relays that have no relay client to build.
    fn no_client(relay_base: Url) -> Result<FakeRelayClient, EnrolmentError> {
        panic!("built a relay client for {relay_base}")
    }

    fn registry() -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = Arc::new(JsonServerRegistry::in_data_root(
            data_root.path(),
            authorization_url(),
        ));
        (data_root, registry)
    }

    fn self_hosted_base_url() -> Url {
        Url::parse(&format!("https://{RELAY_DOMAIN}")).unwrap()
    }

    fn self_hosted_relay(pin: Option<RelayIdentity>) -> EnteredRelay {
        EnteredRelay::SelfHostedWildflower {
            base_url: format!("https://{RELAY_DOMAIN}"),
            pin,
        }
    }

    fn rathole_relay() -> EnteredRelay {
        EnteredRelay::Rathole {
            identity: RelayIdentity {
                remote_addr: format!("{RELAY_DOMAIN}:2333"),
                public_key: PUBLIC_KEY.to_owned(),
            },
            domain: RELAY_DOMAIN.to_owned(),
        }
    }

    fn ruth() -> TunnelName {
        TunnelName::parse("ruth").unwrap()
    }

    /// The moment every enrolment in these tests happens at.
    fn now() -> DateTime<Utc> {
        use chrono::TimeZone;
        Utc.with_ymd_and_hms(2026, 10, 6, 17, 0, 0).unwrap()
    }

    async fn add(
        registry: &Arc<dyn ServerRegistry>,
        relay_client: &FakeRelayClient,
        relay: EnteredRelay,
        token: &str,
    ) -> Result<ServerRecord, EnrolmentError> {
        add_server(
            Arc::clone(registry),
            relay,
            token_credentials("ruth", token),
            launcher_url(),
            authorization_url(),
            relay_client.builder(),
            now(),
        )
        .await
    }

    async fn add_claiming(
        registry: &Arc<dyn ServerRegistry>,
        relay_client: &FakeRelayClient,
        relay: EnteredRelay,
        code: &str,
    ) -> Result<ServerRecord, EnrolmentError> {
        add_server(
            Arc::clone(registry),
            relay,
            EnteredCredentials::ClaimCode {
                code: code.to_owned(),
            },
            launcher_url(),
            authorization_url(),
            relay_client.builder(),
            now(),
        )
        .await
    }

    async fn add_with_access_code(
        registry: &Arc<dyn ServerRegistry>,
        relay_client: &FakeRelayClient,
        relay: EnteredRelay,
        email: &str,
        tunnel_name: Option<&str>,
    ) -> Result<ServerRecord, EnrolmentError> {
        add_server(
            Arc::clone(registry),
            relay,
            EnteredCredentials::AccessCode {
                code: format!(" {ACCESS_CODE} "),
                email: email.to_owned(),
                tunnel_name: tunnel_name.map(str::to_owned),
            },
            launcher_url(),
            authorization_url(),
            relay_client.builder(),
            now(),
        )
        .await
    }

    /// An access code entered as a claim code is answered as one, with
    /// nothing written, so the user can enter an email and subdomain.
    #[tokio::test]
    async fn an_access_code_entered_as_a_claim_code_asks_for_details() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let result = add_claiming(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            ACCESS_CODE,
        )
        .await;
        assert_eq!(result.unwrap_err().kind(), "accessCodeNeedsDetails");
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    /// An access code is redeemed at `POST /access` with the email and
    /// subdomain chosen, trimmed, for the new tunnel, which is stored as if
    /// its name and token had been entered.
    #[tokio::test]
    async fn adds_a_server_from_an_access_code() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add_with_access_code(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            " ruth@example.com\n",
            Some("ruth"),
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::WildflowerOfficial,
                tunnel_name: ruth(),
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                launcher_url: launcher_url(),
                authorization_url: authorization_url(),
                certificate_authority: ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY,
                run_policy: RunPolicy::WhileOpen,
            }
        );
        assert_eq!(
            relay_client.access_requests(),
            vec![AccessRequest {
                code: ACCESS_CODE.to_owned(),
                email: "ruth@example.com".to_owned(),
                tunnel_name: Some("ruth".to_owned()),
            }]
        );
        assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// Without a subdomain the server takes the name the relay drew.
    #[tokio::test]
    async fn an_access_code_without_a_subdomain_takes_the_relay_s_name() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let record = add_with_access_code(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            "ruth@example.com",
            None,
        )
        .await
        .unwrap();
        assert_eq!(record.domain(), format!("{DRAWN_NAME}.{RELAY_DOMAIN}"));
        assert_eq!(relay_client.access_requests()[0].tunnel_name, None);
    }

    /// A blank email, a subdomain that isn't a tunnel name, or a rathole
    /// relay, which redeems no codes, is refused before any relay is asked.
    #[tokio::test]
    async fn access_code_details_are_checked_before_a_request() {
        for (relay, email, tunnel_name, kind) in [
            (
                EnteredRelay::WildflowerOfficial,
                " ",
                Some("ruth"),
                "emptyEmail",
            ),
            (
                EnteredRelay::WildflowerOfficial,
                "ruth@example.com",
                Some("Ruth"),
                "invalidTunnelName",
            ),
            (
                EnteredRelay::WildflowerOfficial,
                "ruth@example.com",
                Some("admin"),
                "invalidTunnelName",
            ),
            (
                rathole_relay(),
                "ruth@example.com",
                None,
                "claimCodesNotOffered",
            ),
        ] {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                relay,
                EnteredCredentials::AccessCode {
                    code: ACCESS_CODE.to_owned(),
                    email: email.to_owned(),
                    tunnel_name: tunnel_name.map(str::to_owned),
                },
                launcher_url(),
                authorization_url(),
                no_client,
                now(),
            )
            .await;
            assert_eq!(
                result.unwrap_err().kind(),
                kind,
                "{email:?} {tunnel_name:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    /// A refused access code writes nothing; one whose answer sends other
    /// settings than `GET /rathole` served is a bad `/access` response.
    #[tokio::test]
    async fn a_refused_or_mismatched_access_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let result = add_server(
            Arc::clone(&registry),
            EnteredRelay::WildflowerOfficial,
            EnteredCredentials::AccessCode {
                code: "WXYZ-2345".to_owned(),
                email: "ruth@example.com".to_owned(),
                tunnel_name: None,
            },
            launcher_url(),
            authorization_url(),
            relay_client.builder(),
            now(),
        )
        .await;
        assert_eq!(
            result.unwrap_err().to_string(),
            "the relay refused the access code: the access code is unknown, used or expired"
        );
        assert_eq!(registry.read_all().unwrap(), Vec::new());

        let relay_client = FakeRelayClient {
            claimed_settings: Some(PublicRatholeSettings {
                domain: "elsewhere.example.com".to_owned(),
                ..served_settings()
            }),
            ..FakeRelayClient::serving(served_settings())
        };
        let result = add_with_access_code(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            "ruth@example.com",
            Some("ruth"),
        )
        .await;
        assert!(
            matches!(
                &result,
                Err(EnrolmentError::BadRelayResponse {
                    path: "/access",
                    ..
                })
            ),
            "{result:?}"
        );
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    /// A claim code is redeemed for the tunnel name and token, which are
    /// stored as if they had been entered; the code is trimmed and kept
    /// nowhere.
    #[tokio::test]
    async fn adds_a_server_from_a_claim_code() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add_claiming(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            &format!("  {CLAIM_CODE}\n"),
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::WildflowerOfficial,
                tunnel_name: ruth(),
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                launcher_url: launcher_url(),
                authorization_url: authorization_url(),
                certificate_authority: ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY,
                run_policy: RunPolicy::WhileOpen,
            }
        );
        assert_eq!(relay_client.claimed_codes(), vec![CLAIM_CODE.to_owned()]);
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// A claimed tunnel is added without a signed `GET /me`: one that would
    /// be refused, as a skewed clock's would, never fails the spent code.
    #[tokio::test]
    async fn a_claimed_tunnel_is_added_without_a_signed_me() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient {
            tunnel_host: Some(TunnelHost {
                tunnel_name: TunnelName::parse("someone-else").unwrap(),
                public_host: "elsewhere.example.com".to_owned(),
            }),
            ..FakeRelayClient::serving(served_settings())
        };

        let record = add_claiming(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            CLAIM_CODE,
        )
        .await
        .unwrap();

        assert_eq!(record.domain(), format!("ruth.{RELAY_DOMAIN}"));
        assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// The relay's identity is confirmed before its code is spent: a relay
    /// that doesn't serve the pin, or serves settings no server can be
    /// built on, is never sent the code.
    #[tokio::test]
    async fn a_claim_code_is_never_sent_to_a_relay_that_fails_its_checks() {
        let pinned_elsewhere = self_hosted_relay(Some(RelayIdentity {
            remote_addr: "relay.example.com:7000".to_owned(),
            public_key: PUBLIC_KEY.to_owned(),
        }));
        let unusable = PublicRatholeSettings {
            public_key: "AAAA".to_owned(),
            ..served_settings()
        };
        for (relay, public_settings, kind) in [
            (pinned_elsewhere, served_settings(), "pinMismatch"),
            (self_hosted_relay(None), unusable, "badRelayResponse"),
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient::serving(public_settings);
            let result = add_claiming(&registry, &relay_client, relay, CLAIM_CODE).await;
            assert_eq!(result.unwrap_err().kind(), kind);
            assert_eq!(relay_client.claimed_codes(), Vec::<String>::new());
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_claim_the_relay_refuses_writes_nothing() {
        for (claim_refusal, kind) in [
            (None, "claimCodeRejected"),
            (
                Some((|| EnrolmentError::ClaimRateLimited) as fn() -> EnrolmentError),
                "claimRateLimited",
            ),
            (
                Some((|| EnrolmentError::ClaimCodesNotOffered) as fn() -> EnrolmentError),
                "claimCodesNotOffered",
            ),
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient {
                claim_refusal,
                ..FakeRelayClient::serving(served_settings())
            };
            let result = add_claiming(
                &registry,
                &relay_client,
                EnteredRelay::WildflowerOfficial,
                "WXYZ-2345",
            )
            .await;
            assert_eq!(result.unwrap_err().kind(), kind);
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    /// `POST /claim` sends the relay's settings too; ones that aren't what
    /// its `GET /rathole` served are a bad response.
    #[tokio::test]
    async fn a_claim_sending_other_settings_than_rathole_is_a_bad_response() {
        for (setting, claimed_settings) in [
            (
                "domain",
                PublicRatholeSettings {
                    domain: "elsewhere.example.com".to_owned(),
                    ..served_settings()
                },
            ),
            (
                "remoteAddr",
                PublicRatholeSettings {
                    remote_addr: "relay.example.com:7000".to_owned(),
                    ..served_settings()
                },
            ),
            (
                "publicKey",
                PublicRatholeSettings {
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                    ..served_settings()
                },
            ),
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient {
                claimed_settings: Some(claimed_settings),
                ..FakeRelayClient::serving(served_settings())
            };
            let result = add_claiming(
                &registry,
                &relay_client,
                EnteredRelay::WildflowerOfficial,
                CLAIM_CODE,
            )
            .await;
            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::BadRelayResponse { path: "/claim", reason })
                        if reason.contains(setting)
                ),
                "{setting}: {result:?}"
            );
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    /// A claim code is refused before any relay is asked when it is blank,
    /// or entered for a rathole relay, which redeems none.
    #[tokio::test]
    async fn a_blank_claim_code_or_one_for_a_rathole_relay_is_refused_without_a_request() {
        for (relay, code, kind) in [
            (EnteredRelay::WildflowerOfficial, " \t ", "emptyClaimCode"),
            (rathole_relay(), CLAIM_CODE, "claimCodesNotOffered"),
        ] {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                relay,
                EnteredCredentials::ClaimCode {
                    code: code.to_owned(),
                },
                launcher_url(),
                authorization_url(),
                no_client,
                now(),
            )
            .await;
            assert_eq!(result.unwrap_err().kind(), kind);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    /// The entered tunnel name and token are checked before any relay is
    /// asked: the name is one DNS label, and the token is trimmed.
    #[tokio::test]
    async fn entered_token_credentials_are_checked_before_a_request() {
        for (tunnel_name, token, kind) in [
            ("Ruth", TOKEN, "invalidTunnelName"),
            ("admin", TOKEN, "invalidTunnelName"),
            ("ruth", " \n ", "emptyToken"),
        ] {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                EnteredRelay::WildflowerOfficial,
                token_credentials(tunnel_name, token),
                launcher_url(),
                authorization_url(),
                no_client,
                now(),
            )
            .await;
            assert_eq!(
                result.unwrap_err().kind(),
                kind,
                "{tunnel_name:?} {token:?}"
            );
        }
        let (_data_root, registry) = registry();
        let record = add(
            &registry,
            &FakeRelayClient::serving(served_settings()),
            EnteredRelay::WildflowerOfficial,
            &format!(" {TOKEN}\n"),
        )
        .await
        .unwrap();
        assert_eq!(record.token, TunnelToken::new(TOKEN));
    }

    #[test]
    fn entered_credentials_decode_from_camel_case_json_and_debug_without_secrets() {
        for (json, credentials) in [
            (
                serde_json::json!({"kind": "claimCode", "code": CLAIM_CODE}),
                EnteredCredentials::ClaimCode {
                    code: CLAIM_CODE.to_owned(),
                },
            ),
            (
                serde_json::json!({"kind": "token", "tunnelName": "ruth", "token": TOKEN}),
                token_credentials("ruth", TOKEN),
            ),
            (
                serde_json::json!({
                    "kind": "accessCode",
                    "code": CLAIM_CODE,
                    "email": "ruth@example.com",
                    "tunnelName": "ruth",
                }),
                EnteredCredentials::AccessCode {
                    code: CLAIM_CODE.to_owned(),
                    email: "ruth@example.com".to_owned(),
                    tunnel_name: Some("ruth".to_owned()),
                },
            ),
        ] {
            let decoded = serde_json::from_value::<EnteredCredentials>(json.clone()).unwrap();
            assert_eq!(decoded, credentials, "{json}");
            let debugged = format!("{decoded:?}");
            assert!(
                !debugged.contains(CLAIM_CODE) && !debugged.contains(TOKEN),
                "{debugged}"
            );
        }
        for json in [
            serde_json::json!({"kind": "token", "tunnel_name": "ruth", "token": TOKEN}),
            serde_json::json!({"kind": "claimCode", "code": CLAIM_CODE, "tunnelName": "ruth"}),
            serde_json::json!({"kind": "token", "tunnelName": "ruth"}),
            serde_json::json!({"kind": "claim", "code": CLAIM_CODE}),
            serde_json::json!({"kind": "accessCode", "code": CLAIM_CODE}),
            serde_json::json!({
                "kind": "accessCode",
                "code": CLAIM_CODE,
                "email": "ruth@example.com",
                "tunnel_name": "ruth",
            }),
        ] {
            assert!(
                serde_json::from_value::<EnteredCredentials>(json.clone()).is_err(),
                "{json}"
            );
        }
    }

    /// The credentials the base sends `server_add` decode as the golden
    /// file names them.
    #[test]
    fn the_entered_credentials_decode_as_the_golden_file_says() {
        let golden = crate::domain::golden();
        let credentials = [
            (
                "claimCode",
                EnteredCredentials::ClaimCode {
                    code: CLAIM_CODE.to_owned(),
                },
            ),
            ("token", token_credentials("ruth", "tunnel-token")),
            (
                "accessCode",
                EnteredCredentials::AccessCode {
                    code: CLAIM_CODE.to_owned(),
                    email: "ruth@example.com".to_owned(),
                    tunnel_name: Some("ruth".to_owned()),
                },
            ),
            (
                "accessCodeWithoutTunnelName",
                EnteredCredentials::AccessCode {
                    code: CLAIM_CODE.to_owned(),
                    email: "ruth@example.com".to_owned(),
                    tunnel_name: None,
                },
            ),
        ];
        for (name, entered) in &credentials {
            assert_eq!(
                &serde_json::from_value::<EnteredCredentials>(
                    golden["enteredCredentials"][name].clone()
                )
                .unwrap(),
                entered,
                "{name}"
            );
        }
        assert_eq!(
            golden["enteredCredentials"].as_object().unwrap().len(),
            credentials.len(),
            "every golden credential is checked"
        );
    }

    #[tokio::test]
    async fn adds_a_server_from_the_relay_s_settings() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::SelfHostedWildflower {
                    base_url: self_hosted_base_url()
                },
                tunnel_name: ruth(),
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                launcher_url: launcher_url(),
                authorization_url: authorization_url(),
                certificate_authority: ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY,
                run_policy: RunPolicy::WhileOpen,
            }
        );
        assert_eq!(record.domain(), "ruth.relay.example.com");
        assert_eq!(relay_client.built_for(), vec![self_hosted_base_url()]);
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn the_official_relay_is_asked_at_its_own_site() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = add(
            &registry,
            &relay_client,
            EnteredRelay::WildflowerOfficial,
            TOKEN,
        )
        .await
        .unwrap();

        assert_eq!(record.relay, RelayKind::WildflowerOfficial);
        assert_eq!(
            relay_client.built_for(),
            vec![RelayKind::wildflower_base_url()]
        );
    }

    /// A self-hosted relay's site host and the domain it serves tunnels
    /// under are independent: its relay site may live anywhere.
    #[tokio::test]
    async fn a_self_hosted_relay_s_site_need_not_be_at_the_domain_it_serves() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(PublicRatholeSettings {
            domain: "tunnels.example.org".to_owned(),
            ..served_settings()
        });

        let record = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert_eq!(record.domain(), "ruth.tunnels.example.org");
        assert_eq!(
            record.relay,
            RelayKind::SelfHostedWildflower {
                base_url: self_hosted_base_url()
            }
        );
    }

    #[tokio::test]
    async fn a_matching_pin_is_accepted_and_not_stored() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let relay_pin = RelayIdentity {
            remote_addr: "Relay.Example.com:2333".to_owned(),
            public_key: PUBLIC_KEY.to_owned(),
        };

        let record = add(
            &registry,
            &relay_client,
            self_hosted_relay(Some(relay_pin)),
            TOKEN,
        )
        .await
        .unwrap();

        assert_eq!(record.public_settings, served_settings());
        assert_eq!(
            record.relay,
            RelayKind::SelfHostedWildflower {
                base_url: self_hosted_base_url()
            }
        );
    }

    #[tokio::test]
    async fn a_pin_the_relay_does_not_serve_fails_before_the_signed_request() {
        for (relay_pin, mismatched) in [
            (
                RelayIdentity {
                    remote_addr: "relay.example.com:7000".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                },
                "remoteAddr",
            ),
            (
                RelayIdentity {
                    remote_addr: served_settings().remote_addr,
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                },
                "publicKey",
            ),
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient::serving(served_settings());
            let result = add(
                &registry,
                &relay_client,
                self_hosted_relay(Some(relay_pin)),
                TOKEN,
            )
            .await;
            assert!(
                matches!(result, Err(EnrolmentError::PinMismatch { setting, .. }) if setting == mismatched),
                "{mismatched}"
            );
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn an_unreachable_relay_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient {
            public_settings: None,
            ..FakeRelayClient::serving(served_settings())
        };
        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_site_that_cannot_be_built_writes_nothing() {
        let (_data_root, registry) = registry();
        let result = add_server(
            Arc::clone(&registry),
            self_hosted_relay(None),
            token_credentials("ruth", TOKEN),
            launcher_url(),
            authorization_url(),
            |relay_base| -> Result<FakeRelayClient, _> {
                Err(EnrolmentError::RelayUnreachable {
                    relay_base,
                    source: "no TLS backend".into(),
                })
            },
            now(),
        )
        .await;
        assert!(matches!(
            result,
            Err(EnrolmentError::RelayUnreachable { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn a_rejected_token_writes_nothing() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), "not-the-token").await,
            Err(EnrolmentError::SignedRequestRejected { tunnel_name }) if tunnel_name == ruth()
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    /// Relay settings a server can't be built on, each with the setting it
    /// breaks.
    fn bad_settings() -> Vec<(&'static str, PublicRatholeSettings)> {
        let with = |setting: &'static str, value: &str| {
            let mut public_settings = served_settings();
            match setting {
                "domain" => public_settings.domain = value.to_owned(),
                "remoteAddr" => public_settings.remote_addr = value.to_owned(),
                _ => public_settings.public_key = value.to_owned(),
            }
            (setting, public_settings)
        };
        vec![
            with("domain", "Relay.example.com"),
            with("domain", "../relay"),
            with("domain", ""),
            with("remoteAddr", "relay.example.com"),
            with("remoteAddr", "relay.example.com:0"),
            with("remoteAddr", ":2333"),
            with("remoteAddr", "relay example.com:2333"),
            with("remoteAddr", "a:b:2333"),
            with("remoteAddr", "[bad:2333"),
            with("remoteAddr", "\"relay\".example.com:2333"),
            with("remoteAddr", "relay.example.com:2333\n"),
            with("publicKey", ""),
            with("publicKey", "not base64!"),
            with("publicKey", "AAAA"),
        ]
    }

    #[tokio::test]
    async fn rathole_settings_a_server_cannot_be_built_on_are_a_bad_response() {
        for (setting, public_settings) in bad_settings() {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient::serving(public_settings.clone());
            let result = add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await;
            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::BadRelayResponse {
                        path: "/rathole",
                        reason,
                    }) if reason.starts_with(setting)
                ),
                "{public_settings:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_me_response_naming_another_tunnel_or_host_is_a_bad_response() {
        for tunnel_host in [
            TunnelHost {
                tunnel_name: TunnelName::parse("someone-else").unwrap(),
                public_host: "ruth.relay.example.com".to_owned(),
            },
            TunnelHost {
                tunnel_name: TunnelName::parse("ruth").unwrap(),
                public_host: "ruth.elsewhere.example.com".to_owned(),
            },
        ] {
            let (_data_root, registry) = registry();
            let relay_client = FakeRelayClient {
                tunnel_host: Some(tunnel_host.clone()),
                ..FakeRelayClient::serving(served_settings())
            };
            assert!(
                matches!(
                    add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
                    Err(EnrolmentError::BadRelayResponse { path: "/me", .. })
                ),
                "{tunnel_host:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn adding_a_server_that_exists_is_refused() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let existing = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert!(matches!(
            add(&registry, &relay_client, self_hosted_relay(None), TOKEN).await,
            Err(EnrolmentError::Registry(RegistryError::AlreadyRegistered { domain }))
                if domain == "ruth.relay.example.com"
        ));
        assert_eq!(registry.read_all().unwrap(), vec![existing]);
    }

    /// The first server added runs while the app is present; a later one is
    /// added off, so it doesn't start alongside the first.
    #[tokio::test]
    async fn the_first_server_added_runs_while_open_and_a_later_one_is_off() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());

        let first = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();
        let second = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            token_credentials("lab", "any-token"),
            launcher_url(),
            authorization_url(),
            no_client,
            now(),
        )
        .await
        .unwrap();

        assert_eq!(first.run_policy, RunPolicy::WhileOpen);
        assert_eq!(second.run_policy, RunPolicy::Off);
        assert_eq!(registry.read_all().unwrap(), vec![first, second]);
    }

    /// Servers whose policies want none of them running, an `Until` that has
    /// passed included, don't stop the next one added from running.
    #[tokio::test]
    async fn a_server_added_while_no_policy_wants_running_runs_while_open() {
        let (_data_root, registry) = registry();
        let off = official_record("lab");
        let ended = ServerRecord {
            run_policy: RunPolicy::Until {
                at: now() - chrono::TimeDelta::minutes(1),
            },
            ..official_record("demo")
        };
        for record in [&off, &ended] {
            registry.insert(Box::new(|_| record.clone())).unwrap();
        }
        let relay_client = FakeRelayClient::serving(served_settings());

        let added = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
            .await
            .unwrap();

        assert_eq!(added.run_policy, RunPolicy::WhileOpen);
        assert_eq!(registry.read_all().unwrap(), vec![off, ended, added]);
    }

    /// A server whose policy wants it running at the time, a future `Until`
    /// included, has the next one added off.
    #[tokio::test]
    async fn a_server_added_while_a_policy_wants_running_is_off() {
        for wanting_running in [
            RunPolicy::WhileOpen,
            RunPolicy::Always,
            RunPolicy::Until {
                at: now() + chrono::TimeDelta::minutes(1),
            },
        ] {
            let (_data_root, registry) = registry();
            let running = ServerRecord {
                run_policy: wanting_running,
                ..official_record("lab")
            };
            registry.insert(Box::new(|_| running.clone())).unwrap();
            let relay_client = FakeRelayClient::serving(served_settings());

            let added = add(&registry, &relay_client, self_hosted_relay(None), TOKEN)
                .await
                .unwrap();

            assert_eq!(added.run_policy, RunPolicy::Off, "{wanting_running:?}");
        }
    }

    #[tokio::test]
    async fn a_rathole_relay_is_added_from_its_entered_settings_without_a_request() {
        let (_data_root, registry) = registry();

        let record = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            token_credentials("ruth", "any-token"),
            launcher_url(),
            authorization_url(),
            no_client,
            now(),
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                relay: RelayKind::Rathole,
                tunnel_name: ruth(),
                token: TunnelToken::new("any-token"),
                public_settings: served_settings(),
                launcher_url: launcher_url(),
                authorization_url: authorization_url(),
                certificate_authority: ServerRecord::DEFAULT_CERTIFICATE_AUTHORITY,
                run_policy: RunPolicy::WhileOpen,
            }
        );
        assert_eq!(record.domain(), "ruth.relay.example.com");
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// A rathole relay's entered settings get the checks a `GET /rathole`
    /// response does.
    #[tokio::test]
    async fn a_rathole_relay_s_invalid_setting_is_named_and_writes_nothing() {
        for (setting, public_settings) in bad_settings() {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                EnteredRelay::Rathole {
                    identity: RelayIdentity::of(&public_settings),
                    domain: public_settings.domain.clone(),
                },
                token_credentials("ruth", TOKEN),
                launcher_url(),
                authorization_url(),
                no_client,
                now(),
            )
            .await;
            assert!(
                matches!(&result, Err(EnrolmentError::InvalidRelaySetting { setting: named, .. }) if *named == setting),
                "{public_settings:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[test]
    fn an_entered_relay_decodes_from_camel_case_json() {
        for (json, relay) in [
            (
                serde_json::json!({"kind": "wildflowerOfficial"}),
                EnteredRelay::WildflowerOfficial,
            ),
            (
                serde_json::json!({"kind": "selfHostedWildflower", "baseUrl": "https://relay.example.com"}),
                self_hosted_relay(None),
            ),
            (
                serde_json::json!({
                    "kind": "selfHostedWildflower",
                    "baseUrl": "https://relay.example.com",
                    "pin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY},
                }),
                self_hosted_relay(Some(RelayIdentity {
                    remote_addr: "relay.example.com:2333".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                })),
            ),
            (
                serde_json::json!({
                    "kind": "rathole",
                    "remoteAddr": "relay.example.com:2333",
                    "publicKey": PUBLIC_KEY,
                    "domain": RELAY_DOMAIN,
                }),
                rathole_relay(),
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<EnteredRelay>(json.clone()).unwrap(),
                relay,
                "{json}"
            );
        }
        for json in [
            serde_json::json!({"kind": "selfHostedWildflower", "base_url": "https://relay.example.com"}),
            serde_json::json!({
                "kind": "rathole",
                "remote_addr": "relay.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": RELAY_DOMAIN,
            }),
            serde_json::json!({
                "kind": "selfHostedWildflower",
                "baseUrl": "https://relay.example.com",
                "relayPin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY},
            }),
            serde_json::json!({
                "kind": "rathole",
                "remoteAddr": "relay.example.com:2333",
                "publicKey": PUBLIC_KEY,
                "domain": RELAY_DOMAIN,
                "baseUrl": "https://relay.example.com",
            }),
            serde_json::json!({
                "kind": "selfHostedWildflower",
                "baseUrl": "https://relay.example.com",
                "pin": {"remoteAddr": "relay.example.com:2333", "publicKey": PUBLIC_KEY, "domain": RELAY_DOMAIN},
            }),
        ] {
            assert!(
                serde_json::from_value::<EnteredRelay>(json.clone()).is_err(),
                "{json}"
            );
        }
    }

    #[tokio::test]
    async fn set_credentials_replaces_the_token_and_keeps_the_rest() {
        let (_data_root, registry) = registry();
        let mut registered = official_record("ruth");
        registered.token = TunnelToken::new("the-old-token");
        registered.public_settings = served_settings();
        registered.certificate_authority = CertificateAuthority::LetsEncryptStaging;
        registered.launcher_url = Url::parse("http://localhost:5200/").unwrap();
        registry.insert(Box::new(|_| registered.clone())).unwrap();
        let relay_client = FakeRelayClient::serving(served_settings());

        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                token: TunnelToken::new(TOKEN),
                public_settings: served_settings(),
                ..registered
            }
        );
        assert_eq!(
            relay_client.built_for(),
            vec![RelayKind::wildflower_base_url()]
        );
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// The relay's round trip takes a while, and the user can change the
    /// server's run policy meanwhile: the token is written onto the record as
    /// it is then, so the new policy is kept.
    #[tokio::test]
    async fn set_credentials_keeps_a_run_policy_changed_while_the_relay_is_asked() {
        let (_data_root, registry) = registry();
        let mut registered = official_record("ruth");
        registered.token = TunnelToken::new("the-old-token");
        registered.public_settings = served_settings();
        registry.insert(Box::new(|_| registered.clone())).unwrap();
        let concurrent_registry = Arc::clone(&registry);
        let relay_client = FakeRelayClient {
            while_asked: Some(Arc::new(move || {
                crate::set_run_policy(
                    concurrent_registry.as_ref(),
                    "ruth.relay.example.com",
                    crate::RunPolicyChoice::Always,
                    now(),
                )
                .unwrap();
            })),
            ..FakeRelayClient::serving(served_settings())
        };

        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();

        assert_eq!(record.run_policy, RunPolicy::Always);
        assert_eq!(record.token, TunnelToken::new(TOKEN));
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    /// A server removed while the relay was asked isn't written back.
    #[tokio::test]
    async fn set_credentials_for_a_server_removed_while_the_relay_is_asked_writes_nothing() {
        let (_data_root, registry) = registry();
        let mut registered = official_record("ruth");
        registered.public_settings = served_settings();
        registry.insert(Box::new(|_| registered.clone())).unwrap();
        let concurrent_registry = Arc::clone(&registry);
        let relay_client = FakeRelayClient {
            while_asked: Some(Arc::new(move || {
                concurrent_registry
                    .remove("ruth.relay.example.com")
                    .unwrap();
            })),
            ..FakeRelayClient::serving(served_settings())
        };

        let result = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await;

        assert!(matches!(
            result,
            Err(EnrolmentError::Registry(RegistryError::NotRegistered { domain }))
                if domain == "ruth.relay.example.com"
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[tokio::test]
    async fn set_credentials_for_an_unknown_domain_builds_no_site() {
        let (_data_root, registry) = registry();
        assert!(matches!(
            set_server_credentials(
                registry,
                "ruth.relay.example.com",
                TunnelToken::new(TOKEN),
                no_client,
            )
            .await,
            Err(EnrolmentError::Registry(
                RegistryError::NotRegistered { .. }
            ))
        ));
    }

    #[tokio::test]
    async fn set_credentials_refuses_a_relay_that_moved_domain_or_rejects_the_token() {
        let (_data_root, registry) = registry();
        let mut moved = official_record("ruth");
        moved.public_settings = PublicRatholeSettings {
            domain: "old.example.com".to_owned(),
            ..served_settings()
        };
        let mut same = official_record("lab");
        same.public_settings = served_settings();
        registry.insert(Box::new(|_| moved.clone())).unwrap();
        registry.insert(Box::new(|_| same.clone())).unwrap();
        let relay_client = FakeRelayClient::serving(served_settings());

        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                "ruth.old.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await,
            Err(EnrolmentError::DomainChanged { registered, served })
                if registered == "old.example.com" && served == RELAY_DOMAIN
        ));
        assert!(matches!(
            set_server_credentials(
                Arc::clone(&registry),
                "lab.relay.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await,
            Err(EnrolmentError::SignedRequestRejected { .. })
        ));
        assert_eq!(registry.read_all().unwrap(), vec![moved, same]);
    }

    #[tokio::test]
    async fn set_credentials_for_a_rathole_server_replaces_only_the_token_without_a_request() {
        let (_data_root, registry) = registry();
        let registered = add_server(
            Arc::clone(&registry),
            rathole_relay(),
            token_credentials("ruth", "the-old-token"),
            launcher_url(),
            authorization_url(),
            no_client,
            now(),
        )
        .await
        .unwrap();

        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new("the-new-token"),
            no_client,
        )
        .await
        .unwrap();

        assert_eq!(
            record,
            ServerRecord {
                token: TunnelToken::new("the-new-token"),
                ..registered
            }
        );
        assert_eq!(registry.read_all().unwrap(), vec![record]);
    }

    #[tokio::test]
    async fn a_rathole_relay_s_entered_address_is_stored_case_folded() {
        let (_data_root, registry) = registry();
        let record = add_server(
            Arc::clone(&registry),
            EnteredRelay::Rathole {
                identity: RelayIdentity {
                    remote_addr: "Relay.Example.com:2333".to_owned(),
                    public_key: PUBLIC_KEY.to_owned(),
                },
                domain: RELAY_DOMAIN.to_owned(),
            },
            token_credentials("ruth", TOKEN),
            launcher_url(),
            authorization_url(),
            no_client,
            now(),
        )
        .await
        .unwrap();
        assert_eq!(record.public_settings.remote_addr, "relay.example.com:2333");
    }

    #[tokio::test]
    async fn a_base_url_a_relay_site_cannot_be_asked_at_is_an_invalid_setting() {
        for base_url in [
            "relay.example.com",
            "http://relay.example.com",
            "https://user:pass@relay.example.com",
            "https://relay.example.com/?x=1",
            "https://relay.example.com/#top",
            "file:///relay",
        ] {
            let (_data_root, registry) = registry();
            let result = add_server(
                Arc::clone(&registry),
                EnteredRelay::SelfHostedWildflower {
                    base_url: base_url.to_owned(),
                    pin: None,
                },
                token_credentials("ruth", TOKEN),
                launcher_url(),
                authorization_url(),
                no_client,
                now(),
            )
            .await;
            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::InvalidRelaySetting {
                        setting: "baseUrl",
                        ..
                    })
                ),
                "{base_url:?}: {result:?}"
            );
            assert_eq!(registry.read_all().unwrap(), Vec::new());
        }
    }

    #[tokio::test]
    async fn a_base_url_with_a_path_prefix_is_kept() {
        let (_data_root, registry) = registry();
        let relay_client = FakeRelayClient::serving(served_settings());
        let record = add_server(
            Arc::clone(&registry),
            EnteredRelay::SelfHostedWildflower {
                base_url: "https://example.com/relay".to_owned(),
                pin: None,
            },
            token_credentials("ruth", TOKEN),
            launcher_url(),
            authorization_url(),
            relay_client.builder(),
            now(),
        )
        .await
        .unwrap();
        let base_url = Url::parse("https://example.com/relay").unwrap();
        assert_eq!(relay_client.built_for(), vec![base_url.clone()]);
        assert_eq!(record.relay, RelayKind::SelfHostedWildflower { base_url });
    }

    /// The relay's identity was pinned when the server was added: a token
    /// re-entered against a relay that now presents another address or noise
    /// key is refused before the signed request, and nothing is written.
    #[tokio::test]
    async fn set_credentials_refuses_a_relay_whose_identity_changed() {
        for (setting, served) in [
            (
                "remoteAddr",
                PublicRatholeSettings {
                    remote_addr: "elsewhere.example.com:2333".to_owned(),
                    ..served_settings()
                },
            ),
            (
                "publicKey",
                PublicRatholeSettings {
                    public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                    ..served_settings()
                },
            ),
        ] {
            let (_data_root, registry) = registry();
            let registered = add(
                &registry,
                &FakeRelayClient::serving(served_settings()),
                self_hosted_relay(None),
                TOKEN,
            )
            .await
            .unwrap();
            let relay_client = FakeRelayClient::serving(served.clone());

            let result = set_server_credentials(
                Arc::clone(&registry),
                "ruth.relay.example.com",
                TunnelToken::new(TOKEN),
                relay_client.builder(),
            )
            .await;

            assert!(
                matches!(
                    &result,
                    Err(EnrolmentError::RelayIdentityChanged { setting: changed, registered, served: now })
                        if *changed == setting && registered != now
                ),
                "{setting}: {result:?}"
            );
            assert_eq!(result.unwrap_err().kind(), "relayIdentityChanged");
            assert_eq!(relay_client.tunnel_host_fetches.load(Ordering::SeqCst), 0);
            assert_eq!(registry.read_all().unwrap(), vec![registered]);
        }
    }

    /// A relay that serves the address it was added with in another case is
    /// the same relay.
    #[tokio::test]
    async fn set_credentials_accepts_the_same_address_in_another_case() {
        let (_data_root, registry) = registry();
        add(
            &registry,
            &FakeRelayClient::serving(served_settings()),
            self_hosted_relay(None),
            TOKEN,
        )
        .await
        .unwrap();
        let relay_client = FakeRelayClient::serving(PublicRatholeSettings {
            remote_addr: "RELAY.example.com:2333".to_owned(),
            ..served_settings()
        });
        let record = set_server_credentials(
            Arc::clone(&registry),
            "ruth.relay.example.com",
            TunnelToken::new(TOKEN),
            relay_client.builder(),
        )
        .await
        .unwrap();
        assert_eq!(record.public_settings, served_settings());
    }

    /// The relays the base sends `server_add` decode as the golden file
    /// names them.
    #[test]
    fn the_entered_relays_decode_as_the_golden_file_says() {
        let golden = crate::domain::golden();
        let relays = [
            ("wildflowerOfficial", EnteredRelay::WildflowerOfficial),
            ("selfHostedWildflower", self_hosted_relay(None)),
            (
                "selfHostedWildflowerPinned",
                self_hosted_relay(Some(RelayIdentity {
                    remote_addr: format!("{RELAY_DOMAIN}:2333"),
                    public_key: PUBLIC_KEY.to_owned(),
                })),
            ),
            ("rathole", rathole_relay()),
        ];
        for (name, relay) in &relays {
            assert_eq!(
                &serde_json::from_value::<EnteredRelay>(golden["enteredRelays"][name].clone())
                    .unwrap(),
                relay,
                "{name}"
            );
        }
        assert_eq!(
            golden["enteredRelays"].as_object().unwrap().len(),
            relays.len(),
            "every golden relay is checked"
        );
    }
}
