#pragma once

#include <pebble.h>

#include "../../state.h"

typedef struct RepsLayer RepsLayer;

// Placeholder for the exercise-detail content area; draws nothing yet.
RepsLayer *reps_layer_create(GRect frame);
void reps_layer_destroy(RepsLayer *reps_layer);
Layer *reps_layer_get_layer(RepsLayer *reps_layer);
void reps_layer_set_person_name(RepsLayer *reps_layer, const char *name);
void reps_layer_set_weight(RepsLayer *reps_layer, int weight);
// Shows the first set_count entries of reps; set_count is capped at MAX_SETS.
void reps_layer_set_reps(RepsLayer *reps_layer, const int reps[MAX_SETS], int set_count);
