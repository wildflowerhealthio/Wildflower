//! Per-instance window + webview label construction. A caller-named instance id
//! becomes `native-webview-<id>` (window) / `-<id>-chrome` / `-<id>-content`,
//! and [`id_from_chrome_label`] recovers the id from a chrome label — the path
//! the app-global action-scheme handler uses to route a fetch to its instance.

/// Label prefix shared by every native-webview instance's window + child
/// webviews. A caller-named instance id is appended: `native-webview-<id>` for
/// the window, `-<id>-chrome` / `-<id>-content` for the children (see
/// [`window_label`] / [`chrome_label`] / [`content_label`]).
/// `capabilities/native-webview-window.json` globs on `native-webview-*` to
/// scope the grant across all instances.
const LABEL_PREFIX_DASH: &str = "native-webview-";

/// Parent-window label for instance `id`.
pub(super) fn window_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}")
}
/// Chrome (top bar) child-webview label for instance `id`.
pub(super) fn chrome_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}-chrome")
}
/// Content (external URL) child-webview label for instance `id`.
pub(super) fn content_label(id: &str) -> String {
    format!("{LABEL_PREFIX_DASH}{id}-content")
}
/// Recover the instance id from a chrome webview's label — the inverse of
/// [`chrome_label`]. The action-scheme handler is app-global, so it derives the
/// requesting instance from `ctx.webview_label()` (only the chrome webview ever
/// issues these fetches). Strips exactly one `-chrome` suffix, so an id that
/// itself contains `-chrome` round-trips.
pub(super) fn id_from_chrome_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX_DASH)
        .and_then(|rest| rest.strip_suffix("-chrome"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The per-instance labels are distinct across the three surfaces and, for a
    /// chrome label, round-trip back to the id via [`id_from_chrome_label`] — the
    /// path the action-scheme handler relies on to route to the right instance.
    /// An id with an *internal* `-chrome` still round-trips (only one trailing
    /// `-chrome` suffix is stripped), and a content/window label is rejected (the
    /// handler must ignore requests from a non-chrome webview). Note: an id that
    /// *ends* in `-chrome`/`-content` is inherently ambiguous with another
    /// instance's window/content label — the real ids (`sniffer`/`launch`) don't,
    /// so we don't validate against it.
    #[test]
    fn instance_labels_round_trip_through_chrome_label() {
        for id in ["sniffer", "launch", "my-chrome-app"] {
            assert_eq!(id_from_chrome_label(&chrome_label(id)), Some(id));
            // Distinct across surfaces so two instances never collide.
            assert_ne!(window_label(id), chrome_label(id));
            assert_ne!(window_label(id), content_label(id));
            assert_ne!(chrome_label(id), content_label(id));
            // A content/window label is not a chrome label → no id recovered.
            assert_eq!(id_from_chrome_label(&content_label(id)), None);
            assert_eq!(id_from_chrome_label(&window_label(id)), None);
        }
    }
}
