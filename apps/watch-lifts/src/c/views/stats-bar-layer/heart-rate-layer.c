#include <pebble.h>

#include "heart-rate-layer.h"

struct HeartRateLayer
{
  Layer *root_layer;
  TextLayer *icon_text_layer;
  TextLayer *bpm_text_layer;
  // text_layer_set_text stores the pointer rather than copying the string,
  // so the buffer has to live as long as the TextLayer does. Sized for any
  // int ("-2147483648" + NUL) so snprintf can never truncate.
  char bpm_text[12];
};

static TextLayer *prv_text_layer_create(GRect frame, GTextAlignment alignment)
{
  TextLayer *text_layer = text_layer_create(frame);
  text_layer_set_background_color(text_layer, GColorRed);
  text_layer_set_text_color(text_layer, GColorWhite);
  text_layer_set_text_alignment(text_layer, alignment);
  text_layer_set_font(text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  return text_layer;
}

HeartRateLayer *heart_rate_layer_create(GRect frame)
{
  HeartRateLayer *heart_rate_layer = malloc(sizeof(HeartRateLayer));

  heart_rate_layer->root_layer = layer_create(frame);
  GRect bounds = layer_get_bounds(heart_rate_layer->root_layer);
  int icon_width = bounds.size.h; // square icon cell

  heart_rate_layer->icon_text_layer = prv_text_layer_create(
      GRect(0, 0, icon_width, bounds.size.h), GTextAlignmentCenter);
  text_layer_set_text(heart_rate_layer->icon_text_layer, "🖤");

  heart_rate_layer->bpm_text_layer = prv_text_layer_create(
      GRect(icon_width, 0, bounds.size.w - icon_width, bounds.size.h), GTextAlignmentLeft);

  layer_add_child(heart_rate_layer->root_layer, text_layer_get_layer(heart_rate_layer->icon_text_layer));
  layer_add_child(heart_rate_layer->root_layer, text_layer_get_layer(heart_rate_layer->bpm_text_layer));

  heart_rate_layer_set_bpm(heart_rate_layer, 0);
  return heart_rate_layer;
}

void heart_rate_layer_destroy(HeartRateLayer *heart_rate_layer)
{
  text_layer_destroy(heart_rate_layer->bpm_text_layer);
  text_layer_destroy(heart_rate_layer->icon_text_layer);
  layer_destroy(heart_rate_layer->root_layer);
  free(heart_rate_layer);
}

Layer *heart_rate_layer_get_layer(HeartRateLayer *heart_rate_layer)
{
  return heart_rate_layer->root_layer;
}

void heart_rate_layer_set_bpm(HeartRateLayer *heart_rate_layer, int bpm)
{
  if (bpm <= 0)
  {
    text_layer_set_text(heart_rate_layer->bpm_text_layer, "...");
    return;
  }
  snprintf(heart_rate_layer->bpm_text, sizeof(heart_rate_layer->bpm_text), "%d", bpm);
  text_layer_set_text(heart_rate_layer->bpm_text_layer, heart_rate_layer->bpm_text);
}

void heart_rate_layer_show_error(HeartRateLayer *heart_rate_layer)
{
  text_layer_set_text(heart_rate_layer->bpm_text_layer, "Error");
}
