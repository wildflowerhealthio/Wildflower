//! The local notifications the host posts about the server.

/// One local notification, replaced in place by a later one with the same
/// [`id`](Self::id) where the platform supports it (Android and iOS; desktop
/// notifications stack).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNotification {
    /// The stable string id: `server-stopped`, `server-reach`, or
    /// `server-requests:<caller>`.
    pub id: String,
    pub title: String,
    pub body: String,
}

impl LocalNotification {
    /// [`Self::id`] as the positive, non-zero `i32` the notification plugin
    /// takes, the same on every call and across launches (32-bit FNV-1a with the
    /// sign bit cleared and the low bit set).
    ///
    /// # Remarks
    ///
    /// Android treats a non-positive id as "no id", so the sign bit is masked
    /// off rather than the hash reinterpreted as signed. Two string ids can
    /// collide; with the handful of ids the host posts, that is accepted.
    #[must_use]
    pub fn numeric_id(&self) -> i32 {
        let hash = self.id.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
            (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
        });
        let positive = i32::from_be_bytes((hash & 0x7fff_ffff).to_be_bytes());
        positive | 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn with_id(id: &str) -> LocalNotification {
        LocalNotification {
            id: id.to_owned(),
            title: String::new(),
            body: String::new(),
        }
    }

    /// Pinned values: a change to the hash would orphan the notifications
    /// already on a device under their old ids.
    #[test]
    fn numeric_ids_are_pinned() {
        // FNV-1a("server-stopped") = 0x912dbb96 → masked 0x112dbb96 → | 1.
        assert_eq!(with_id("server-stopped").numeric_id(), 0x112d_bb97);
        // FNV-1a("server-reach") = 0x21b43bc0 → already positive → | 1.
        assert_eq!(with_id("server-reach").numeric_id(), 0x21b4_3bc1);
    }

    proptest! {
        #[test]
        fn numeric_ids_are_positive_and_stable(id in ".{0,64}") {
            let notification = with_id(&id);
            prop_assert!(notification.numeric_id() > 0);
            prop_assert_eq!(notification.numeric_id(), with_id(&id).numeric_id());
        }
    }
}
