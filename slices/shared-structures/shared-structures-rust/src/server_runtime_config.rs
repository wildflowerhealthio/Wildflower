use url::Url;

#[derive(Debug, Clone)]
pub struct ServerRuntimeConfig {
    pub loopback_base_url: Url,
    pub app_data_dir: std::path::PathBuf,
}

impl ServerRuntimeConfig {
    /// The loopback base URL the embedded API server is reached at, e.g.
    /// `http://127.0.0.1:8080/`, as a typed [`Url`]. The single source of truth
    /// the host threads into every slice's config (apps / gatekeeper / emr /
    /// tunnel), parsed once so no downstream rebuilds it from a string. Consumers
    /// that need the bare origin string pass it to
    /// [`crate::origin_string`].
    ///
    /// This is only the *loopback* origin — the origin a given request is
    /// answered as (loopback vs. the forwarded public origin) is resolved per
    /// request. See `docs/Origins/Explanation.md`.
    #[must_use]
    pub fn loopback_base_url(&self) -> Url {
        self.loopback_base_url.clone()
    }

    /// Borrowing twin of [`Self::loopback_base_url`] for callers that only need
    /// to read the `Url` (e.g. its `host()`) without taking an owned clone.
    pub fn loopback_base_url_ref(&self) -> &Url {
        &self.loopback_base_url
    }
}
