//! Shared wire types for the request-log handlers: the shapes
//! `GET /requests/callers` and `GET /requests` serve, and the `auth` filter
//! `GET /requests` accepts. The per-operation handlers (`list`, `callers`) live
//! in sibling modules and pull what they need from here.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use wildflowerhealthio_shared_structures::request_caller::RequestRefusal;

use crate::domain::request_log::{CallerSummary, LoggedRequest, RequestAuth, RequestLogPage};
/// Why a bearer gate refused a logged request with a `401`. Mirrors
/// [`RequestRefusal`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestRefusalBody {
    /// The request carried no bearer token.
    MissingToken,
    /// The token failed signature or claim validation.
    TokenRejected,
    /// The token verified but has been revoked.
    Revoked,
}

impl From<RequestRefusal> for RequestRefusalBody {
    fn from(refusal: RequestRefusal) -> Self {
        match refusal {
            RequestRefusal::MissingToken => Self::MissingToken,
            RequestRefusal::TokenRejected => Self::TokenRejected,
            RequestRefusal::Revoked => Self::Revoked,
        }
    }
}

/// The `auth` filter `GET /requests` accepts: how a logged request fared
/// against auth. Mirrors [`RequestAuth`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestAuthParam {
    /// It needed auth and its token was valid: a verified caller, not refused.
    Authorized,
    /// It didn't need auth: no verified caller, not refused.
    Public,
    /// It failed auth: a bearer gate's `401` or a scope `403`.
    Refused,
}

impl From<RequestAuthParam> for RequestAuth {
    fn from(auth: RequestAuthParam) -> Self {
        match auth {
            RequestAuthParam::Authorized => Self::Authorized,
            RequestAuthParam::Public => Self::Public,
            RequestAuthParam::Refused => Self::Refused,
        }
    }
}

/// What the request log holds for one (caller, client address) pair — a row of
/// `GET /requests/callers`. The client's display name is not included; resolve
/// `clientId` through gatekeeper's client list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CallerSummaryBody {
    /// The verified caller's OAuth client, or `null` for the requests no
    /// bearer gate verified.
    #[schema(required)]
    pub(super) client_id: Option<String>,
    /// The visitor's address the request's `Forwarded` header named, or `null`
    /// when it named none.
    #[schema(required)]
    pub(super) address: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub(super) first_seen: DateTime<Utc>,
    #[schema(value_type = String, format = DateTime)]
    pub(super) last_seen: DateTime<Utc>,
    pub(super) request_count: i64,
    /// How many were refused: a bearer gate's `401` or a scope `403`.
    pub(super) refused_count: i64,
    /// The newest request's response status.
    pub(super) last_status: u16,
    /// The newest request's refusal, or `null` when no bearer gate refused it.
    #[schema(required)]
    pub(super) last_refusal: Option<RequestRefusalBody>,
}

impl From<CallerSummary> for CallerSummaryBody {
    fn from(summary: CallerSummary) -> Self {
        CallerSummaryBody {
            client_id: summary.caller.map(|caller| caller.client_id),
            address: summary.client_address,
            first_seen: summary.first_seen,
            last_seen: summary.last_seen,
            request_count: summary.request_count,
            refused_count: summary.refused_count,
            last_status: summary.last_status,
            last_refusal: summary.last_refusal.map(RequestRefusalBody::from),
        }
    }
}

/// One request in the log — an element of `GET /requests`. `path` is
/// the route the request was reduced to: no ids and no query string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoggedRequestBody {
    /// The request's place in the log; a higher id is newer.
    pub(super) id: i64,
    #[schema(value_type = String, format = DateTime)]
    pub(super) received_at: DateTime<Utc>,
    #[schema(required)]
    pub(super) client_id: Option<String>,
    #[schema(required)]
    pub(super) address: Option<String>,
    /// The public `host[:port]` the visitor addressed.
    #[schema(required)]
    pub(super) served_host: Option<String>,
    pub(super) method: String,
    pub(super) path: String,
    pub(super) status: u16,
    /// The response body's length, or `null` when it wasn't known up front.
    #[schema(required)]
    pub(super) response_bytes: Option<u64>,
    pub(super) duration_ms: u64,
    #[schema(required)]
    pub(super) refusal: Option<RequestRefusalBody>,
}

impl From<LoggedRequest> for LoggedRequestBody {
    fn from(LoggedRequest { id, request }: LoggedRequest) -> Self {
        LoggedRequestBody {
            id,
            received_at: request.received_at.into(),
            client_id: request.caller.map(|caller| caller.client_id),
            address: request.client_address,
            served_host: request.served_host,
            method: request.method,
            path: request.reduced_path,
            status: request.status,
            response_bytes: request.response_bytes,
            // The log stores whole milliseconds as a non-negative `INTEGER`,
            // so a logged duration's milliseconds always fit.
            duration_ms: u64::try_from(request.duration.as_millis())
                .expect("a logged duration is whole u64 milliseconds"),
            refusal: request.refusal.map(RequestRefusalBody::from),
        }
    }
}

/// One page of `GET /requests`, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogPageBody {
    pub(super) requests: Vec<LoggedRequestBody>,
    /// The `cursor` that reads the next page, or `null` on the last one.
    #[schema(required)]
    pub(super) next_cursor: Option<i64>,
}

impl From<RequestLogPage> for RequestLogPageBody {
    fn from(page: RequestLogPage) -> Self {
        RequestLogPageBody {
            requests: page
                .requests
                .into_iter()
                .map(LoggedRequestBody::from)
                .collect(),
            next_cursor: page.next_cursor,
        }
    }
}
