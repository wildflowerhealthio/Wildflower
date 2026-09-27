#include <pebble.h>

#include "views/stats-bar-layer.h"
#include "windows/select-exercise-window.h"

static void prv_on_health_data(HealthEventType type, void *context) {
  if (type != HealthEventHeartRateUpdate) {
    return;
  }
  stats_bar_layer_refresh_all();
}

static void prv_on_minute_tick(struct tm *tick_time, TimeUnits units_changed) {
  stats_bar_layer_refresh_all();
}

static void prv_subscribe_heart_rate(void) {
  bool health_service_subscribe_success = health_service_events_subscribe(prv_on_health_data, NULL);
  bool sample_rate_success =
    health_service_subscribe_success && health_service_set_heart_rate_sample_period(15);
  stats_bar_layer_set_heart_rate_available(sample_rate_success);
  stats_bar_layer_refresh_all();
}

static void prv_unsubscribe_heart_rate(void) {
  health_service_events_unsubscribe();
  health_service_set_heart_rate_sample_period(0);
}

static void prv_subscribe_minute_ticks(void) {
  tick_timer_service_subscribe(MINUTE_UNIT, prv_on_minute_tick);
}

static void prv_unsubscribe_minute_ticks(void) {
  tick_timer_service_unsubscribe();
}

int main(void) {
  select_exercise_window_push();
  prv_subscribe_heart_rate();
  prv_subscribe_minute_ticks();

  app_event_loop();

  prv_unsubscribe_minute_ticks();
  prv_unsubscribe_heart_rate();
}
