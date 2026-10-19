# Domain

The entities in `src/domain/` are the rules of the server, with no HTTP and no SQL in them. Each page here takes one entity file: what the entity is in the Owner's world, its types, and a section per method with the unit tests that show it at work. Reading the pages in order, each concept arrives before a later page leans on it.

| Page                                                                   | What it is                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Client](<Domain/Client Explanation.md>)                               | An app that asks for access, and the registration that says what it may ask for.                 |
| [Browser Session](<Domain/Browser Session Explanation.md>)             | A browser the server has let in, and the scopes that cap what apps requested in it can receive.  |
| [Authorization Request](<Domain/Authorization Request Explanation.md>) | One request for access, of any kind, and the transitions that decide it.                         |
| [Launch Context](<Domain/Launch Context Explanation.md>)               | A SMART `launch` value, for one app (and maybe one patient) or for any app, spent once.          |
| [Grant](<Domain/Grant Explanation.md>)                                 | The Owner's standing yes to an app, which lets the next request skip asking.                     |
| [Authorization Code](<Domain/Authorization Code Explanation.md>)       | The one-minute, single-use code that carries an approval from the browser to the app's back end. |
| [Signing Key](<Domain/Signing Key Explanation.md>)                     | The key the server signs its tokens with, and publishes for others to check them.                |
| [Token](<Domain/Token Explanation.md>)                                 | The fifteen-minute signed access token an app presents to the FHIR server.                       |
| [Refresh Token](<Domain/Refresh Token Explanation.md>)                 | The chain of refresh tokens one authorization starts.                                            |
| [Pending Consent](<Domain/Pending Consent Explanation.md>)             | Which pending request the host is asking the Owner to decide: the newest, of any kind.           |
| [Retention](<Domain/Retention Explanation.md>)                         | How long each accumulating table keeps a row past its expiry, and the sweep that applies it.     |

The capabilities, proofs and writers that put these entities to work (`domain/capabilities/`, `domain/authority/`) appear where a flow needs them, in the [Integration Tests](<Integration Tests Explanation.md>) chapter.
