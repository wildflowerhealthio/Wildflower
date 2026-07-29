//! The [`SnifferDriver`] capability — the `wildflower/Sniffer.c` door to every
//! webview-mutating `/sniffer` operation (open/navigate, status, show, page
//! actions, cancellations, dispose). Holds its `*_scopes()` mapping (read by
//! both its binding and
//! [`grantable_sniffer_scopes`](super::grantable_sniffer_scopes) so enforced
//! and grantable can't drift) and its handle-focused tests.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::page_messages::{
    CancelRequestEnvelope, PageActionEnvelope, CANCEL_SNIFFER_REQUEST_TAG, PAGE_ACTION_TAG,
};
use crate::domain::{
    resolve_source, PageActionPayload, SnifferError, SnifferWebviewHandle, WebViewSourcePayload,
};

/// The scope gating [`SnifferDriver`] — `wildflower/Sniffer.c`. One fixed scope
/// for the whole control plane: driving the sniffer is one capability
/// ("conduct a sniffing session"), and splitting letters per verb would grant
/// nothing meaningful separately — a client that can open the webview can
/// already drive it wherever it likes.
pub(crate) fn sniffer_driver_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Sniffer,
        Permission::CREATE,
    )]
}

/// Drive the sniffer webview — every mutating `/sniffer` endpoint, gated by
/// `wildflower/Sniffer.c`. Holds the host handle lifted from the state (never
/// the state itself), so its logic is unit-testable against a recording fake.
pub(crate) struct SnifferDriver {
    handle: Arc<dyn SnifferWebviewHandle>,
}

impl SnifferDriver {
    /// Build the driver over a handle lifted from the state.
    pub(crate) fn new(handle: Arc<dyn SnifferWebviewHandle>) -> Self {
        SnifferDriver { handle }
    }

    /// Validate `source` and open/navigate the sniffer webview to it —
    /// `POST /sniffer/webview`.
    ///
    /// # Errors
    ///
    /// [`SnifferError::InvalidSource`] for a rejected source;
    /// [`SnifferError::Infrastructure`] if the host fails to open.
    pub(crate) fn open(&self, source: WebViewSourcePayload) -> Result<(), SnifferError> {
        let url = resolve_source(source)?;
        self.handle
            .open_or_navigate(&url)
            .map_err(|source| SnifferError::Infrastructure {
                context: "failed to open or navigate the sniffer webview",
                source,
            })
    }

    /// Write the per-step status label — `PUT /sniffer/status`.
    ///
    /// # Errors
    ///
    /// [`SnifferError::Infrastructure`] if the host fails to patch the chrome.
    pub(crate) fn set_status(&self, name: &str) -> Result<(), SnifferError> {
        self.handle
            .set_status(name)
            .map_err(|source| SnifferError::Infrastructure {
                context: "failed to set the sniffer status subtitle",
                source,
            })
    }

    /// Re-present a hidden-but-alive webview — `POST /sniffer/visibility`.
    ///
    /// # Errors
    ///
    /// [`SnifferError::Infrastructure`] if the host fails to show.
    pub(crate) fn show(&self) -> Result<(), SnifferError> {
        self.handle
            .show()
            .map_err(|source| SnifferError::Infrastructure {
                context: "failed to show the sniffer webview",
                source,
            })
    }

    /// Tear the webview down — `DELETE /sniffer/webview` (the terminal
    /// `SniffingComplete` signal).
    ///
    /// # Errors
    ///
    /// [`SnifferError::Infrastructure`] if the host fails to dispose.
    pub(crate) fn dispose(&self) -> Result<(), SnifferError> {
        self.handle
            .dispose()
            .map_err(|source| SnifferError::Infrastructure {
                context: "failed to dispose the sniffer webview",
                source,
            })
    }

