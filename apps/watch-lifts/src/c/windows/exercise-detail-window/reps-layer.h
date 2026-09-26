#pragma once

#include <pebble.h>

typedef struct RepsLayer RepsLayer;

// Placeholder for the exercise-detail content area; draws nothing yet.
RepsLayer *reps_layer_create(GRect frame);
void reps_layer_destroy(RepsLayer *reps_layer);
Layer *reps_layer_get_layer(RepsLayer *reps_layer);
void reps_layer_set_person_name(RepsLayer *reps_layer, const char *name);
void reps_layer_set_weight(RepsLayer *reps_layer, int weight);
