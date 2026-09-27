#include "state.h"

// Persist keys. Never reuse a retired key's number: an installed watch still
// holds its old value.
enum {
  PersistKeyPatientName = 1,
  PersistKeyBirthDate = 2,
  PersistKeyAuthTime = 3,
  // A bitmask, one bit per DataType; set means the type syncs.
  PersistKeyEnabledDataTypes = 4,
  PersistKeyLastSyncTime = 5,
  // Each DataType's last sync time is under this key plus the DataType, so
  // keys 100 to 100 + DATA_TYPE_COUNT - 1 are taken.
  PersistKeyFirstDataTypeLastSyncTime = 100,
};

// persist_read_int's 0 for a missing key is also "never synced".
static void prv_load_sync_times(AppState *state) {
  state->last_sync_time = persist_read_int(PersistKeyLastSyncTime);
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    state->data_type_last_sync_times[i] = persist_read_int(PersistKeyFirstDataTypeLastSyncTime + i);
  }
}

static void prv_load_enabled_data_types(AppState *state) {
  int all_enabled = (1 << DATA_TYPE_COUNT) - 1;
  int enabled = persist_exists(PersistKeyEnabledDataTypes)
                  ? persist_read_int(PersistKeyEnabledDataTypes)
                  : all_enabled;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    state->data_type_enabled[i] = (enabled & (1 << i)) != 0;
  }
}

static void prv_persist_enabled_data_types(const AppState *state) {
  int enabled = 0;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (state->data_type_enabled[i]) {
      enabled |= 1 << i;
    }
  }
  persist_write_int(PersistKeyEnabledDataTypes, enabled);
}

void state_load(AppState *state) {
  *state = (AppState){ .connected = persist_exists(PersistKeyAuthTime) };
  if (state->connected) {
    Connection *connection = &state->connection;
    persist_read_string(
      PersistKeyPatientName, connection->patient_name, sizeof(connection->patient_name)
    );
    persist_read_string(PersistKeyBirthDate, connection->birth_date, sizeof(connection->birth_date));
    connection->auth_time = persist_read_int(PersistKeyAuthTime);
  }
  prv_load_enabled_data_types(state);
  prv_load_sync_times(state);
}

void state_set_connection(AppState *state, const Connection *connection) {
  state->connection = *connection;
  state->connected = true;
  persist_write_string(PersistKeyPatientName, connection->patient_name);
  persist_write_string(PersistKeyBirthDate, connection->birth_date);
  persist_write_int(PersistKeyAuthTime, connection->auth_time);
}

void state_toggle_data_type(AppState *state, DataType data_type) {
  state->data_type_enabled[data_type] = !state->data_type_enabled[data_type];
  prv_persist_enabled_data_types(state);
}

void state_begin_sync(AppState *state) {
  state->syncing = true;
  state->sync_failed = false;
}

void state_fail_sync(AppState *state) {
  state->syncing = false;
  state->sync_failed = true;
}

void state_complete_sync(
  AppState *state,
  time_t started_at,
  const time_t synced_through[DATA_TYPE_COUNT]
) {
  state->syncing = false;
  state->last_sync_time = started_at;
  persist_write_int(PersistKeyLastSyncTime, started_at);
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (synced_through[i] != 0) {
      state->data_type_last_sync_times[i] = synced_through[i];
      persist_write_int(PersistKeyFirstDataTypeLastSyncTime + i, synced_through[i]);
    }
  }
}

SyncButtonState state_sync_button_state(const AppState *state) {
  if (!state->connected) {
    return SyncButtonDisabled;
  }
  return state->syncing ? SyncButtonLoading : SyncButtonReady;
}