    /// Forward a scripted interaction into the page — `POST
    /// /sniffer/page-actions`.
    ///
    /// # Errors
    ///
    /// [`SnifferError::Infrastructure`] if the forward fails.
    pub(crate) fn page_action(&self, action: &PageActionPayload) -> Result<(), SnifferError> {
        let envelope = serde_json::to_string(&PageActionEnvelope {
            tag: PAGE_ACTION_TAG,
            action,
        })
        .map_err(|source| SnifferError::Infrastructure {
            context: "failed to encode the PageAction envelope",
            source: source.into(),
        })?;
        self.forward(&envelope, "failed to forward the page action")
    }

    /// Ask the page's sniffer shims to abort an in-flight request — `POST
    /// /sniffer/cancellations`. Speculative by design (the collector cancels
    /// during teardown), so a missing webview is a success.
    ///
    /// # Errors
    ///
    /// [`SnifferError::Infrastructure`] if the forward fails.
    pub(crate) fn cancel_request(&self, id: &str) -> Result<(), SnifferError> {
        let envelope = serde_json::to_string(&CancelRequestEnvelope {
            tag: CANCEL_SNIFFER_REQUEST_TAG,
            id,
        })
        .map_err(|source| SnifferError::Infrastructure {
            context: "failed to encode the CancelSnifferRequest envelope",
            source: source.into(),
        })?;
        self.forward(&envelope, "failed to forward the cancellation")
    }

    fn forward(&self, envelope_json: &str, context: &'static str) -> Result<(), SnifferError> {
        self.handle
            .forward_to_page(envelope_json)
            .map_err(|source| SnifferError::Infrastructure { context, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeWebviewHandle;
    use crate::domain::UriSource;

    fn uri_source(uri: &str) -> WebViewSourcePayload {
        WebViewSourcePayload::Uri(UriSource {
            uri: uri.to_owned(),
            method: None,
            headers: None,
            body: None,
        })
    }

    /// `open` validates before it touches the handle: a rejected source is a
    /// 400-shaped [`SnifferError::InvalidSource`] and the host is never asked
    /// to navigate anywhere.
    #[test]
    fn open_rejects_an_invalid_source_without_touching_the_handle() {
        let handle = Arc::new(FakeWebviewHandle::default());
        let driver = SnifferDriver::new(handle.clone());
        let error = driver
            .open(uri_source("javascript:alert(1)"))
            .expect_err("non-http uri");
        assert!(matches!(error, SnifferError::InvalidSource { .. }));
        assert!(handle.calls().is_empty(), "the handle was never called");
    }

    /// The happy paths reach the handle with the validated/encoded arguments.
    #[test]
    fn operations_reach_the_handle() {
        let handle = Arc::new(FakeWebviewHandle::default());
        let driver = SnifferDriver::new(handle.clone());
        driver
            .open(uri_source("https://emr.example.test/portal"))
            .unwrap();
        driver.set_status("Entering email").unwrap();
        driver.show().unwrap();
        driver
            .page_action(&PageActionPayload::Click {
                query_selector: "#go".to_owned(),
            })
            .unwrap();
        driver.cancel_request("req-1").unwrap();
        driver.dispose().unwrap();
        assert_eq!(
            handle.calls(),
            vec![
                "open_or_navigate:https://emr.example.test/portal".to_owned(),
                "set_status:Entering email".to_owned(),
                "show".to_owned(),
                r##"forward:{"_tag":"PageAction","action":{"kind":"Click","querySelector":"#go"}}"##
                    .to_owned(),
                r#"forward:{"_tag":"CancelSnifferRequest","id":"req-1"}"#.to_owned(),
                "dispose".to_owned(),
            ],
        );
    }

    /// A failing handle surfaces as [`SnifferError::Infrastructure`] — the
    /// opaque-500 arm, never a client-decodable body.
    #[test]
    fn a_failing_handle_is_an_infrastructure_error() {
        let handle = Arc::new(FakeWebviewHandle::failing());
        let driver = SnifferDriver::new(handle);
        let error = driver.show().expect_err("failing handle");
        assert!(matches!(error, SnifferError::Infrastructure { .. }));
    }
}
