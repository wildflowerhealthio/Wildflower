#include "weights-wire.h"

bool weights_wire_decode(
  const uint8_t *bytes,
  size_t length,
  int out[PEOPLE_COUNT][EXERCISE_COUNT]
) {
  if (length != WEIGHTS_WIRE_SIZE) {
    return false;
  }
  int decoded[PEOPLE_COUNT][EXERCISE_COUNT];
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      const uint8_t *weight = &bytes[2 * (person * EXERCISE_COUNT + exercise)];
      decoded[person][exercise] = weight[0] | (weight[1] << 8);
      if (decoded[person][exercise] > WEIGHTS_WIRE_MAX_WEIGHT) {
        return false;
      }
    }
  }
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      out[person][exercise] = decoded[person][exercise];
    }
  }
  return true;
}
