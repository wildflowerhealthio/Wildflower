//! Typed bodies for the two page-directed control endpoints, and the tagged
//! envelopes they serialize into on their way into the sniffed page. The
//! envelope shapes are pinned to `collector-fundamentals/src/bridge.ts`'s
//! `PageAction` / `CancelSnifferRequest` messages — the injected sniffer
//! bootstrap demuxes on `_tag` and `action.kind`, so these strings are wire.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A scripted in-page interaction, demuxed page-side by `kind`. Mirrors the TS
/// `Click` / `Fill` action bodies.
#[derive(Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind")]
pub enum PageActionPayload {
    Click {
        #[serde(rename = "querySelector")]
        query_selector: String,
    },
    Fill {
        #[serde(rename = "querySelector")]
        query_selector: String,
        value: String,
    },
}

/// The `{"_tag":"PageAction","action":…}` envelope forwarded into the page.
#[derive(Debug, Serialize)]
pub(crate) struct PageActionEnvelope<'a> {
    #[serde(rename = "_tag")]
    pub(crate) tag: &'static str,
    pub(crate) action: &'a PageActionPayload,
}

/// The `{"_tag":"CancelSnifferRequest","id":…}` envelope forwarded into the
/// page — asks the sniffer shims to abort an in-flight request by its
/// correlation id.
#[derive(Debug, Serialize)]
pub(crate) struct CancelRequestEnvelope<'a> {
    #[serde(rename = "_tag")]
    pub(crate) tag: &'static str,
    pub(crate) id: &'a str,
}

pub(crate) const PAGE_ACTION_TAG: &str = "PageAction";
pub(crate) const CANCEL_SNIFFER_REQUEST_TAG: &str = "CancelSnifferRequest";

#[cfg(test)]
mod tests {
    use super::*;

    /// The envelopes serialize to exactly the bridge wire shapes the injected
    /// sniffer bootstrap demuxes (`_tag`, then `action.kind`) — these bytes are
    /// the contract with `install-sniffer.ts`.
    #[test]
    fn envelopes_match_the_bridge_wire_shapes() {
        let click = PageActionPayload::Click {
            query_selector: "#submit".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&PageActionEnvelope {
                tag: PAGE_ACTION_TAG,
                action: &click,
            })
            .unwrap(),
            r##"{"_tag":"PageAction","action":{"kind":"Click","querySelector":"#submit"}}"##,
        );

        let fill = PageActionPayload::Fill {
            query_selector: "input[name=email]".to_owned(),
            value: "user@example.test".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&PageActionEnvelope {
                tag: PAGE_ACTION_TAG,
                action: &fill,
            })
            .unwrap(),
            r#"{"_tag":"PageAction","action":{"kind":"Fill","querySelector":"input[name=email]","value":"user@example.test"}}"#,
        );

        assert_eq!(
            serde_json::to_string(&CancelRequestEnvelope {
                tag: CANCEL_SNIFFER_REQUEST_TAG,
                id: "req-42",
            })
            .unwrap(),
            r#"{"_tag":"CancelSnifferRequest","id":"req-42"}"#,
        );
    }

    /// The action union round-trips from the TS-shaped JSON the client posts.
    #[test]
    fn page_action_decodes_the_ts_action_bodies() {
        let click: PageActionPayload =
            serde_json::from_str(r##"{"kind":"Click","querySelector":"#a"}"##).unwrap();
        assert_eq!(
            click,
            PageActionPayload::Click {
                query_selector: "#a".to_owned(),
            },
        );
        let fill: PageActionPayload =
            serde_json::from_str(r##"{"kind":"Fill","querySelector":"#b","value":"v"}"##).unwrap();
        assert_eq!(
            fill,
            PageActionPayload::Fill {
                query_selector: "#b".to_owned(),
                value: "v".to_owned(),
            },
        );
    }
}
