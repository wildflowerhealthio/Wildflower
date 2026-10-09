#include <pebble.h>

#include "state.h"

// Persist keys. Never renumber one: an installed watch still holds its value
// under the old number.
enum {
  // s_weights, as its sizeof(s_weights) bytes.
  PersistKeyWeights = 1,
};

char *s_exercises[EXERCISE_COUNT] = { "Squat",
                                      "Bench Press",
                                      "Bent Over Row",
                                      "Overhead Press",
                                      "Deadlift" };

char *s_people_names[PEOPLE_COUNT] = { "Ruth", "Chloe" };

// The weights until the phone's settings page sends others. watch-lifts-core-js's
// Lifts.DEFAULT_WEIGHTS mirrors them, with the exercises and people above;
// test/state.test.ts holds the two together.
static const int s_default_weights[PEOPLE_COUNT][EXERCISE_COUNT] = { { 60, 50, 50, 50, 85 },
                                                                     { 65, 55, 55, 45, 85 } };

int s_weights[PEOPLE_COUNT][EXERCISE_COUNT];

int s_set_counts[EXERCISE_COUNT] = { 5, 5, 5, 5, 1 };

// Every exercise gets MAX_SETS slots; only the first set_count[exercise] are
// real sets; the rest are zero-filled by the initializer.
int s_rep_count[PEOPLE_COUNT][EXERCISE_COUNT][MAX_SETS] = {
  { { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1 } },
  { { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5 } }
};

void state_load(void) {
  // A value of another size was written by some other layout, so it isn't
  // read as this one.
  if (persist_get_size(PersistKeyWeights) == (int)sizeof(s_weights)) {
    persist_read_data(PersistKeyWeights, s_weights, sizeof(s_weights));
  } else {
    memcpy(s_weights, s_default_weights, sizeof(s_weights));
  }
}

void state_set_weights(const int weights[PEOPLE_COUNT][EXERCISE_COUNT]) {
  memcpy(s_weights, weights, sizeof(s_weights));
  persist_write_data(PersistKeyWeights, s_weights, sizeof(s_weights));
}
