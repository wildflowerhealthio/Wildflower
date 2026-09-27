#include <pebble.h>

#include "sync.h"
#include "windows/settings-window.h"

// How long the phone may stay quiet, after the watch's last acknowledged
// message, before the sync fails. Covers the FHIR request after the counts.
#define SYNC_TIMEOUT_MS 60000

// The start of the (UTC) hour time falls in.
static time_t prv_hour_of(time_t time) {
  return time - time % SECONDS_PER_HOUR;
}

// Whether the minute history carries data_type: all of them but Health
// Activity, which comes from the activity iteration.
static bool prv_is_minute_type(DataType data_type) {
  return data_type != DataTypeHealthActivity;
}

static void prv_finish(Sync *sync, bool succeeded) {
  if (sync->timeout != NULL) {
    app_timer_cancel(sync->timeout);
    sync->timeout = NULL;
  }
  free(sync->activities);
  sync->activities = NULL;
  free(sync->hour_minutes);
  sync->hour_minutes = NULL;
  free(sync->hour_bytes);
  sync->hour_bytes = NULL;
  if (succeeded) {
    state_complete_sync(sync->state, sync->started_at, sync->synced_through);
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

// The checked minute types that haven't synced hour yet, one bit per DataType.
// Their last sync times are always on the hour, or 0 for never.
static int prv_due_minute_types(const AppState *state, time_t hour) {
  int due = 0;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (prv_is_minute_type(i) && state->data_type_enabled[i] &&
        state->data_type_last_sync_times[i] <= hour) {
      due |= 1 << i;
    }
  }
  return due;
}

// The first hour of minute history to look at: the oldest last sync among the
// checked minute types or, when one has never synced, the hour of the oldest
// minute the watch holds. minutes_through when there is nothing to look at.
static time_t prv_first_minute_hour(const Sync *sync) {
  const AppState *state = sync->state;
  bool any_checked = false;
  time_t oldest = sync->minutes_through;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (prv_is_minute_type(i) && state->data_type_enabled[i]) {
      any_checked = true;
      if (state->data_type_last_sync_times[i] < oldest) {
        oldest = state->data_type_last_sync_times[i];
      }
    }
  }
  if (!any_checked) {
    return sync->minutes_through;
  }
  if (oldest != 0) {
    return oldest;
  }
  // Asking for one record from the epoch moves time_start to the oldest
  // record the watch has.
  HealthMinuteData oldest_minute;
  time_t start = 0;
  time_t end = sync->minutes_through;
  if (health_service_get_minute_history(&oldest_minute, 1, &start, &end) == 0) {
    return sync->minutes_through;
  }
  return prv_hour_of(start);
}

// Packs the next hour that has a due type and a valid minute into
// sync->hour_bytes, advancing sync->next_hour past it, and returns its start
// and due types through the pointers. False once no hour is left.
static bool prv_load_next_hour(Sync *sync, time_t *hour_start, int *due_types) {
  while (sync->next_hour < sync->minutes_through) {
    time_t hour = sync->next_hour;
    sync->next_hour += SECONDS_PER_HOUR;
    int due = prv_due_minute_types(sync->state, hour);
    if (due == 0) {
      continue;
    }

    // The records run contiguously from start, which may be past the hour's
    // first minute; the minutes they don't cover go out invalid.
    time_t start = hour;
    time_t end = hour + SECONDS_PER_HOUR;
    int count =
      health_service_get_minute_history(sync->hour_minutes, MINUTE_WIRE_HOUR_MINUTES, &start, &end);
    int first = count == 0 ? 0 : (start - hour) / SECONDS_PER_MINUTE;
    bool any_valid = false;
    for (int minute = 0; minute < MINUTE_WIRE_HOUR_MINUTES; minute++) {
      uint8_t *out = &sync->hour_bytes[minute * MINUTE_WIRE_SIZE];
      int index = minute - first;
      if (index < 0 || index >= count) {
        minute_wire_pack(out, 0, 0, 0, true, AmbientLightLevelUnknown, 0);
        continue;
      }
      const HealthMinuteData *data = &sync->hour_minutes[index];
      minute_wire_pack(
        out,
        data->steps,
        data->orientation,
        data->vmc,
        data->is_invalid,
        data->light,
        data->heart_rate_bpm
      );
      any_valid = any_valid || !data->is_invalid;
    }
    if (any_valid) {
      *hour_start = hour;
      *due_types = due;
      return true;
    }
  }
  return false;
}

// Sends the next message: the next activity, else the next hour of minute
// history, else the counts.
static void prv_send_next(Sync *sync) {
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result == APP_MSG_OK) {
    time_t hour_start;
    int due_types;
    if (sync->next_activity < sync->activity_count) {
      const RecordedActivity *recorded = &sync->activities[sync->next_activity++];
      dict_write_int32(iterator, MESSAGE_KEY_ActivityType, recorded->activity);
      dict_write_int32(iterator, MESSAGE_KEY_ActivityStart, recorded->start);
      dict_write_int32(iterator, MESSAGE_KEY_ActivityEnd, recorded->end);
    } else if (sync->hour_bytes != NULL && prv_load_next_hour(sync, &hour_start, &due_types)) {
      dict_write_int32(iterator, MESSAGE_KEY_MinuteHourStart, hour_start);
      dict_write_int32(iterator, MESSAGE_KEY_MinuteTypes, due_types);
      dict_write_data(iterator, MESSAGE_KEY_MinuteData, sync->hour_bytes, MINUTE_WIRE_HOUR_SIZE);
      sync->hour_count++;
    } else {
      dict_write_int32(iterator, MESSAGE_KEY_ActivityCount, sync->activity_count);
      dict_write_int32(iterator, MESSAGE_KEY_MinuteHourCount, sync->hour_count);
      sync->end_sent = true;
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
  time_t started_at = time(NULL);
  *sync = (Sync){
    .state = state,
    .settings_window = sync->settings_window,
    .started_at = started_at,
    .minutes_through = prv_hour_of(started_at),
  };
  settings_window_reload(sync->settings_window);

  bool any_checked = false;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    any_checked = any_checked || state->data_type_enabled[i];
  }
  if (!any_checked) {
    prv_finish(sync, true);
    return;
  }

  if (state->data_type_enabled[DataTypeHealthActivity]) {
    sync->synced_through[DataTypeHealthActivity] = started_at;
    health_service_activities_iterate(
      HealthActivityMaskAll,
      state->data_type_last_sync_times[DataTypeHealthActivity],
      started_at,
      HealthIterationDirectionFuture,
      prv_collect_activity,
      sync
    );
  }

  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (prv_is_minute_type(i) && state->data_type_enabled[i]) {
      sync->synced_through[i] = sync->minutes_through;
    }
  }
  sync->next_hour = prv_first_minute_hour(sync);
  if (sync->next_hour < sync->minutes_through) {
    sync->hour_minutes = malloc(MINUTE_WIRE_HOUR_MINUTES * sizeof(HealthMinuteData));
    sync->hour_bytes = malloc(MINUTE_WIRE_HOUR_SIZE);
    sync->out_of_memory =
      sync->out_of_memory || sync->hour_minutes == NULL || sync->hour_bytes == NULL;
  }

  if (sync->out_of_memory) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Out of memory starting the sync");
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
  if (!sync->end_sent) {
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
