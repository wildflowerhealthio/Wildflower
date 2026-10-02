//! Keeps HFS's `base_url` on the tunnel's public host.
//!
//! HFS writes `base_url` into every URL it emits (Bundle links, `fullUrl`s,
//! `Location`s), and remote clients follow those links through the tunnel, so
//! `base_url` is `https://{public_host}/fhir-r4`, or the loopback FHIR base
//! while no public host is configured. [`point_hfs_at_public_host`] sets it once
//! before serving, and [`follow_public_host`] re-sets it whenever the tunnel's
//! public host changes. See `docs/Origins/Explanation.md`.

use anyhow::Context;
use emr_rust::SwappableHfs;
use tokio::sync::watch;
use tunnel_rust::TunnelLiveness;

/// Set HFS's `base_url` from the tunnel's public host: `https://{public_host}`,
/// or loopback for `None`.
///
/// # Errors
///
/// Returns an error, leaving `base_url` unchanged, if `public_host` doesn't
/// name an origin (see [`tunnel_rust::public_origin_url`]) or HFS refuses it.
pub(crate) fn point_hfs_at_public_host(
    hfs: &SwappableHfs,
    public_host: Option<&str>,
) -> anyhow::Result<()> {
    let origin = public_host
        .map(tunnel_rust::public_origin_url)
        .transpose()
        .context("the tunnel's public host can't be FHIR's base URL")?;
    hfs.set_base_url(origin.as_ref())
}

/// Call `on_change` with each new public host on `liveness`, until its sender
/// is dropped. `current` is the host already applied. The watch also ticks on
/// every status change and dial attempt; those leave the host alone and don't
/// call `on_change`.
pub(crate) async fn follow_public_host(
    mut liveness: watch::Receiver<TunnelLiveness>,
    mut current: Option<String>,
    mut on_change: impl FnMut(Option<&str>),
) {
    while liveness.changed().await.is_ok() {
        let next = liveness.borrow_and_update().public_host.clone();
        if next != current {
            current = next;
            on_change(current.as_deref());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tunnel_rust::TunnelStatus;

    use super::*;

    fn liveness(public_host: Option<&str>, status: TunnelStatus) -> TunnelLiveness {
        TunnelLiveness {
            settings_revision: Some(1),
            status,
            origin: "http://127.0.0.1:8080".to_owned(),
            public_host: public_host.map(str::to_owned),
            error: None,
            dial_attempts: 0,
        }
    }

    /// Drive `follow_public_host` through `updates`, one per tick, and return the
    /// hosts it reported, in order.
    async fn followed(initial: Option<&str>, updates: Vec<TunnelLiveness>) -> Vec<Option<String>> {
        let (sender, receiver) = watch::channel(liveness(initial, TunnelStatus::Off));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&seen);
        let follower = tokio::spawn(follow_public_host(
            receiver,
            initial.map(str::to_owned),
            move |host| {
                record
                    .lock()
                    .expect("record lock")
                    .push(host.map(str::to_owned));
            },
        ));
        for update in updates {
            sender.send_replace(update);
            // Let the follower observe each tick before the next replaces it.
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
        }
        drop(sender);
        follower.await.expect("follower ends when the sender drops");
        let seen = seen.lock().expect("seen lock").clone();
        seen
    }

    #[tokio::test]
    async fn a_new_public_host_is_reported() {
        let seen = followed(
            None,
            vec![liveness(Some("dev1.example.com"), TunnelStatus::Dialing)],
        )
        .await;
        assert_eq!(seen, vec![Some("dev1.example.com".to_owned())]);
    }

    #[tokio::test]
    async fn status_only_ticks_are_ignored() {
        let host = Some("dev1.example.com");
        let seen = followed(
            host,
            vec![
                liveness(host, TunnelStatus::Dialing),
                liveness(host, TunnelStatus::Verified),
                liveness(host, TunnelStatus::Unreachable),
            ],
        )
        .await;
        assert!(seen.is_empty(), "reported {seen:?}");
    }

    #[tokio::test]
    async fn clearing_the_public_host_is_reported_as_none() {
        let seen = followed(
            Some("dev1.example.com"),
            vec![liveness(None, TunnelStatus::Off)],
        )
        .await;
        assert_eq!(seen, vec![None]);
    }

    #[tokio::test]
    async fn each_change_is_reported_once() {
        let seen = followed(
            None,
            vec![
                liveness(Some("dev1.example.com"), TunnelStatus::Dialing),
                liveness(Some("dev1.example.com"), TunnelStatus::Verified),
                liveness(Some("dev2.example.com"), TunnelStatus::Dialing),
            ],
        )
        .await;
        assert_eq!(
            seen,
            vec![
                Some("dev1.example.com".to_owned()),
                Some("dev2.example.com".to_owned()),
            ]
        );
    }
}
