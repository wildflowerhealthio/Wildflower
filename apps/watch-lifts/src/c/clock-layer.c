#include <pebble.h>

#include "clock-layer.h"
#include "ui-constants.h"

static TextLayer *s_clock_text_layer;

static void update_time()
{
  // Get a tm structure
  time_t temp = time(NULL);
  struct tm *tick_time = localtime(&temp);

  // Write the current hours and minutes into a buffer
  static char s_time_buffer[9];
  strftime(s_time_buffer, sizeof(s_time_buffer), clock_is_24h_style() ? "%H:%M" : "%I:%M %p", tick_time);

  // Display this time on the TextLayer
  text_layer_set_text(s_clock_text_layer, s_time_buffer);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed)
{
  update_time();
}

void clock_layer_window_load(Window *window)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  int half_width = bounds.size.w / 2;

  s_clock_text_layer = text_layer_create(
      GRect(half_width, bounds.size.h - stats_bar_height, half_width, stats_bar_height));
  text_layer_set_background_color(s_clock_text_layer, GColorBlue);
  text_layer_set_text_color(s_clock_text_layer, GColorWhite);
  text_layer_set_text_alignment(s_clock_text_layer, GTextAlignmentCenter);
  text_layer_set_font(s_clock_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));

  // Add it as a child layer to the Window's root layer
  layer_add_child(window_layer, text_layer_get_layer(s_clock_text_layer));

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

void clock_layer_window_unload(Window *window)
{
  tick_timer_service_unsubscribe();
  text_layer_destroy(s_clock_text_layer);
}