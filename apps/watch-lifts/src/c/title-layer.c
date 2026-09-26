#include <pebble.h>

#include "title-layer.h"
#include "ui-constants.h"

static TextLayer *s_title_text_layer;

void title_layer_window_load(Window *window)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_title_text_layer = text_layer_create(
      GRect(0, 0, bounds.size.w, title_bar_height));
  text_layer_set_background_color(s_title_text_layer, GColorBlue);
  text_layer_set_text_color(s_title_text_layer, GColorWhite);
  text_layer_set_text_alignment(s_title_text_layer, GTextAlignmentCenter);
  text_layer_set_font(s_title_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));

  // Add it as a child layer to the Window's root layer
  layer_add_child(window_layer, text_layer_get_layer(s_title_text_layer));

  text_layer_set_text(s_title_text_layer, "Pick an Exercise");
}

void title_layer_window_unload(Window *window)
{
  tick_timer_service_unsubscribe();
  text_layer_destroy(s_title_text_layer);
}