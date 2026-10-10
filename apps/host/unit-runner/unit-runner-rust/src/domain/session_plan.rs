//! What `UnitRunner` asks the platform for, given its session demand: a
//! background session's start, its end, or nothing.

use crate::domain::session_ledger::SessionPhase;

/// Whether some unit should run, and where the background session is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionDemand {
    /// Some unit should run.
    pub some_unit_should_run: bool,
    /// Whether a background session is running, and whether `UnitRunner` is
    /// ending it.
    pub session_phase: SessionPhase,
}

/// What `UnitRunner` asks the platform for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRequest {
    /// Start a background session, because some unit should run.
    Start,
    /// End the running session, because no unit should run.
    End,
}

/// What `UnitRunner` asks the platform for under `demand`: a session's start
/// when some unit should run and none is running, its end when one is running
/// and no unit should run, and otherwise nothing.
#[must_use]
pub fn plan_session_request_for_demand(demand: SessionDemand) -> Option<SessionRequest> {
    match (demand.some_unit_should_run, demand.session_phase) {
        (true, SessionPhase::NoSession) => Some(SessionRequest::Start),
        (false, SessionPhase::Running) => Some(SessionRequest::End),
        // Wait for the ending session's end: the platform would take a start
        // now as one for the session still running. That end changes the
        // demand.
        (_, SessionPhase::Ending) => None,
        (true, SessionPhase::Running) | (false, SessionPhase::NoSession) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demand(some_unit_should_run: bool, session_phase: SessionPhase) -> SessionDemand {
        SessionDemand {
            some_unit_should_run,
            session_phase,
        }
    }

    #[test]
    fn requests_a_start_or_an_end_only_when_the_session_is_out_of_step() {
        let table = [
            (true, SessionPhase::NoSession, Some(SessionRequest::Start)),
            (true, SessionPhase::Running, None),
            (true, SessionPhase::Ending, None),
            (false, SessionPhase::NoSession, None),
            (false, SessionPhase::Running, Some(SessionRequest::End)),
            (false, SessionPhase::Ending, None),
        ];
        for (some_unit_should_run, session_phase, expected) in table {
            assert_eq!(
                plan_session_request_for_demand(demand(some_unit_should_run, session_phase)),
                expected,
                "{some_unit_should_run} {session_phase:?}"
            );
        }
    }
}
