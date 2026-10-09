#include <pebble.h>

#include "state.h"
#include "views/stats-bar-layer.h"
#include "weights-wire.h"
#include "windows/select-exercise-window.h"

// PebbleKit JS sends the weights when the settings page saves and whenever
// the app starts: the Weights key, laid out in weights-wire.h. A message that
// doesn't decode changes nothing. context is the exercise list's window.
static void prv_inbox_received(DictionaryIterator *iterator, void *context) {
  Tuple *weights_tuple = dict_find(iterator, MESSAGE_KEY_Weights);
  if (weights_tuple == NULL || weights_tuple->type != TUPLE_BYTE_ARRAY) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Message from the phone has no Weights bytes; ignoring it");
    return;
  }
  int weights[PEOPLE_COUNT][EXERCISE_COUNT];
  if (!weights_wire_decode(weights_tuple->value->data, weights_tuple->length, weights)) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Weights message doesn't decode; ignoring it");
    return;
  }
  state_set_weights(weights);
  select_exercise_window_reload(context);
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message from the phone dropped: %d", (int)reason);
}

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
  state_load();
  Window *select_exercise_window = select_exercise_window_push();

  app_message_set_context(select_exercise_window);
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  // The inbox fits the weights (WEIGHTS_WIRE_INBOX_SIZE); the watch sends the
  // phone nothing, so the outbox is empty.
  app_message_open(WEIGHTS_WIRE_INBOX_SIZE, 0);

  prv_subscribe_heart_rate();
  prv_subscribe_minute_ticks();

  app_event_loop();

  prv_unsubscribe_minute_ticks();
  prv_unsubscribe_heart_rate();
}
