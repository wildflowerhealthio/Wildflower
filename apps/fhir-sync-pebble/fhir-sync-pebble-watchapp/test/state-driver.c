// Host-side driver for state.c, built and run by state.test.ts against the
// pebble.h stand-in in pebble-stand-in/. Persist storage lives in memory for
// the process, so one command line is one scenario: steps separated by ';',
// run in order against one AppState, each printing one word or line of
// numbers, joined by spaces:
//   connect <connection id> <auth time>  ->  state_set_connection: "reset" or "kept"
//   complete <started at> <synced_through x DATA_TYPE_COUNT>
//                                         ->  state_begin_sync, state_complete_sync: "done"
//   restart                               ->  state_load, as the app's next run: "loaded"
//   times                                 ->  "<last sync> <each data type's>"
//   connection                            ->  "<connected> <connection id> <auth time>"
//   sizes  ->  "<DATA_TYPE_COUNT> <PATIENT_NAME_SIZE> <BIRTH_DATE_SIZE>
//              <CONNECTION_ID_SIZE> <APP_MESSAGE_INBOX_SIZE>", so the test reads
//              the limits instead of copying them
// The patient's name and birth date don't decide anything state.c does, so
// every connection carries the same ones.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/c/state.h"

#define MAX_LINE 1024
#define MAX_PERSISTED 256
#define MAX_PERSISTED_STRING 256

// The persist storage stand-in: one slot per key used.
typedef struct {
  uint32_t key;
  bool is_string;
  int32_t value;
  char string[MAX_PERSISTED_STRING];
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
  if (found != NULL) {
    return found;
  }
  if (s_persisted_count == MAX_PERSISTED) {
    fprintf(stderr, "persist storage full\n");
    exit(1);
  }
  found = &s_persisted[s_persisted_count++];
  *found = (PersistedValue){ .key = key };
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

static void prv_connect(AppState *state, const char *args) {
  Connection connection = { .auth_time = 0 };
  snprintf(connection.patient_name, sizeof(connection.patient_name), "Ada Lovelace");
  snprintf(connection.birth_date, sizeof(connection.birth_date), "1815-12-10");
  char connection_id[MAX_LINE];
  long auth_time = 0;
  if (sscanf(args, "%1023s %ld", connection_id, &auth_time) != 2) {
    fprintf(stderr, "bad connect: %s\n", args);
    exit(1);
  }
  // Cut to fit, as the watch's snprintf cuts what the phone sends.
  size_t length = strlen(connection_id);
  if (length >= sizeof(connection.connection_id)) {
    length = sizeof(connection.connection_id) - 1;
  }
  memcpy(connection.connection_id, connection_id, length);
  connection.connection_id[length] = '\0';
  connection.auth_time = (time_t)auth_time;
  printf("%s", state_set_connection(state, &connection) ? "reset" : "kept");
}

static void prv_complete(AppState *state, const char *args) {
  time_t synced_through[DATA_TYPE_COUNT];
  char *end;
  time_t started_at = (time_t)strtol(args, &end, 10);
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    synced_through[i] = (time_t)strtol(end, &end, 10);
  }
  state_begin_sync(state);
  state_complete_sync(state, started_at, synced_through);
  printf("done");
}

static void prv_times(const AppState *state) {
  printf("%ld", (long)state->last_sync_time);
  for (int i = 0; i < DATA_TYPE_COUNT; i++) {
    printf(" %ld", (long)state->data_type_last_sync_times[i]);
  }
}

static void prv_step(AppState *state, const char *step) {
  while (*step == ' ') {
    step++;
  }
  if (strncmp(step, "connect ", 8) == 0) {
    prv_connect(state, step + 8);
  } else if (strncmp(step, "complete ", 9) == 0) {
    prv_complete(state, step + 9);
  } else if (strcmp(step, "restart") == 0) {
    state_load(state);
    printf("loaded");
  } else if (strcmp(step, "times") == 0) {
    prv_times(state);
  } else if (strcmp(step, "connection") == 0) {
    printf(
      "%d %s %ld",
      state->connected,
      state->connection.connection_id,
      (long)state->connection.auth_time
    );
  } else if (strcmp(step, "sizes") == 0) {
    printf(
      "%d %d %d %d %d",
      DATA_TYPE_COUNT,
      PATIENT_NAME_SIZE,
      BIRTH_DATE_SIZE,
      CONNECTION_ID_SIZE,
      APP_MESSAGE_INBOX_SIZE
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
    bool first = true;
    for (char *step = strtok(line, ";"); step != NULL; step = strtok(NULL, ";")) {
      if (!first) {
        printf(" ");
      }
      first = false;
      prv_step(&state, step);
    }
    printf("\n");
  }
  return 0;
}
