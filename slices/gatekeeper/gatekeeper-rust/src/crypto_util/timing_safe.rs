pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let max = ab.len().max(bb.len());
    let mut result: u8 = (ab.len() ^ bb.len()) as u8;
    for i in 0..max {
        let x = *ab.get(i).unwrap_or(&0);
        let y = *bb.get(i).unwrap_or(&0);
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_strings() {
        assert!(timing_safe_eq("hello", "hello"));
    }

    #[test]
    fn different_strings_same_length() {
        assert!(!timing_safe_eq("hello", "world"));
    }

    #[test]
    fn different_lengths() {
        assert!(!timing_safe_eq("a", "abc"));
    }

    #[test]
    fn both_empty() {
        assert!(timing_safe_eq("", ""));
    }
}
