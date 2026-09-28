#include <pebble.h>

#include "sync.h"
#include "windows/settings-window.h"

// How long the phone may take to acknowledge a message before the sync fails.
#define SYNC_TIMEOUT_MS 60000

// How long the phone may take to answer once it has the counts. It gives the
// FHIR request 60 s (REQUEST_TIMEOUT_MS in pkjs/src/index.ts) and answers 0
// when that runs out, so this adds 30 s for building the Bundle before the
// request and delivering the answer after it: the phone's timeout fires first,
// and the watch hears the failure rather than giving up on its own.
#define SYNC_RESULT_TIMEOUT_MS 90000

// How far before Health Activity's last sync each sync looks for activities.
// HealthService classifies some activities only after they end, sleep above
// all: a night's sleep is recorded once the watch sees the wearer wake, and
// then its restful stretches. A day covers a night of sleep ending before a
// sync and classified after it. Activities sent again are harmless: the phone
// writes each under an id from its type and start, so a second send replaces
// the first. The window adds at most a day's activities, a few dozen, to the
// list prv_collect_activity grows in memory, 12 bytes each.
#define SYNC_ACTIVITY_LOOKBACK_SECONDS (24 * SECONDS_PER_HOUR)

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

// Appends the activity unless it ended by sync->activities_after (the
// iteration also yields activities that merely overlap its span). Stops the
// iteration, with sync->out_of_memory set, when the list can't grow.
static bool prv_collect_activity(
  HealthActivity activity,
  time_t time_start,
  time_t time_end,
  void *context
) {
  Sync *sync = context;
  if (time_end <= sync->activities_after) {
    return true;
  }
  if (sync->activity_count == sync->activity_capacity) {
    int capacity = sync->activity_capacity == 0 ? 16 : sync->activity_capacity * 2;
    RecordedActivity *activities = realloc(sync->activities, capacity * sizeof(RecordedActivity));
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

// The minute types this sync covers that haven't synced hour yet, one bit per
// DataType. The types are the ones checked when the sync started (their
// synced_through is set), not the menu's live checkboxes: a type unchecked
// mid-sync would otherwise skip hours its synced_through still claims. Their
// last sync times are always on the hour, or 0 for never.
static int prv_due_minute_types(const Sync *sync, time_t hour) {
  const AppState *state = sync->state;
  int due = 0;
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    if (
      prv_is_minute_type(i) && sync->synced_through[i] != 0 &&
      state->data_type_last_sync_times[i] <= hour
    ) {
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
    int due = prv_due_minute_types(sync, hour);
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

// Sends the next message: SyncStart, else the next activity, else the next
// hour of minute history, else the counts.
static void prv_send_next(Sync *sync) {
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result == APP_MSG_OK) {
    time_t hour_start;
    int due_types;
    if (!sync->start_sent) {
      dict_write_int32(iterator, MESSAGE_KEY_SyncStart, sync->id);
      sync->start_sent = true;
    } else if (sync->next_activity < sync->activity_count) {
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
  // The start time, unless an earlier sync this run already took it: a sync
  // that fails straight away can be followed by another in the same second.
  int32_t id = started_at > sync->id ? (int32_t)started_at : sync->id + 1;
  time_t activity_last_sync = state->data_type_last_sync_times[DataTypeHealthActivity];
  *sync = (Sync){
    .state = state,
    .settings_window = sync->settings_window,
    .id = id,
    .started_at = started_at,
    .activities_after = activity_last_sync > SYNC_ACTIVITY_LOOKBACK_SECONDS
      ? activity_last_sync - SYNC_ACTIVITY_LOOKBACK_SECONDS
      : 0,
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
      sync->activities_after,
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
  if (sync->end_sent) {
    app_timer_reschedule(sync->timeout, SYNC_RESULT_TIMEOUT_MS);
    return;
  }
  app_timer_reschedule(sync->timeout, SYNC_TIMEOUT_MS);
  prv_send_next(sync);
}

void sync_handle_outbox_failed(Sync *sync, AppMessageResult reason) {
  if (!sync->state->syncing) {
    return;
  }
  APP_LOG(APP_LOG_LEVEL_ERROR, "Sync message failed: %d", (int)reason);
  prv_finish(sync, false);
}

void sync_handle_result(Sync *sync, int32_t sync_id, bool succeeded) {
  if (!sync->state->syncing || sync_id != sync->id) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Ignoring the phone's answer to sync %ld", (long)sync_id);
    return;
  }
  prv_finish(sync, succeeded);
}

void sync_abandon(Sync *sync) {
  if (!sync->state->syncing) {
    return;
  }
  APP_LOG(APP_LOG_LEVEL_WARNING, "Abandoning the sync: the connection changed");
  prv_finish(sync, false);
}
