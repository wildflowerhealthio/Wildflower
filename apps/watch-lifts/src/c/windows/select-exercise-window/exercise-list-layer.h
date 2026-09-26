#pragma once

#include <pebble.h>

typedef struct ExerciseListLayer ExerciseListLayer;

typedef void (*ExerciseSelectedHandler)(int exercise_index);

// Takes over click_window's click config so the buttons scroll the list.
ExerciseListLayer *exercise_list_layer_create(GRect frame, Window *click_window,
                                              ExerciseSelectedHandler on_exercise_selected);
void exercise_list_layer_destroy(ExerciseListLayer *exercise_list_layer);
Layer *exercise_list_layer_get_layer(ExerciseListLayer *exercise_list_layer);
