#pragma once

#include <pebble.h>

void heart_rate_layer_window_load(Window *window);
void heart_rate_layer_window_unload(Window *window);
void render_heartrate();
void subscribe_heart_rate();
void unsubscribe_heart_rate();