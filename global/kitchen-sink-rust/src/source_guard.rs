//! Helpers for **source-guard** tests: tests that enumerate a crate's source
//! files and assert a textual invariant over them (a handler never names the
//! store, a layer never imports another). One enumerator, so every guard walks
//! the tree the same way.
//!
//! Test-only: compiled for this crate's own tests and behind the
//! `test-support` feature, which other crates enable from their
//! `[dev-dependencies]`.

use std::path::{Path, PathBuf};

/// Every `.rs` file under `dir`, recursively, sorted for stable failures.
/// Panics naming `dir` when it can't be read.
pub fn rs_files_under(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("readable dir entry").path();
        if path.is_dir() {
            files.extend(rs_files_under(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// `path` relative to `root`, with forward slashes, for matching against a
/// guard's allow-lists. Panics when `path` is not under `root`.
pub fn relative_to(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .expect("enumerated under root")
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "kitchen-sink-source-guard-{name}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("create temp tree");
            Self(root)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rs_files_under_lists_rust_files_recursively_in_order() {
        let tree = TempTree::new("enumerate");
        let root = &tree.0;
        std::fs::create_dir(root.join("sub")).expect("create sub");
        for file in ["b.txt", "sub/c.rs", "a.rs"] {
            std::fs::write(root.join(file), "").expect("write file");
        }

        assert_eq!(
            rs_files_under(root),
            vec![root.join("a.rs"), root.join("sub").join("c.rs")]
        );
    }

    #[test]
    fn relative_to_gives_a_forward_slash_path_under_root() {
        let root = Path::new("/project/src");
        let nested = root.join("sub").join("c.rs");

        assert_eq!(relative_to(&nested, root), "sub/c.rs");
    }

    #[test]
    #[should_panic(expected = "enumerate /definitely/not/a/real/dir")]
    fn rs_files_under_panics_on_a_missing_dir() {
        rs_files_under(Path::new("/definitely/not/a/real/dir"));
    }
}
