#pragma once

#include <pebble.h>

void title_layer_window_load(Window *window, int exercise_index);
void title_layer_window_unload(Window *window);
void render_title_layer(int exercise_index);