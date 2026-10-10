#pragma once

#include <pebble.h>

typedef struct ClockLayer ClockLayer;

ClockLayer *clock_layer_create(GRect frame);
void clock_layer_destroy(ClockLayer *clock_layer);
Layer *clock_layer_get_layer(ClockLayer *clock_layer);
void clock_layer_update_time(ClockLayer *clock_layer);
