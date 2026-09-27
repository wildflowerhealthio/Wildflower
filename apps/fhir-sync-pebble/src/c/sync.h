#pragma once

#include <pebble.h>

#include "state.h"

// One activity HealthService recorded, as the watch sends it to the phone.
typedef struct {
  HealthActivity activity;
  time_t start;
  time_t end;
} RecordedActivity;

// A sync to the FHIR server, run through PebbleKit JS. Only Health Activity
// syncs so far: the watch sends each activity that ended since that type's last
// sync, one AppMessage each (ActivityType, ActivityStart, ActivityEnd), then
// ActivityCount; the phone posts them and answers SyncSucceeded. See
// src/pkjs/index.js for the other side.
//
// main owns the one instance and hands it the AppMessage callbacks. The fields
// past settings_window are only meaningful while state->syncing.
typedef struct {
  AppState *state;
  // Redrawn as the sync starts and ends.
  Window *settings_window;
  // When the sync started: the end of the span it covers, and what the synced
  // types' last-sync times become.
  time_t started_at;
  bool synced_data_types[DATA_TYPE_COUNT];
  // The activities to send, malloc'd, and how many messages (the activities,
  // then ActivityCount) the phone has acknowledged.
  RecordedActivity *activities;
  int activity_count;
  int activity_capacity;
  int acknowledged_count;
  // Set when collecting the activities ran out of memory.
  bool out_of_memory;
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

// The phone's SyncSucceeded answer: whether the server stored the activities.
void sync_handle_result(Sync *sync, bool succeeded);
