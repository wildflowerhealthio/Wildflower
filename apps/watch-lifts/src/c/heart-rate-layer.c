#include <pebble.h>

#include "heart-rate-layer.h"
#include "ui-constants.h"

static TextLayer *s_heart_icon_layer;
static TextLayer *s_heartrate_text_layer;

char s_heartrate_buffer[4];

void render_heartrate()
{
  text_layer_set_text(s_heartrate_text_layer, s_heartrate_buffer);
}

void prv_on_health_data(HealthEventType type, void *context)
{
  // If the update was from the Heart Rate Monitor, query it
  if (type == HealthEventHeartRateUpdate)
  {
    HealthValue value = health_service_peek_current_value(HealthMetricHeartRateRawBPM);
    // Display the heart rate
    snprintf(s_heartrate_buffer, sizeof(s_heartrate_buffer), "%d", (int)value);
    render_heartrate();
  }
}

void heart_rate_layer_window_load(Window *window)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  int half_width = bounds.size.w / 2;

  s_heart_icon_layer = text_layer_create(
      GRect(0, bounds.size.h - stats_bar_height, stats_bar_height, stats_bar_height));
  text_layer_set_background_color(s_heart_icon_layer, GColorRed);
  text_layer_set_text_color(s_heart_icon_layer, GColorWhite);
  text_layer_set_text_alignment(s_heart_icon_layer, GTextAlignmentCenter);
  text_layer_set_font(s_heart_icon_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text(s_heart_icon_layer, "🖤");

  // Add it as a child layer to the Window's root layer
  layer_add_child(window_layer, text_layer_get_layer(s_heart_icon_layer));

  s_heartrate_text_layer = text_layer_create(
      GRect(stats_bar_height, bounds.size.h - stats_bar_height, half_width - stats_bar_height, stats_bar_height));
  text_layer_set_background_color(s_heartrate_text_layer, GColorRed);
  text_layer_set_text_color(s_heartrate_text_layer, GColorWhite);
  text_layer_set_text_alignment(s_heartrate_text_layer, GTextAlignmentLeft);
  text_layer_set_font(s_heartrate_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));

  // Add it as a child layer to the Window's root layer
  layer_add_child(window_layer, text_layer_get_layer(s_heartrate_text_layer));
  const char *current_text = text_layer_get_text(s_heartrate_text_layer);
  if (s_heartrate_buffer[0] == '\0')
  {
    text_layer_set_text(s_heartrate_text_layer, "... ...");
  }
  else
  {
    render_heartrate();
  }
}

void heart_rate_layer_window_unload(Window *window)
{
  text_layer_destroy(s_heartrate_text_layer);
  text_layer_destroy(s_heart_icon_layer);
}

void subscribe_heart_rate()
{
  bool health_service_subscribe_success = health_service_events_subscribe(prv_on_health_data, NULL);
  bool sample_rate_success = health_service_subscribe_success && health_service_set_heart_rate_sample_period(1);
  if (!sample_rate_success)
  {
    text_layer_set_text(s_heartrate_text_layer, "Error");
  }
}

void unsubscribe_heart_rate()
{
  health_service_events_unsubscribe();
  health_service_set_heart_rate_sample_period(15);
}