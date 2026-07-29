//! A recording in-memory [`SnifferWebviewHandle`] fake for capability and
//! route tests.

use std::sync::Mutex;

use crate::domain::SnifferWebviewHandle;

/// Records every call as a `verb[:detail]` string; optionally fails every
/// operation (the opaque-500 path).
#[derive(Default)]
pub(crate) struct FakeWebviewHandle {
    calls: Mutex<Vec<String>>,
    fail: bool,
}

impl FakeWebviewHandle {
    /// A fake whose every operation fails — drives the `Infrastructure` arm.
    pub(crate) fn failing() -> Self {
        FakeWebviewHandle {
            calls: Mutex::new(Vec::new()),
            fail: true,
        }
    }

    /// The calls recorded so far, in order.
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls lock").clone()
    }

    fn record(&self, call: String) -> anyhow::Result<()> {
        self.calls.lock().expect("calls lock").push(call);
        if self.fail {
            anyhow::bail!("fake handle configured to fail");
        }
        Ok(())
    }
}

impl SnifferWebviewHandle for FakeWebviewHandle {
    fn open_or_navigate(&self, url: &str) -> anyhow::Result<()> {
        self.record(format!("open_or_navigate:{url}"))
    }

    fn set_status(&self, name: &str) -> anyhow::Result<()> {
        self.record(format!("set_status:{name}"))
    }

    fn show(&self) -> anyhow::Result<()> {
        self.record("show".to_owned())
    }

    fn dispose(&self) -> anyhow::Result<()> {
        self.record("dispose".to_owned())
    }

    fn forward_to_page(&self, envelope_json: &str) -> anyhow::Result<()> {
        self.record(format!("forward:{envelope_json}"))
    }
}
