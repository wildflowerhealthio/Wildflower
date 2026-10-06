//! [`FakeServerService`]: a [`ServerService`] for tests, which records what it
//! is asked and reports run states the way the app's service does.

use std::collections::BTreeMap;
use std::sync::Mutex;

use chrono::Utc;
use servers_rust::ServerRecord;
use shared_structures_rust::server_run_state::ServerRunState;

use crate::{ServerService, ServerStatuses};

/// What a [`FakeServerService`] was asked, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServiceCall {
    Start(String),
    Stop(String),
    PublishNoServer(String),
}

/// A service that "runs" a server by reporting it `Starting` then `Running`,
/// and stops it by reporting it `Stopped`. A domain in `failing_starts` fails
/// to start with its error, and one in `failing_stops` to stop.
pub(crate) struct FakeServerService {
    statuses: ServerStatuses,
    calls: Mutex<Vec<ServiceCall>>,
    running_domains: Mutex<Vec<String>>,
    pub(crate) failing_starts: Mutex<BTreeMap<String, String>>,
    pub(crate) failing_stops: Mutex<BTreeMap<String, String>>,
}

impl FakeServerService {
    pub(crate) fn new(statuses: ServerStatuses) -> Self {
        Self {
            statuses,
            calls: Mutex::default(),
            running_domains: Mutex::default(),
            failing_starts: Mutex::default(),
            failing_stops: Mutex::default(),
        }
    }

    /// Everything the service was asked since the last call.
    pub(crate) fn take_calls(&self) -> Vec<ServiceCall> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    /// The domains of the servers it is running.
    pub(crate) fn running_domains(&self) -> Vec<String> {
        self.running_domains.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ServerService for FakeServerService {
    async fn start(&self, server: &ServerRecord) -> Result<(), String> {
        let domain = server.domain();
        self.calls
            .lock()
            .unwrap()
            .push(ServiceCall::Start(domain.clone()));
        if let Some(error) = self.failing_starts.lock().unwrap().get(&domain) {
            return Err(error.clone());
        }
        self.statuses
            .report_run_state(&domain, ServerRunState::Starting, Utc::now());
        self.statuses
            .report_run_state(&domain, ServerRunState::Running, Utc::now());
        self.running_domains.lock().unwrap().push(domain);
        Ok(())
    }

    async fn stop(&self, domain: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(ServiceCall::Stop(domain.to_owned()));
        if let Some(error) = self.failing_stops.lock().unwrap().get(domain) {
            return Err(error.clone());
        }
        let mut running_domains = self.running_domains.lock().unwrap();
        if let Some(position) = running_domains.iter().position(|running| running == domain) {
            running_domains.remove(position);
            self.statuses.report_run_state(
                domain,
                ServerRunState::Stopped { error: None },
                Utc::now(),
            );
        }
        Ok(())
    }

    fn publish_no_server(&self, reason: String) {
        self.calls
            .lock()
            .unwrap()
            .push(ServiceCall::PublishNoServer(reason));
    }
}
