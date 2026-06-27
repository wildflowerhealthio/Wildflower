//! The fallback scope kind: anything the grammar doesn't recognize.

use std::fmt;

/// A scope string the grammar didn't recognize, preserved verbatim so it
/// round-trips unchanged. This is the total-parse fallback — once a string
/// reaches here it's neither a [`KnownScope`](crate::KnownScope), a FHIR
/// resource scope, nor a Wildflower resource scope.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UnknownScope(String);

impl UnknownScope {
    pub(in crate::scope) fn new(s: &str) -> Self {
        UnknownScope(s.to_string())
    }
}

impl fmt::Display for UnknownScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
