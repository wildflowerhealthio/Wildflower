//! 32-bit FNV-1a, the hash [`LocalNotification`](super::local_notification::LocalNotification)
//! ids are turned into the notification plugin's numeric ids with: tiny, with
//! no dependency, and the same on every platform and across launches, unlike
//! `std`'s per-process seeded hashers.

/// FNV-1a's 32-bit offset basis, the hash of no bytes.
const OFFSET_BASIS: u32 = 0x811c_9dc5;

/// FNV-1a's 32-bit prime, which each byte's mix is multiplied by.
const PRIME: u32 = 0x0100_0193;

/// Hash `bytes` with 32-bit FNV-1a.
#[must_use]
pub fn hash_fnv1a_32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(OFFSET_BASIS, |hash, &byte| {
        (hash ^ u32::from(byte)).wrapping_mul(PRIME)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reference test vectors for 32-bit FNV-1a.
    #[test]
    fn hashes_match_the_reference_vectors() {
        assert_eq!(hash_fnv1a_32(b""), 0x811c_9dc5);
        assert_eq!(hash_fnv1a_32(b"a"), 0xe40c_292c);
        assert_eq!(hash_fnv1a_32(b"foobar"), 0xbf9c_f968);
    }
}
