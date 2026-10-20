//! Who defines a client's registration: [`RegistrationSource`].

use diesel::deserialize::FromSqlRow;
use diesel::expression::AsExpression;
use strum::{AsRefStr, Display, EnumString};

/// Who defines a client's registration, stored in the `registration_source`
/// column (`strum` derives the `snake_case` wire strings, `server_defined`
/// and `trusted_on_first_use`).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, EnumString, AsRefStr, Display, AsExpression, FromSqlRow,
)]
#[strum(serialize_all = "snake_case")]
#[diesel(sql_type = diesel::sql_types::Text)]
pub enum RegistrationSource {
    /// The server defines it, and boot-time seeding rewrites it every boot:
    /// the host app's client, the browser-session client, and the FHIR
    /// server UI's client. A request is held to it, and an approval never
    /// writes it.
    ServerDefined,
    /// The Owner's approvals define it: created by the first approval of an
    /// unknown client, and widened by any later approval of a request outside
    /// it.
    TrustedOnFirstUse,
}
