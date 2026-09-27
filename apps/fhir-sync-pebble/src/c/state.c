#include "state.h"

// Persist keys. Never reuse a retired key's number: an installed watch still
// holds its old value.
enum {
  PersistKeyPatientName = 1,
  PersistKeyBirthDate = 2,
  PersistKeyAuthTime = 3,
  // A bitmask, one bit per DataType; set means the type syncs.
  PersistKeyEnabledDataTypes = 4,
};

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

SyncButtonState state_sync_button_state(const AppState *state) {
  if (!state->connected) {
    return SyncButtonDisabled;
  }
  return state->syncing ? SyncButtonLoading : SyncButtonReady;
}
