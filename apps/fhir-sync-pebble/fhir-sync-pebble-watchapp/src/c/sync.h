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
//   - SyncStart, the sync's id, so the phone starts collecting afresh, and
//     ConnectionId, the connection the last-sync times belong to, which the
//     phone checks against its settings before writing;
//   - each Health activity that ended since that type's last sync, less
//     SYNC_ACTIVITY_LOOKBACK_SECONDS (ActivityType, ActivityStart, ActivityEnd);
//   - each whole clock hour of minute history some checked minute type (every
//     DataType but Health Activity) hasn't synced yet (MinuteHourStart,
//     MinuteTypes, MinuteData; see minute-wire.h), skipping hours with no
//     valid minute;
//   - then ActivityCount and MinuteHourCount.
// The phone writes them to the server and answers SyncSucceeded with SyncId,
// the id SyncStart carried; an answer for another sync is ignored. The
// phone's writes are idempotent, so sending a record again is harmless. See
// pkjs/src/index.ts for the other side.
//
// main owns the one instance and hands it the AppMessage callbacks. The fields
// past id are only meaningful while state->syncing.
typedef struct {
  AppState *state;
  // Redrawn as the sync starts and ends.
  Window *settings_window;
  // The sync's id, which SyncStart carries and SyncId answers; 0 before the
  // first sync this run. Kept past the sync so the next can take a later one.
  int32_t id;
  // When the sync started. Health Activity covers up to it; the minute types
  // up to the start of its hour.
  time_t started_at;
  // What each data type's last sync time becomes on success, 0 for the types
  // this sync leaves alone.
  time_t synced_through[DATA_TYPE_COUNT];
  // Activities that ended at or before this aren't sent: Health Activity's
  // last sync less SYNC_ACTIVITY_LOOKBACK_SECONDS.
  time_t activities_after;
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
  // Set once SyncStart is sent.
  bool start_sent;
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

// The phone's SyncSucceeded answer to the sync sync_id: whether the server
// stored everything sent. Ignored unless it answers the sync under way.
void sync_handle_result(Sync *sync, int32_t sync_id, bool succeeded);

// Ends the sync under way, if any, as failed: its last-sync times belong to a
// connection that has since changed.
void sync_abandon(Sync *sync);
