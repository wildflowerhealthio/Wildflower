#include <pebble.h>

#include "stats-bar-layer.h"
#include "stats-bar-layer/heart-rate-layer.h"
#include "stats-bar-layer/clock-layer.h"

struct StatsBarLayer {
  Layer *root_layer;
  HeartRateLayer *heart_rate_layer;
  ClockLayer *clock_layer;
  StatsBarLayer *next;
};

// Every live bar, newest first, so the app-wide health and tick events can
// refresh them all. Bars under the top window are refreshed too, so they are
// already current when their window reappears.
static StatsBarLayer *s_stats_bar_layers;

// App-wide rather than per bar: the heart rate subscription is set up once in
// main, and every bar built after a failure has to keep showing it.
static bool s_heart_rate_unavailable;

static void prv_refresh(StatsBarLayer *stats_bar_layer);

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

  stats_bar_layer->next = s_stats_bar_layers;
  s_stats_bar_layers = stats_bar_layer;

  prv_refresh(stats_bar_layer);
  return stats_bar_layer;
}

void stats_bar_layer_destroy(StatsBarLayer *stats_bar_layer) {
  for (StatsBarLayer **link = &s_stats_bar_layers; *link != NULL; link = &(*link)->next) {
    if (*link == stats_bar_layer) {
      *link = stats_bar_layer->next;
      break;
    }
  }
  clock_layer_destroy(stats_bar_layer->clock_layer);
  heart_rate_layer_destroy(stats_bar_layer->heart_rate_layer);
  layer_destroy(stats_bar_layer->root_layer);
  free(stats_bar_layer);
}

Layer *stats_bar_layer_get_layer(StatsBarLayer *stats_bar_layer) {
  return stats_bar_layer->root_layer;
}

static void prv_refresh(StatsBarLayer *stats_bar_layer) {
  if (s_heart_rate_unavailable) {
    heart_rate_layer_show_error(stats_bar_layer->heart_rate_layer);
  } else {
    heart_rate_layer_set_bpm(
      stats_bar_layer->heart_rate_layer,
      (int)health_service_peek_current_value(HealthMetricHeartRateRawBPM)
    );
  }
  clock_layer_update_time(stats_bar_layer->clock_layer);
}

void stats_bar_layer_refresh_all(void) {
  for (StatsBarLayer *stats_bar_layer = s_stats_bar_layers; stats_bar_layer != NULL;
       stats_bar_layer = stats_bar_layer->next) {
    prv_refresh(stats_bar_layer);
  }
}

void stats_bar_layer_set_heart_rate_unavailable(bool unavailable) {
  s_heart_rate_unavailable = unavailable;
}
