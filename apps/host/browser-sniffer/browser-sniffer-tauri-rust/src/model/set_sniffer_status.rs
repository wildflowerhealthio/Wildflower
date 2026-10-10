use serde::Deserialize;

/// Wire shape of `CollectorBridge.webToHost.SetSnifferStatus`. Carries the
/// current step's manually-authored `name`, which the handler writes to the
/// sniffer chrome's subtitle via `patch_window_text`.
#[derive(Debug, PartialEq, Deserialize)]
pub(crate) struct SetSnifferStatusPayload {
    pub(crate) name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_name() {
        let payload = r#"{"_tag":"SetSnifferStatus","name":"Entering email"}"#;
        let decoded: SetSnifferStatusPayload = serde_json::from_str(payload).expect("decode");
        assert_eq!(
            decoded,
            SetSnifferStatusPayload {
                name: "Entering email".to_string(),
            }
        );
    }
}
