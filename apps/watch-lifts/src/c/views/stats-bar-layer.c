#include <pebble.h>

#include "stats-bar-layer.h"
#include "stats-bar-layer/heart-rate-layer.h"
#include "stats-bar-layer/clock-layer.h"

struct StatsBarLayer {
  Layer *root_layer;
  HeartRateLayer *heart_rate_layer;
  ClockLayer *clock_layer;
};

// One bar per window, so this caps how deep the app's window stack can go
// while every bar still refreshes.
#define MAX_STATS_BAR_LAYERS 8

// Every live bar, pushed as its window loads and popped as it unloads, so the
// app-wide health and tick events can refresh them all. Bars under the top
// window are refreshed too, so they are already current when their window
// reappears.
static StatsBarLayer *s_stats_bar_layers[MAX_STATS_BAR_LAYERS];
static int s_stats_bar_layer_count;

// App-wide rather than per bar: the heart rate subscription is set up once in
// main, and every bar built after a failure has to keep showing it. Assumed
// available until main hears otherwise, since the first window's bar is built
// before main subscribes.
static bool s_heart_rate_available = true;

static void prv_refresh(StatsBarLayer *stats_bar_layer);

static void prv_push(StatsBarLayer *stats_bar_layer) {
  if (s_stats_bar_layer_count == MAX_STATS_BAR_LAYERS) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Too many stats bars; this one won't refresh");
    return;
  }
  s_stats_bar_layers[s_stats_bar_layer_count++] = stats_bar_layer;
}

// Windows unload in stack order, so this is almost always the top bar. One
// removed from the middle (window_stack_remove) is taken out and the bars above
// it shift down, so the stack never holds a freed bar.
static void prv_pop(StatsBarLayer *stats_bar_layer) {
  for (int i = s_stats_bar_layer_count - 1; i >= 0; i--) {
    if (s_stats_bar_layers[i] == stats_bar_layer) {
      for (int j = i; j < s_stats_bar_layer_count - 1; j++) {
        s_stats_bar_layers[j] = s_stats_bar_layers[j + 1];
      }
      s_stats_bar_layer_count--;
      return;
    }
  }
}

StatsBarLayer *stats_bar_layer_create(GRect frame) {
  StatsBarLayer *stats_bar_layer = malloc(sizeof(StatsBarLayer));
  stats_bar_layer->root_layer = layer_create(frame);
  GRect bounds = layer_get_bounds(stats_bar_layer->root_layer);
  int half_width = bounds.size.w / 2;

  stats_bar_layer->heart_rate_layer =
    heart_rate_layer_create(GRect(0, 0, half_width, bounds.size.h));
  layer_add_child(
    stats_bar_layer->root_layer,
    heart_rate_layer_get_layer(stats_bar_layer->heart_rate_layer)
  );

  stats_bar_layer->clock_layer =
    clock_layer_create(GRect(half_width, 0, bounds.size.w - half_width, bounds.size.h));
  layer_add_child(stats_bar_layer->root_layer, clock_layer_get_layer(stats_bar_layer->clock_layer));

  prv_push(stats_bar_layer);
  prv_refresh(stats_bar_layer);
  return stats_bar_layer;
}

void stats_bar_layer_destroy(StatsBarLayer *stats_bar_layer) {
  prv_pop(stats_bar_layer);
  clock_layer_destroy(stats_bar_layer->clock_layer);
  heart_rate_layer_destroy(stats_bar_layer->heart_rate_layer);
  layer_destroy(stats_bar_layer->root_layer);
  free(stats_bar_layer);
}

Layer *stats_bar_layer_get_layer(StatsBarLayer *stats_bar_layer) {
  return stats_bar_layer->root_layer;
}

static void prv_refresh(StatsBarLayer *stats_bar_layer) {
  if (s_heart_rate_available) {
    heart_rate_layer_set_bpm(
      stats_bar_layer->heart_rate_layer,
      (int)health_service_peek_current_value(HealthMetricHeartRateRawBPM)
    );
  } else {
    heart_rate_layer_show_error(stats_bar_layer->heart_rate_layer);
  }
  clock_layer_update_time(stats_bar_layer->clock_layer);
}

void stats_bar_layer_refresh_all(void) {
  for (int i = 0; i < s_stats_bar_layer_count; i++) {
    prv_refresh(s_stats_bar_layers[i]);
  }
}

void stats_bar_layer_set_heart_rate_available(bool available) {
  s_heart_rate_available = available;
}
