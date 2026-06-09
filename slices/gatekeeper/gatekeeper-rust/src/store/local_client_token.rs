use rusqlite::{params, OptionalExtension};

use super::GatekeeperStore;

const SESSION_ID: &str = "session";

impl GatekeeperStore {
    pub async fn local_client_token(&self) -> crate::store::DbResult<Option<String>> {
        self.conn()
            .call(|c| {
                let row: Option<Option<String>> = c
                    .query_row(
                        "SELECT value FROM localClientToken WHERE id = ?1",
                        params![SESSION_ID],
                        |row| row.get(0),
                    )
                    .optional()?;
                Ok(row.flatten())
            })
            .await
    }

    pub async fn set_local_client_token(&self, value: Option<&str>) -> crate::store::DbResult<()> {
        let value = value.map(str::to_string);
        self.conn()
            .call(move |c| {
                c.execute(
                    "INSERT INTO localClientToken (id, value) VALUES (?1, ?2)
                     ON CONFLICT(id) DO UPDATE SET value = excluded.value",
                    params![SESSION_ID, value],
                )?;
                Ok(())
            })
            .await
    }
}
