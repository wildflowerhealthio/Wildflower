#include <pebble.h>

#include "state.h"

char *s_exercises[5] = { "Squat", "Bench Press", "Bent Over Row", "Overhead Press", "Deadlift" };

int s_weights[2][5] = { { 60, 50, 50, 50, 85 }, { 65, 55, 55, 45, 85 } };

char *s_people_names[] = { "Ruth", "Chloe" };

int s_set_counts[5] = { 5, 5, 5, 5, 1 };

// Every exercise gets MAX_SETS slots; only the first set_count[exercise] are
// real sets; the rest are zero-filled by the initializer.
int s_rep_count[2][5][MAX_SETS] = {
  { { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1, 2, 3, 4, 5 }, { 1 } },
  { { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5, 4, 3, 2, 1 }, { 5 } }
};
