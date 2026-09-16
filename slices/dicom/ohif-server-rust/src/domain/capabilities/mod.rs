mod dicom_file_reader;

use scopes_rust::Scope;

pub(crate) use dicom_file_reader::{dicom_file_reader_scopes, DicomFileReader};

#[must_use]
pub fn grantable_ohif_server_scopes() -> Vec<Scope> {
    [dicom_file_reader_scopes()].into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grantable_scopes_are_user_document_reference_r() {
        assert_eq!(
            scopes_rust::render_scopes(&grantable_ohif_server_scopes()),
            vec!["user/DocumentReference.r".to_owned()],
        );
    }

    #[test]
    fn every_grantable_scope_is_a_fhir_resource_scope() {
        for scope in grantable_ohif_server_scopes() {
            assert!(
                matches!(scope, Scope::FhirResource(_)),
                "required scope {scope} is not a FHIR resource scope",
            );
        }
    }

    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        let capability_scope_fns = rs_files_under(capabilities_dir)
            .into_iter()
            .filter(|path| path.file_name().is_some_and(|name| name != "mod.rs"))
            .flat_map(|path| {
                std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read capability source {}: {e}", path.display()))
                    .lines()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|line| {
                let is_pub_crate_fn = line.contains("pub(crate) fn");
                let returns_scope_vec = line.contains("_scopes() -> Vec<Scope>");
                is_pub_crate_fn && returns_scope_vec
            })
            .count();
        let declared_entries = 1;
        assert_eq!(
            capability_scope_fns, declared_entries,
            "found {capability_scope_fns} capability scope functions but \
             grantable_ohif_server_scopes() declares {declared_entries}; register the new \
             capability in its array",
        );
    }

    #[test]
    fn handlers_reach_the_store_only_through_capabilities() {
        const FORBIDDEN: &[&str] = &["State<", ".store"];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the store directly \
                     (`{needle}`); acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 1,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
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
}
