use std::sync::Mutex;

use crate::OnDeviceWebviewHandle;

/// An [`OnDeviceWebviewHandle`] stub that records the URLs it's handed, so a
/// test can assert the handler resolved the target and routed it to the handle
/// (and returned `204`) instead of redirecting.
#[derive(Default)]
pub struct RecordingStubWebviewHandle(pub Mutex<Vec<String>>);

impl OnDeviceWebviewHandle for RecordingStubWebviewHandle {
    fn open(&self, _app_id: String, _title: String, url: String) {
        self.0.lock().expect("sink mutex").push(url.to_owned());
    }
}
