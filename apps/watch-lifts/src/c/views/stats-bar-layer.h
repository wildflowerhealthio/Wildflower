#pragma once

#include <pebble.h>

typedef struct StatsBarLayer StatsBarLayer;

StatsBarLayer *stats_bar_layer_create(GRect frame);
void stats_bar_layer_destroy(StatsBarLayer *stats_bar_layer);
Layer *stats_bar_layer_get_layer(StatsBarLayer *stats_bar_layer);

// Re-reads the current heart rate and time. Only the top window hears the
// app-wide health and tick events, so windows also call this when they appear.
void stats_bar_layer_refresh(StatsBarLayer *stats_bar_layer);
void stats_bar_layer_show_heart_rate_error(StatsBarLayer *stats_bar_layer);
