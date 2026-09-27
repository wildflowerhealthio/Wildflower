#pragma once

#include <pebble.h>

typedef struct StatsBarLayer StatsBarLayer;

StatsBarLayer *stats_bar_layer_create(GRect frame);
void stats_bar_layer_destroy(StatsBarLayer *stats_bar_layer);
Layer *stats_bar_layer_get_layer(StatsBarLayer *stats_bar_layer);

// Re-reads the current heart rate and time into every live stats bar. main
// calls this from the app-wide health and tick events.
void stats_bar_layer_refresh_all(void);

// Makes every stats bar show an error in place of the heart rate from its next
// refresh on (call stats_bar_layer_refresh_all to show it now). For when the
// heart rate subscription can't be set up.
void stats_bar_layer_set_heart_rate_unavailable(bool unavailable);
