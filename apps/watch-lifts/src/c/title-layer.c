#include <pebble.h>

#include "title-layer.h"
#include "ui-constants.h"
#include "state.h"

static TextLayer *s_title_text_layer;

void title_layer_window_load(Window *window, int exercise_index)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_title_text_layer = text_layer_create(
      GRect(0, 0, bounds.size.w, title_bar_height));
  text_layer_set_background_color(s_title_text_layer, GColorChromeYellow);
  text_layer_set_text_color(s_title_text_layer, GColorBlack);
  text_layer_set_text_alignment(s_title_text_layer, GTextAlignmentCenter);
  text_layer_set_font(s_title_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));

  render_title_layer(exercise_index);

  // Add it as a child layer to the Window's root layer
  layer_add_child(window_layer, text_layer_get_layer(s_title_text_layer));
}

void render_title_layer(int exercise_index)
{
  int num_exercises = sizeof(s_exercises) / sizeof(s_exercises[0]);
  if (s_editing_set_index < 0 || s_editing_set_index >= num_exercises)
  {
    text_layer_set_text(s_title_text_layer, "Pick an Exercise");
  }
  else
  {
    text_layer_set_text(s_title_text_layer, s_exercises[exercise_index]);
  }
}

void title_layer_window_unload(Window *window)
{
  tick_timer_service_unsubscribe();
  text_layer_destroy(s_title_text_layer);
}