#include <pebble.h>

#include "sync.h"
#include "windows/settings-window.h"

// How long the phone may stay quiet, after the watch's last acknowledged
// message, before the sync fails. Covers the FHIR request after ActivityCount.
#define SYNC_TIMEOUT_MS 60000

static void prv_finish(Sync *sync, bool succeeded) {
  if (sync->timeout != NULL) {
    app_timer_cancel(sync->timeout);
    sync->timeout = NULL;
  }
  free(sync->activities);
  sync->activities = NULL;
  if (succeeded) {
    state_complete_sync(sync->state, sync->started_at, sync->synced_data_types);
  } else {
    state_fail_sync(sync->state);
  }
  settings_window_reload(sync->settings_window);
}

static void prv_timeout(void *context) {
  Sync *sync = context;
  sync->timeout = NULL;
  APP_LOG(APP_LOG_LEVEL_ERROR, "Sync timed out waiting for the phone");
  prv_finish(sync, false);
}

// Appends the activity unless it ended by the last sync (the iteration also
// yields activities that merely overlap its span). Stops the iteration, with
// sync->out_of_memory set, when the list can't grow.
static bool prv_collect_activity(
  HealthActivity activity,
  time_t time_start,
  time_t time_end,
  void *context
) {
  Sync *sync = context;
  if (time_end <= sync->state->data_type_last_sync_times[DataTypeHealthActivity]) {
    return true;
  }
  if (sync->activity_count == sync->activity_capacity) {
    int capacity = sync->activity_capacity == 0 ? 16 : sync->activity_capacity * 2;
    RecordedActivity *activities =
      realloc(sync->activities, capacity * sizeof(RecordedActivity));
    if (activities == NULL) {
      sync->out_of_memory = true;
      return false;
    }
    sync->activities = activities;
    sync->activity_capacity = capacity;
  }
  sync->activities[sync->activity_count++] =
    (RecordedActivity){ .activity = activity, .start = time_start, .end = time_end };
  return true;
}

// Sends the message after the acknowledged ones: the next activity, or
// ActivityCount once every activity is acknowledged.
static void prv_send_next(Sync *sync) {
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result == APP_MSG_OK) {
    if (sync->acknowledged_count < sync->activity_count) {
      const RecordedActivity *recorded = &sync->activities[sync->acknowledged_count];
      dict_write_int32(iterator, MESSAGE_KEY_ActivityType, recorded->activity);
      dict_write_int32(iterator, MESSAGE_KEY_ActivityStart, recorded->start);
      dict_write_int32(iterator, MESSAGE_KEY_ActivityEnd, recorded->end);
    } else {
      dict_write_int32(iterator, MESSAGE_KEY_ActivityCount, sync->activity_count);
    }
    result = app_message_outbox_send();
  }
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Sync message could not be sent: %d", (int)result);
    prv_finish(sync, false);
  }
}

void sync_init(Sync *sync, AppState *state, Window *settings_window) {
  *sync = (Sync){ .state = state, .settings_window = settings_window };
}

void sync_start(Sync *sync) {
  AppState *state = sync->state;
  state_begin_sync(state);
  sync->started_at = time(NULL);
  sync->activities = NULL;
  sync->activity_count = 0;
  sync->activity_capacity = 0;
  sync->acknowledged_count = 0;
  sync->out_of_memory = false;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    sync->synced_data_types[i] = false;
  }
  settings_window_reload(sync->settings_window);

  // Nothing else syncs yet, so without Health Activity there is nothing to
  // send.
  if (!state->data_type_enabled[DataTypeHealthActivity]) {
    prv_finish(sync, true);
    return;
  }
  sync->synced_data_types[DataTypeHealthActivity] = true;
  health_service_activities_iterate(
    HealthActivityMaskAll,
    state->data_type_last_sync_times[DataTypeHealthActivity],
    sync->started_at,
    HealthIterationDirectionFuture,
    prv_collect_activity,
    sync
  );
  if (sync->out_of_memory) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Out of memory collecting activities");
    prv_finish(sync, false);
    return;
  }
  sync->timeout = app_timer_register(SYNC_TIMEOUT_MS, prv_timeout, sync);
  prv_send_next(sync);
}

void sync_handle_outbox_sent(Sync *sync) {
  if (!sync->state->syncing) {
    return;
  }
  app_timer_reschedule(sync->timeout, SYNC_TIMEOUT_MS);
  sync->acknowledged_count++;
  // Past the activities and ActivityCount, only the phone's answer is left.
  if (sync->acknowledged_count <= sync->activity_count) {
    prv_send_next(sync);
  }
}

void sync_handle_outbox_failed(Sync *sync, AppMessageResult reason) {
  if (!sync->state->syncing) {
    return;
  }
  APP_LOG(APP_LOG_LEVEL_ERROR, "Sync message failed: %d", (int)reason);
  prv_finish(sync, false);
}

void sync_handle_result(Sync *sync, bool succeeded) {
  if (!sync->state->syncing) {
    return;
  }
  prv_finish(sync, succeeded);
}
