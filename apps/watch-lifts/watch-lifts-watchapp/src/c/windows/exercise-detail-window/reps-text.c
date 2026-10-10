#include <stdio.h>

#include "reps-text.h"

void reps_text_format_reps(char text[REPS_TEXT_SIZE], const int reps[MAX_SETS], int set_count) {
  if (set_count > MAX_SETS) {
    set_count = MAX_SETS;
  }
  text[0] = '\0';
  // snprintf returns the length it wanted to write, so once it truncates,
  // length reaches the buffer size and the loop stops.
  size_t length = 0;
  for (int i = 0; i < set_count && length < REPS_TEXT_SIZE; i++) {
    length += snprintf(text + length, REPS_TEXT_SIZE - length, "%i  ", reps[i]);
  }
}

void reps_text_format_weight(char text[WEIGHT_TEXT_SIZE], int weight) {
  int bar = 45;
  int half_weight = (weight - bar) / 2;
  const char *half_str = (bar + half_weight * 2) < weight ? ".5" : "";
  snprintf(text, WEIGHT_TEXT_SIZE, "%i lbs - %i%s lbs / side", weight, half_weight, half_str);
}
