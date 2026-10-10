#include <pebble.h>

#include "title-layer.h"

struct TitleLayer {
  Layer *root_layer;
  TextLayer *title_text_layer;
};

TitleLayer *title_layer_create(GRect frame, const char *title_text) {
  TitleLayer *title_layer = malloc(sizeof(TitleLayer));

  title_layer->root_layer = layer_create(frame);
  GRect bounds = layer_get_bounds(title_layer->root_layer);

  title_layer->title_text_layer = text_layer_create(bounds);
  text_layer_set_background_color(title_layer->title_text_layer, GColorChromeYellow);
  text_layer_set_text_color(title_layer->title_text_layer, GColorBlack);
  text_layer_set_text_alignment(title_layer->title_text_layer, GTextAlignmentCenter);
  text_layer_set_font(
    title_layer->title_text_layer,
    fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD)
  );
  layer_add_child(title_layer->root_layer, text_layer_get_layer(title_layer->title_text_layer));

  title_layer_update_title(title_layer, title_text);
  return title_layer;
}

void title_layer_destroy(TitleLayer *title_layer) {
  text_layer_destroy(title_layer->title_text_layer);
  layer_destroy(title_layer->root_layer);
  free(title_layer);
}

Layer *title_layer_get_layer(TitleLayer *title_layer) {
  return title_layer->root_layer;
}

void title_layer_update_title(TitleLayer *title_layer, const char *title_text) {
  text_layer_set_text(title_layer->title_text_layer, title_text);
}
