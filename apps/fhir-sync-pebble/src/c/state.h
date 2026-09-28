#pragma once

#include <pebble.h>

#include "data-type.h"
#include "menu-text.h"

// The longest patient name the watch keeps, NUL included; longer names are
// truncated.
#define PATIENT_NAME_SIZE 64

// A FHIR date (YYYY-MM-DD) and the NUL.
#define BIRTH_DATE_SIZE 11

// PebbleKit JS's connection id ("wf-" and 32 hex digits) and the NUL.
#define CONNECTION_ID_SIZE 36

// The AppMessage inbox main opens. The largest message the phone sends is the
// settings, at most 144 bytes with every field at its longest (see the core's
// PhoneSettings.toWatchMessage).
#define APP_MESSAGE_INBOX_SIZE 256

// Who the watch records for, as the configuration page last sent it. The
// access token stays on the phone, in PebbleKit JS.
typedef struct {
  // Empty when the patient's record has no name.
  char patient_name[PATIENT_NAME_SIZE];
  // Empty when the patient's record has no birth date.
  char birth_date[BIRTH_DATE_SIZE];
  // When the configuration page handed over the settings.
  time_t auth_time;
  // Which patient on which FHIR server: the same for a sign-in again to the
  // same patient, different for any other.
  char connection_id[CONNECTION_ID_SIZE];
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
  // When the last successful sync started, 0 for never. Each data type's is
  // how far the last successful sync that included it reached: when it
  // started for Health Activity, the hour it started in for the minute types.
  time_t last_sync_time;
  time_t data_type_last_sync_times[DATA_TYPE_COUNT];
  // Whether a sync is under way.
  bool syncing;
  // Whether the last sync this run failed. Not persisted: a restart clears it.
  bool sync_failed;
} AppState;

// Fills state from what the last run persisted.
void state_load(AppState *state);

// Replaces the connection and persists it. When it names another patient or
// server than the one before (connection_id differs, or there was none), the
// last-sync times start over at never, so the next sync sends the new patient
// everything the watch holds; a sign-in again to the same patient keeps them.
// Returns whether they started over.
bool state_set_connection(AppState *state, const Connection *connection);

// Flips whether data_type syncs and persists the choice.
void state_toggle_data_type(AppState *state, DataType data_type);

// Marks a sync under way and clears the last one's failure.
void state_begin_sync(AppState *state);

// Ends the sync under way as failed, leaving the last-sync times alone.
void state_fail_sync(AppState *state);

// Ends the sync under way as a success that started at started_at, which
// becomes the last sync time. Each data type's last sync time becomes its
// synced_through entry, except where that is 0 (the type didn't sync). All of
// them are persisted.
void state_complete_sync(
  AppState *state,
  time_t started_at,
  const time_t synced_through[DATA_TYPE_COUNT]
);

// What the Sync Now row can do right now.
SyncButtonState state_sync_button_state(const AppState *state);
