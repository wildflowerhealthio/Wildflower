//! The Tauri host's [`gatekeeper_rust::LoopbackConsentPrompt`]: a native
//! Approve / Reject dialog for a direct-loopback login by the hosted owner UI
//! (`wildflower-react` on its public origin, pointed at this machine's server).
//!
//! Gatekeeper decides *when* to ask — only a non-forwarded `/authorize` for that
//! `client_id` — and applies the answer; this adapter only shows the question.
//! The slice owns the trait; the dialog plugin is a host dependency; so the
//! adapter lives here, like the self-hosted redirect resolver.

use std::sync::atomic::{AtomicBool, Ordering};

use gatekeeper_rust::{LoopbackConsentAnswer, LoopbackConsentPrompt, LoopbackConsentRequest};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Shows the loopback login dialog through `tauri-plugin-dialog`.
pub struct TauriLoopbackConsentPrompt {
    app_handle: tauri::AppHandle,
    /// The scopes the host Owner holds — the most a login can be granted, so a
    /// request for all of them is summarised as full owner access.
    host_owner_scopes: Vec<String>,
    /// Whether a dialog is on screen. At most one is shown at a time: any
    /// loopback caller can hit `/authorize` with the hosted owner UI's
    /// `client_id`, and each dialog holds a blocking worker until dismissed
    /// (even past its request's expiry), so an unbounded stream of them would
    /// stack dialogs and drain the shared blocking pool.
    showing: AtomicBool,
}

impl TauriLoopbackConsentPrompt {
    pub fn new(app_handle: tauri::AppHandle, host_owner_scopes: Vec<String>) -> Self {
        Self {
            app_handle,
            host_owner_scopes,
            showing: AtomicBool::new(false),
        }
    }
}

/// Holds the one dialog slot while a dialog is on screen, and frees it on drop
/// (including if showing the dialog panics).
struct DialogSlot<'a>(&'a AtomicBool);

impl<'a> DialogSlot<'a> {
    /// Claim the slot, or `None` when a dialog is already showing.
    fn claim(showing: &'a AtomicBool) -> Option<Self> {
        showing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| DialogSlot(showing))
    }
}

impl Drop for DialogSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl LoopbackConsentPrompt for TauriLoopbackConsentPrompt {
    /// Blocks on the native dialog (gatekeeper calls this on a blocking worker,
    /// never the async runtime). Closing the dialog is a reject. While another
    /// dialog is still on screen it abstains, leaving the login to the Owner UI.
    fn ask(&self, request: &LoopbackConsentRequest) -> LoopbackConsentAnswer {
        let Some(_slot) = DialogSlot::claim(&self.showing) else {
            return LoopbackConsentAnswer::Abstain;
        };
        let approved = self
            .app_handle
            .dialog()
            .message(dialog_message(request, &self.host_owner_scopes))
            .title("Wildflower")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Approve".to_owned(),
                "Reject".to_owned(),
            ))
            .blocking_show();
        if approved {
            LoopbackConsentAnswer::Approve
        } else {
            LoopbackConsentAnswer::Reject
        }
    }
}

/// The dialog body: which app is asking, the origin the login returns to (the
/// fact that tells the Owner which page this is — any local process can claim
/// the `client_id`), whether the app or address is new, and what it would get.
fn dialog_message(request: &LoopbackConsentRequest, host_owner_scopes: &[String]) -> String {
    format!(
        "\"{client_id}\" at {origin} wants to sign in to this Wildflower.\n\n\
         {notice}.\n\
         It is asking for {scopes}.\n\n\
         Approve only if you just started this sign-in.",
        client_id = request.client_id,
        origin = request.redirect_origin,
        notice = capitalized(request.registration_notice.describe()),
        scopes = scope_summary(&request.requested_scopes, host_owner_scopes),
    )
}

/// One line for the requested scopes: "full owner access" when the login asks
/// for everything the host Owner holds, else the scopes themselves.
fn scope_summary(requested_scopes: &[String], host_owner_scopes: &[String]) -> String {
    let asks_for_everything = !host_owner_scopes.is_empty()
        && host_owner_scopes
            .iter()
            .all(|held| requested_scopes.contains(held));
    if asks_for_everything {
        "full owner access to this device's data".to_owned()
    } else {
        requested_scopes.join(", ")
    }
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gatekeeper_rust::LoopbackRegistrationNotice;

    fn owned(scopes: &[&str]) -> Vec<String> {
        scopes.iter().map(|scope| (*scope).to_owned()).collect()
    }

    fn request(scopes: &[&str], notice: LoopbackRegistrationNotice) -> LoopbackConsentRequest {
        LoopbackConsentRequest {
            request_id: "req-1".to_owned(),
            client_id: "wildflower-react".to_owned(),
            redirect_origin: "https://wildflowerhealth.io".to_owned(),
            registration_notice: notice,
            requested_scopes: owned(scopes),
            expires_at: chrono::DateTime::UNIX_EPOCH,
        }
    }

    /// The body names the client, the origin it returns to, the notice, and
    /// summarises a request for every host-owner scope as full owner access.
    #[test]
    fn the_message_names_the_app_origin_notice_and_access() {
        let held = owned(&["system/*.cruds", "wildflower/*.cruds", "wildflower/launch"]);
        let message = dialog_message(
            &request(
                &[
                    "system/*.cruds",
                    "wildflower/*.cruds",
                    "wildflower/launch",
                    "openid",
                ],
                LoopbackRegistrationNotice::NewAddress,
            ),
            &held,
        );
        assert!(message.contains("\"wildflower-react\" at https://wildflowerhealth.io"));
        assert!(message.contains("New address for a known app."));
        assert!(message.contains("full owner access to this device's data"));
    }

    /// Only one dialog slot can be held at a time, and dropping the holder
    /// frees it for the next login.
    #[test]
    fn the_dialog_slot_is_single_flight() {
        let showing = AtomicBool::new(false);
        let first = DialogSlot::claim(&showing).expect("free slot");
        assert!(DialogSlot::claim(&showing).is_none());
        drop(first);
        assert!(DialogSlot::claim(&showing).is_some());
    }

    /// A narrower request lists its scopes rather than claiming owner access.
    #[test]
    fn a_narrower_request_lists_its_scopes() {
        let held = owned(&["system/*.cruds", "wildflower/*.cruds"]);
        assert_eq!(
            scope_summary(&owned(&["wildflower/*.cruds", "openid"]), &held),
            "wildflower/*.cruds, openid"
        );
        assert_eq!(scope_summary(&owned(&["openid"]), &[]), "openid");
    }
}
