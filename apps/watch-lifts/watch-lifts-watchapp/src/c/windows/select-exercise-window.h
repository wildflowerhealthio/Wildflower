#pragma once

#include <pebble.h>

// Pushes the exercise list, the app's first window, and returns it.
Window *select_exercise_window_push(void);

// Redraws the list from s_weights, after state_set_weights changes them.
void select_exercise_window_reload(Window *window);
