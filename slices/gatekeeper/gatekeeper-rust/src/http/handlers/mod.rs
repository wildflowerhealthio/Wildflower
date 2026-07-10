mod consent; // private; shared consent machinery for oauth_consents + devices, not a router
pub mod devices;
pub mod grants;
pub mod jwks;
pub mod logout;
pub mod oauth;
pub mod oauth_consents;
pub mod revocations;
