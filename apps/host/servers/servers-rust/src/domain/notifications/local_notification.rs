//! [`LocalNotification`], one notification the host posts about its servers.

use crate::domain::notifications::fnv1a::hash_fnv1a_32;

/// Every bit of a `u32` but the sign bit of an `i32`.
const ALL_BUT_SIGN_BIT: u32 = 0x7fff_ffff;

/// One local notification, replaced in place by a later one with the same
/// [`id`](Self::id) where the platform supports it (Android and iOS; desktop
/// notifications stack).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalNotification {
    /// The stable string id: `server-stopped:<domain>`,
    /// `consent-request:<domain>` or `consent-requests-pending`.
    pub id: String,
    /// The notification's title.
    pub title: String,
    /// The notification's text.
    pub body: String,
}

impl LocalNotification {
    /// Hash [`Self::id`] into the positive, non-zero `i32` the notification
    /// plugin takes, the same on every call and across launches: its
    /// [FNV-1a](super::fnv1a) hash with the sign bit cleared and the low bit
    /// set.
    ///
    /// # Remarks
    ///
    /// Android treats a non-positive id as "no id", so the sign bit is cleared
    /// rather than the hash reinterpreted as signed, and the low bit set so it
    /// is never zero. Two string ids can collide; with the handful of ids the
    /// host posts, that is accepted.
    #[must_use]
    pub fn hash_id_for_plugin(&self) -> i32 {
        let positive = hash_fnv1a_32(self.id.as_bytes()) & ALL_BUT_SIGN_BIT;
        i32::from_be_bytes(positive.to_be_bytes()) | 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn plugin_ids_are_pinned() {
        // FNV-1a("server-stopped:ruth.relay.example.com") = 0xdf692c69 → masked 0x5f692c69 → | 1.
        assert_eq!(
            with_id("server-stopped:ruth.relay.example.com").hash_id_for_plugin(),
            0x5f69_2c69
        );
        // FNV-1a("consent-request:ruth.relay.example.com") = 0x96a08280 → masked 0x16a08280 → | 1.
        assert_eq!(
            with_id("consent-request:ruth.relay.example.com").hash_id_for_plugin(),
            0x16a0_8281
        );
    }

    #[test]
    fn a_hash_with_the_sign_bit_set_still_gives_a_positive_id() {
        // FNV-1a("") = 0x811c9dc5, sign bit set → masked 0x011c9dc5 → | 1.
        assert_eq!(with_id("").hash_id_for_plugin(), 0x011c_9dc5);
    }
}
