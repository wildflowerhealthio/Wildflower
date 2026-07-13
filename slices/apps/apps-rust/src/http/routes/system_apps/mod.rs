//! The `/system-apps` root resource — system apps as their own (read-only) REST
//! resource, off `/apps`. System apps are never created, edited, or deleted by a
//! user, so the resource is a single `get` (`GET /system-apps/{id}`) returning the
//! [`SystemAppDetail`](crate::domain::SystemAppDetail) shape.

pub(crate) mod get;
