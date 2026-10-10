#pragma once

#include <pebble.h>

typedef struct HeartRateLayer HeartRateLayer;

HeartRateLayer *heart_rate_layer_create(GRect frame);
void heart_rate_layer_destroy(HeartRateLayer *heart_rate_layer);
Layer *heart_rate_layer_get_layer(HeartRateLayer *heart_rate_layer);
void heart_rate_layer_set_bpm(HeartRateLayer *heart_rate_layer, int bpm);
void heart_rate_layer_show_error(HeartRateLayer *heart_rate_layer);
