// Host-side driver for sync.c, built and run by sync.test.ts against the
// pebble.h stand-in in pebble-stand-in/, with state.c and minute-wire.c. The
// stand-in's SDK calls are defined here: AppMessage records each message sent,
// the one timer sync.c keeps is recorded rather than run, HealthService yields
// the activities the scenario adds and no minute history, and persist storage
// is in memory. One command line is one scenario: steps separated by ';', run
// in order, each printing one word or line, joined by spaces:
//   clock <unix seconds>                ->  sets time(): "ok"
//   connect <connection id>             ->  state_set_connection: "reset" or "kept"
//   activity <type> <start> <end>       ->  adds a HealthService activity: "ok"
//   start                               ->  sync_start: "started"
//   ack                                 ->  sync_handle_outbox_sent: "acked"
//   fail-send                           ->  sync_handle_outbox_failed: "failed-send"
//   result <sync id> <0|1>              ->  sync_handle_result: "answered"
//   abandon                             ->  sync_abandon: "abandoned"
//   fire                                ->  runs the timer's callback: "fired"
//   outbox                              ->  the last message sent, "Key=value,...",
//                                           MinuteData as its size
//   timer                               ->  the timer's timeout in ms, or "none"
//   iterated                            ->  the time_start of the last activity
//                                           iteration, or "none"
//   status                              ->  "syncing", "failed" or "idle", then
//                                           the last sync time
// Every scenario starts from empty persist storage, with every data type
// checked, at clock 0.

#include <pebble.h>

#include "../src/c/state.h"
#include "../src/c/sync.h"
#include "../src/c/windows/settings-window.h"

#define MAX_LINE 1024
#define MAX_PERSISTED 64
#define MAX_TEXT 512
#define MAX_ACTIVITIES 16

// Persist storage, in memory.
typedef struct {
  uint32_t key;
  bool is_string;
  int32_t value;
  char string[MAX_TEXT];
} PersistedValue;

static PersistedValue s_persisted[MAX_PERSISTED];
static int s_persisted_count;

static PersistedValue *prv_find(uint32_t key) {
  for (int i = 0; i < s_persisted_count; i++) {
    if (s_persisted[i].key == key) {
      return &s_persisted[i];
    }
  }
  return NULL;
}

static PersistedValue *prv_find_or_add(uint32_t key) {
  PersistedValue *found = prv_find(key);
  if (found == NULL) {
    found = &s_persisted[s_persisted_count++];
    *found = (PersistedValue){ .key = key };
  }
  return found;
}

bool persist_exists(const uint32_t key) {
  return prv_find(key) != NULL;
}

int32_t persist_read_int(const uint32_t key) {
  PersistedValue *found = prv_find(key);
  return found == NULL || found->is_string ? 0 : found->value;
}

status_t persist_write_int(const uint32_t key, const int32_t value) {
  PersistedValue *slot = prv_find_or_add(key);
  slot->is_string = false;
  slot->value = value;
  return 4;
}

int persist_read_string(const uint32_t key, char *buffer, const size_t buffer_size) {
  PersistedValue *found = prv_find(key);
  if (found == NULL || !found->is_string || buffer_size == 0) {
    return -1;
  }
  snprintf(buffer, buffer_size, "%s", found->string);
  return (int)strlen(buffer) + 1;
}

int persist_write_string(const uint32_t key, const char *cstring) {
  PersistedValue *slot = prv_find_or_add(key);
  slot->is_string = true;
  snprintf(slot->string, sizeof(slot->string), "%s", cstring);
  return (int)strlen(slot->string) + 1;
}

// The clock.
static time_t s_now;

time_t stand_in_time(time_t *now) {
  if (now != NULL) {
    *now = s_now;
  }
  return s_now;
}

// The one timer: its timeout and callback, or no callback when none is set.
struct AppTimer {
  uint32_t timeout_ms;
  AppTimerCallback callback;
  void *data;
};

static AppTimer s_timer;

AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data) {
  s_timer = (AppTimer){ .timeout_ms = timeout_ms, .callback = callback, .data = callback_data };
  return &s_timer;
}

bool app_timer_reschedule(AppTimer *timer, uint32_t new_timeout_ms) {
  if (timer != &s_timer || s_timer.callback == NULL) {
    return false;
  }
  s_timer.timeout_ms = new_timeout_ms;
  return true;
}

void app_timer_cancel(AppTimer *timer) {
  if (timer == &s_timer) {
    s_timer.callback = NULL;
  }
}

// AppMessage: the message being written, and the last one sent.
static char s_writing[MAX_TEXT];
static char s_last_sent[MAX_TEXT];

static const char *prv_key_name(uint32_t key) {
  switch (key) {
    case MESSAGE_KEY_SyncStart:
      return "SyncStart";
    case MESSAGE_KEY_ConnectionId:
      return "ConnectionId";
    case MESSAGE_KEY_ActivityType:
      return "ActivityType";
    case MESSAGE_KEY_ActivityStart:
      return "ActivityStart";
    case MESSAGE_KEY_ActivityEnd:
      return "ActivityEnd";
    case MESSAGE_KEY_ActivityCount:
      return "ActivityCount";
    case MESSAGE_KEY_MinuteHourStart:
      return "MinuteHourStart";
    case MESSAGE_KEY_MinuteTypes:
      return "MinuteTypes";
    case MESSAGE_KEY_MinuteData:
      return "MinuteData";
    case MESSAGE_KEY_MinuteHourCount:
      return "MinuteHourCount";
    default:
      return "?";
  }
}

static void prv_append(uint32_t key, const char *value) {
  size_t used = strlen(s_writing);
  snprintf(
    s_writing + used,
    sizeof(s_writing) - used,
    "%s%s=%s",
    used == 0 ? "" : ",",
    prv_key_name(key),
    value
  );
}

AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator) {
  s_writing[0] = '\0';
  *iterator = NULL;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_send(void) {
  snprintf(s_last_sent, sizeof(s_last_sent), "%s", s_writing);
  return APP_MSG_OK;
}

DictionaryResult dict_write_int32(
  DictionaryIterator *iterator,
  const uint32_t key,
  const int32_t value
) {
  (void)iterator;
  char text[16];
  snprintf(text, sizeof(text), "%ld", (long)value);
  prv_append(key, text);
  return 0;
}

DictionaryResult dict_write_cstring(
  DictionaryIterator *iterator,
  const uint32_t key,
  const char *cstring
) {
  (void)iterator;
  prv_append(key, cstring);
  return 0;
}

DictionaryResult dict_write_data(
  DictionaryIterator *iterator,
  const uint32_t key,
  const uint8_t *data,
  const uint16_t size
) {
  (void)iterator;
  (void)data;
  char text[16];
  snprintf(text, sizeof(text), "%u", (unsigned)size);
  prv_append(key, text);
  return 0;
}

// HealthService: the scenario's activities, and no minute history.
typedef struct {
  HealthActivity activity;
  time_t start;
  time_t end;
} StoredActivity;

static StoredActivity s_activities[MAX_ACTIVITIES];
static int s_activity_count;
static bool s_iterated;
static time_t s_iterated_from;

bool health_service_activities_iterate(
  HealthActivityMask activity_mask,
  time_t time_start,
  time_t time_end,
  HealthIterationDirection direction,
  HealthActivityIteratorCB callback,
  void *context
) {
  (void)activity_mask;
  (void)direction;
  s_iterated = true;
  s_iterated_from = time_start;
  for (int i = 0; i < s_activity_count; i++) {
    const StoredActivity *stored = &s_activities[i];
    // Like HealthService, yields every activity overlapping the span.
    if (stored->end > time_start && stored->start < time_end) {
      if (!callback(stored->activity, stored->start, stored->end, context)) {
        break;
      }
    }
  }
  return true;
}

uint32_t health_service_get_minute_history(
  HealthMinuteData *minute_data,
  uint32_t max_records,
  time_t *time_start,
  time_t *time_end
) {
  (void)minute_data;
  (void)max_records;
  (void)time_start;
  (void)time_end;
  return 0;
}

// The window sync.c redraws.
void settings_window_reload(Window *window) {
  (void)window;
}

static void prv_step(AppState *state, Sync *sync, const char *step) {
  while (*step == ' ') {
    step++;
  }
  if (strncmp(step, "clock ", 6) == 0) {
    s_now = (time_t)strtol(step + 6, NULL, 10);
    printf("ok");
  } else if (strncmp(step, "connect ", 8) == 0) {
    Connection connection = { .auth_time = s_now };
    size_t length = strlen(step + 8);
    if (length >= sizeof(connection.connection_id)) {
      length = sizeof(connection.connection_id) - 1;
    }
    memcpy(connection.connection_id, step + 8, length);
    connection.connection_id[length] = '\0';
    printf("%s", state_set_connection(state, &connection) ? "reset" : "kept");
  } else if (strncmp(step, "activity ", 9) == 0) {
    long type = 0;
    long start = 0;
    long end = 0;
    if (
      sscanf(step + 9, "%ld %ld %ld", &type, &start, &end) != 3 ||
      s_activity_count == MAX_ACTIVITIES
    ) {
      fprintf(stderr, "bad activity: %s\n", step);
      exit(1);
    }
    s_activities[s_activity_count++] =
      (StoredActivity){ .activity = (HealthActivity)type, .start = start, .end = end };
    printf("ok");
  } else if (strcmp(step, "start") == 0) {
    sync_start(sync);
    printf("started");
  } else if (strcmp(step, "ack") == 0) {
    sync_handle_outbox_sent(sync);
    printf("acked");
  } else if (strcmp(step, "fail-send") == 0) {
    sync_handle_outbox_failed(sync, APP_MSG_SEND_TIMEOUT);
    printf("failed-send");
  } else if (strncmp(step, "result ", 7) == 0) {
    long id = 0;
    int succeeded = 0;
    if (sscanf(step + 7, "%ld %d", &id, &succeeded) != 2) {
      fprintf(stderr, "bad result: %s\n", step);
      exit(1);
    }
    sync_handle_result(sync, (int32_t)id, succeeded != 0);
    printf("answered");
  } else if (strcmp(step, "abandon") == 0) {
    sync_abandon(sync);
    printf("abandoned");
  } else if (strcmp(step, "fire") == 0) {
    AppTimer fired = s_timer;
    if (fired.callback != NULL) {
      s_timer.callback = NULL;
      fired.callback(fired.data);
    }
    printf("fired");
  } else if (strcmp(step, "outbox") == 0) {
    printf("%s", s_last_sent);
  } else if (strcmp(step, "timer") == 0) {
    if (s_timer.callback == NULL) {
      printf("none");
    } else {
      printf("%lu", (unsigned long)s_timer.timeout_ms);
    }
  } else if (strcmp(step, "iterated") == 0) {
    if (s_iterated) {
      printf("%ld", (long)s_iterated_from);
    } else {
      printf("none");
    }
  } else if (strcmp(step, "status") == 0) {
    printf(
      "%s %ld",
      state->syncing ? "syncing" : (state->sync_failed ? "failed" : "idle"),
      (long)state->last_sync_time
    );
  } else {
    fprintf(stderr, "unknown step: %s\n", step);
    exit(1);
  }
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    AppState state;
    state_load(&state);
    Sync sync;
    sync_init(&sync, &state, NULL);
    bool first = true;
    for (char *step = strtok(line, ";"); step != NULL; step = strtok(NULL, ";")) {
      if (!first) {
        printf(" ");
      }
      first = false;
      prv_step(&state, &sync, step);
    }
    printf("\n");
    // The sync's allocations belong to it until it finishes.
    free(sync.activities);
    free(sync.hour_minutes);
    free(sync.hour_bytes);
  }
  return 0;
}
