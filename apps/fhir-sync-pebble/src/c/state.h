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
  // When the last successful sync started, 0 for never; each data type's is
  // the last successful sync that included it.
  time_t last_sync_time;
  time_t data_type_last_sync_times[DATA_TYPE_COUNT];
  // Whether a sync is under way.
  bool syncing;
  // Whether the last sync this run failed. Not persisted: a restart clears it.
  bool sync_failed;
} AppState;

// Fills state from what the last run persisted.
void state_load(AppState *state);

// Replaces the connection and persists it.
void state_set_connection(AppState *state, const Connection *connection);

// Flips whether data_type syncs and persists the choice.
void state_toggle_data_type(AppState *state, DataType data_type);

// Marks a sync under way and clears the last one's failure.
void state_begin_sync(AppState *state);

// Ends the sync under way as failed, leaving the last-sync times alone.
void state_fail_sync(AppState *state);

// Ends the sync under way as a success that started at started_at: the last
// sync time, and each data type's that synced_data_types marks, become it and
// are persisted.
void state_complete_sync(
  AppState *state,
  time_t started_at,
  const bool synced_data_types[DATA_TYPE_COUNT]
);

// What the Sync Now row can do right now.
SyncButtonState state_sync_button_state(const AppState *state);
