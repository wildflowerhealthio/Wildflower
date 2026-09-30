#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "state.h"

// The weights as the phone sends them, in the Weights message key's byte
// array: every person's weight at every exercise, person-major (the first
// person's weight at each exercise, then the next person's), each an unsigned
// 16-bit integer, low byte first. Encoded by watch-lifts-core's
// PhoneSettings.toWatchMessage. Kept free of pebble.h so the host tests build
// it.
#define WEIGHTS_WIRE_SIZE (2 * PEOPLE_COUNT * EXERCISE_COUNT)

// The heaviest weight a message may carry, in pounds; watch-lifts-core's
// Lifts.MAX_WEIGHT.
#define WEIGHTS_WIRE_MAX_WEIGHT 999

// The AppMessage inbox the weights need: dict_calc_buffer_size's 1-byte
// dictionary header, then the one tuple's 7-byte header and its bytes.
#define WEIGHTS_WIRE_INBOX_SIZE (1 + 7 + WEIGHTS_WIRE_SIZE)

// Decodes length bytes into out, [person][exercise]. Returns false, leaving
// out as it was, when length isn't WEIGHTS_WIRE_SIZE or a weight is over
// WEIGHTS_WIRE_MAX_WEIGHT.
bool weights_wire_decode(
  const uint8_t *bytes,
  size_t length,
  int out[PEOPLE_COUNT][EXERCISE_COUNT]
);
