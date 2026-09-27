#pragma once

#include <pebble.h>

#include "minute-wire.h"
#include "state.h"

// One activity HealthService recorded, as the watch sends it to the phone.
typedef struct {
  HealthActivity activity;
  time_t start;
  time_t end;
} RecordedActivity;

// A sync to the FHIR server, run through PebbleKit JS. The watch sends, one
// AppMessage each and one at a time:
//   - each Health activity that ended since that type's last sync
//     (ActivityType, ActivityStart, ActivityEnd);
//   - each whole clock hour of minute history some checked minute type (every
//     DataType but Health Activity) hasn't synced yet (MinuteHourStart,
//     MinuteTypes, MinuteData; see minute-wire.h), skipping hours with no
//     valid minute;
//   - then ActivityCount and MinuteHourCount.
// The phone posts them and answers SyncSucceeded. See src/pkjs/index.js for the
// other side.
//
// main owns the one instance and hands it the AppMessage callbacks. The fields
// past settings_window are only meaningful while state->syncing.
typedef struct {
  AppState *state;
  // Redrawn as the sync starts and ends.
  Window *settings_window;
  // When the sync started. Health Activity covers up to it; the minute types
  // up to the start of its hour.
  time_t started_at;
  // What each data type's last sync time becomes on success, 0 for the types
  // this sync leaves alone.
  time_t synced_through[DATA_TYPE_COUNT];
  // The activities to send, malloc'd, and the index of the next one.
  RecordedActivity *activities;
  int activity_count;
  int activity_capacity;
  int next_activity;
  // Set when collecting the activities ran out of memory.
  bool out_of_memory;
  // The next hour of minute history to look at, and the end of the last one.
  time_t next_hour;
  time_t minutes_through;
  // The hour being sent: its minutes from HealthService and their wire bytes,
  // both malloc'd, and how many hours have been sent.
  HealthMinuteData *hour_minutes;
  uint8_t *hour_bytes;
  int hour_count;
  // Set once ActivityCount is sent; only the phone's answer is left.
  bool end_sent;
  // Fails the sync if the phone goes quiet.
  AppTimer *timeout;
} Sync;

// Sets sync up over state, redrawing settings_window as it runs. Both must
// outlive sync.
void sync_init(Sync *sync, AppState *state, Window *settings_window);

// Starts a sync. Only call it while state_sync_button_state is SyncButtonReady.
void sync_start(Sync *sync);

// The phone acknowledged the last message sync sent.
void sync_handle_outbox_sent(Sync *sync);

// The last message sync sent never reached the phone.
void sync_handle_outbox_failed(Sync *sync, AppMessageResult reason);

// The phone's SyncSucceeded answer: whether the server stored everything sent.
void sync_handle_result(Sync *sync, bool succeeded);
