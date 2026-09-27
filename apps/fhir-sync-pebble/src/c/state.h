#pragma once

#include <pebble.h>

#include "data-type.h"
#include "menu-text.h"

// The longest patient name the watch keeps, NUL included; longer names are
// truncated.
#define PATIENT_NAME_SIZE 64

// A FHIR date (YYYY-MM-DD) and the NUL.
#define BIRTH_DATE_SIZE 11

// Who the watch records for, as the configuration page last sent it. The
// access token stays on the phone, in PebbleKit JS.
typedef struct {
  // Empty when the patient's record has no name.
  char patient_name[PATIENT_NAME_SIZE];
  // Empty when the patient's record has no birth date.
  char birth_date[BIRTH_DATE_SIZE];
  // When the configuration page handed over the settings.
  time_t auth_time;
} Connection;

// What the menu shows. main owns the one instance. Read the fields directly,
// but change them only through the state_* functions below, which persist
// what must outlive the app.
typedef struct {
  // Whether the configuration page has ever sent a connection.
  bool connected;
  // Only meaningful when connected.
  Connection connection;
  // Which data types sync; all of them until the user unchecks one.
  bool data_type_enabled[DATA_TYPE_COUNT];
  // Nothing syncs yet, so the times stay 0 ("never") and syncing stays false
  // until the sync itself lands.
  time_t last_sync_time;
  time_t data_type_last_sync_times[DATA_TYPE_COUNT];
  bool syncing;
} AppState;

// Fills state from what the last run persisted.
void state_load(AppState *state);

// Replaces the connection and persists it.
void state_set_connection(AppState *state, const Connection *connection);

// Flips whether data_type syncs and persists the choice.
void state_toggle_data_type(AppState *state, DataType data_type);

// What the Sync Now row can do right now.
SyncButtonState state_sync_button_state(const AppState *state);
