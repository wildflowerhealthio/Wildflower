// Host-side driver for state.c, built and run by state.test.ts against the
// pebble.h stand-in in pebble-stand-in/. Persist storage lives in memory for
// the process, so one command line is one scenario: steps separated by ';',
// run in order, each printing one result, joined by "; ":
//   exercises          ->  s_exercises, joined by '|'
//   people             ->  s_people_names, joined by '|'
//   load               ->  state_load: "loaded"
//   restart            ->  s_weights scribbled over, then state_load, as the
//                          app's next run: "loaded"
//   set <weights>      ->  state_set_weights with PEOPLE_COUNT x
//                          EXERCISE_COUNT weights, person-major: "set"
//   weights            ->  s_weights, person-major, space-separated
//   keys               ->  the persist keys written, space-separated
//   persist <key> <n>  ->  n bytes of 0x7f written under key, as another
//                          layout might have left: "persisted"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <pebble.h>

#include "../src/c/state.h"

#define MAX_LINE 1024
#define MAX_PERSISTED 16
// pebble.h's PERSIST_DATA_MAX_LENGTH.
#define MAX_PERSISTED_SIZE 256

// The persist storage stand-in: one slot per key written.
typedef struct {
  uint32_t key;
  size_t size;
  uint8_t data[MAX_PERSISTED_SIZE];
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

int persist_get_size(const uint32_t key) {
  PersistedValue *found = prv_find(key);
  return found == NULL ? E_DOES_NOT_EXIST : (int)found->size;
}

int persist_read_data(const uint32_t key, void *buffer, const size_t buffer_size) {
  PersistedValue *found = prv_find(key);
  if (found == NULL) {
    return E_DOES_NOT_EXIST;
  }
  size_t size = found->size < buffer_size ? found->size : buffer_size;
  memcpy(buffer, found->data, size);
  return (int)size;
}

int persist_write_data(const uint32_t key, const void *data, const size_t size) {
  if (size > MAX_PERSISTED_SIZE) {
    fprintf(stderr, "persisted value too large\n");
    exit(1);
  }
  PersistedValue *found = prv_find(key);
  if (found == NULL) {
    if (s_persisted_count == MAX_PERSISTED) {
      fprintf(stderr, "persist storage full\n");
      exit(1);
    }
    found = &s_persisted[s_persisted_count++];
    found->key = key;
  }
  found->size = size;
  memcpy(found->data, data, size);
  return (int)size;
}

static void prv_print_names(char *const *names, int count) {
  for (int i = 0; i < count; i++) {
    printf(i == 0 ? "%s" : "|%s", names[i]);
  }
}

static void prv_print_weights(void) {
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      printf(person == 0 && exercise == 0 ? "%d" : " %d", s_weights[person][exercise]);
    }
  }
}

static void prv_set(char *args) {
  int weights[PEOPLE_COUNT][EXERCISE_COUNT] = { { 0 } };
  char *cursor = args;
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      weights[person][exercise] = (int)strtol(cursor, &cursor, 10);
    }
  }
  state_set_weights(weights);
  printf("set");
}

static void prv_persist(const char *args) {
  unsigned key = 0, size = 0;
  sscanf(args, "%u %u", &key, &size);
  uint8_t data[MAX_PERSISTED_SIZE];
  memset(data, 0x7f, sizeof(data));
  persist_write_data(key, data, size);
  printf("persisted");
}

static void prv_step(char *step) {
  while (*step == ' ') {
    step++;
  }
  if (strcmp(step, "exercises") == 0) {
    prv_print_names(s_exercises, EXERCISE_COUNT);
  } else if (strcmp(step, "people") == 0) {
    prv_print_names(s_people_names, PEOPLE_COUNT);
  } else if (strcmp(step, "load") == 0) {
    state_load();
    printf("loaded");
  } else if (strcmp(step, "restart") == 0) {
    memset(s_weights, 0x55, sizeof(s_weights));
    state_load();
    printf("loaded");
  } else if (strncmp(step, "set ", 4) == 0) {
    prv_set(step + 4);
  } else if (strcmp(step, "weights") == 0) {
    prv_print_weights();
  } else if (strcmp(step, "keys") == 0) {
    for (int i = 0; i < s_persisted_count; i++) {
      printf(i == 0 ? "%u" : " %u", (unsigned)s_persisted[i].key);
    }
  } else if (strncmp(step, "persist ", 8) == 0) {
    prv_persist(step + 8);
  } else {
    fprintf(stderr, "unknown step: %s\n", step);
    exit(1);
  }
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    int first = 1;
    for (char *step = strtok(line, ";"); step != NULL; step = strtok(NULL, ";")) {
      if (!first) {
        printf("; ");
      }
      first = 0;
      prv_step(step);
    }
    printf("\n");
  }
  return 0;
}
