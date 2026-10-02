//! The composition layer: where the [`crate::domain`] rules meet the Wildflower
//! server. [`server_run`] binds a run of `wildflower_server_rust::set_up` /
//! `serve` to the run gate and the host's channels, on a dedicated thread and
//! runtime.

pub mod server_run;
