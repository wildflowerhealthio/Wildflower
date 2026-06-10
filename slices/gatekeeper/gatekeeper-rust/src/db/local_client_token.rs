use rusqlite::{params, OptionalExtension};

use super::GatekeeperStore;

const SESSION_ID: &str = "session";

impl GatekeeperStore {
    pub fn local_client_token(&self) -> crate::db::DbResult<Option<String>> {
        let row: Option<Option<String>> = self
            .conn()
            .lock()
            .query_row(
                "SELECT value FROM local_client_tokens WHERE id = ?1",
                params![SESSION_ID],
                |row| row.get(0),
            )
            .optional()?;
        Ok(row.flatten())
    }

    pub fn set_local_client_token(&self, value: Option<&str>) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "INSERT INTO local_client_tokens (id, value) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET value = excluded.value",
            params![SESSION_ID, value],
        )?;
        Ok(())
    }
}
