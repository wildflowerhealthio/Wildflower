#include <pebble.h>

#include "clock-layer.h"

struct ClockLayer {
  Layer *root_layer;
  TextLayer *text_layer;
  // text_layer_set_text stores the pointer rather than copying the string,
  // so the buffer has to live as long as the TextLayer does. Sized for
  // "12:34 PM" + NUL.
  char time_text[9];
};

ClockLayer *clock_layer_create(GRect frame) {
  ClockLayer *clock_layer = malloc(sizeof(ClockLayer));

  clock_layer->root_layer = layer_create(frame);
  GRect bounds = layer_get_bounds(clock_layer->root_layer);

  clock_layer->text_layer = text_layer_create(bounds);
  text_layer_set_background_color(clock_layer->text_layer, GColorBlue);
  text_layer_set_text_color(clock_layer->text_layer, GColorWhite);
  text_layer_set_text_alignment(clock_layer->text_layer, GTextAlignmentCenter);
  text_layer_set_font(clock_layer->text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(clock_layer->root_layer, text_layer_get_layer(clock_layer->text_layer));

  clock_layer_update_time(clock_layer);
  return clock_layer;
}

void clock_layer_destroy(ClockLayer *clock_layer) {
  text_layer_destroy(clock_layer->text_layer);
  layer_destroy(clock_layer->root_layer);
  free(clock_layer);
}

Layer *clock_layer_get_layer(ClockLayer *clock_layer) {
  return clock_layer->root_layer;
}

void clock_layer_update_time(ClockLayer *clock_layer) {
  time_t now = time(NULL);
  strftime(
    clock_layer->time_text,
    sizeof(clock_layer->time_text),
    clock_is_24h_style() ? "%H:%M" : "%I:%M %p",
    localtime(&now)
  );
  text_layer_set_text(clock_layer->text_layer, clock_layer->time_text);
}
