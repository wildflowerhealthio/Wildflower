#include <pebble.h>

#include "views/stats-bar-layer.h"
#include "windows/select-exercise-window.h"

// Every window stores its StatsBarLayer as its user data, so the one app-wide
// health subscription and tick subscription can update whichever is on top.
static StatsBarLayer *prv_top_stats_bar_layer(void)
{
  Window *top_window = window_stack_get_top_window();
  return top_window == NULL ? NULL : window_get_user_data(top_window);
}

static void prv_on_health_data(HealthEventType type, void *context)
{
  if (type != HealthEventHeartRateUpdate)
  {
    return;
  }
  StatsBarLayer *stats_bar_layer = prv_top_stats_bar_layer();
  if (stats_bar_layer != NULL)
  {
    stats_bar_layer_refresh(stats_bar_layer);
  }
}

static void prv_on_minute_tick(struct tm *tick_time, TimeUnits units_changed)
{
  StatsBarLayer *stats_bar_layer = prv_top_stats_bar_layer();
  if (stats_bar_layer != NULL)
  {
    stats_bar_layer_refresh(stats_bar_layer);
  }
}

static void prv_subscribe_heart_rate(void)
{
  bool health_service_subscribe_success = health_service_events_subscribe(prv_on_health_data, NULL);
  bool sample_rate_success = health_service_subscribe_success && health_service_set_heart_rate_sample_period(15);
  if (sample_rate_success)
  {
    return;
  }
  stats_bar_layer_set_heart_rate_unavailable(true);
  StatsBarLayer *stats_bar_layer = prv_top_stats_bar_layer();
  if (stats_bar_layer != NULL)
  {
    stats_bar_layer_refresh(stats_bar_layer);
  }
}

static void prv_unsubscribe_heart_rate(void)
{
  health_service_events_unsubscribe();
  health_service_set_heart_rate_sample_period(0);
}

static void prv_subscribe_minute_ticks(void)
{
  tick_timer_service_subscribe(MINUTE_UNIT, prv_on_minute_tick);
}

static void prv_unsubscribe_minute_ticks(void)
{
  tick_timer_service_unsubscribe();
}

int main(void)
{
  select_exercise_window_push();
  prv_subscribe_heart_rate();
  prv_subscribe_minute_ticks();

  app_event_loop();

  prv_unsubscribe_minute_ticks();
  prv_unsubscribe_heart_rate();
}
