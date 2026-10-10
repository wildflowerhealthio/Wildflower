#pragma once

#include <stddef.h>

#include "../../state.h"

// The text formatting behind RepsLayer, kept free of pebble.h so
// test/reps-text.test.ts can build and run it on the host.

// Each set is written as "%i  ": up to two digits and two spaces, plus the
// NUL. Longer rep counts are truncated rather than overflowing.
#define REPS_TEXT_SIZE (MAX_SETS * 4 + 1)

// Sized for two worst-case ints plus the fixed text so snprintf can never
// truncate.
#define WEIGHT_TEXT_SIZE 43

// Writes the first set_count entries of reps as "%i  " each; set_count is
// capped at MAX_SETS.
void reps_text_format_reps(char text[REPS_TEXT_SIZE], const int reps[MAX_SETS], int set_count);

// Writes "<weight> lbs - <per side> lbs / side", where per side is the load on
// each end of a 45 lb bar.
void reps_text_format_weight(char text[WEIGHT_TEXT_SIZE], int weight);
