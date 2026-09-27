#include <pebble.h>

#include "reps-layer.h"
#include "reps-text.h"

struct RepsLayer
{
  Layer *root_layer;
  TextLayer *person_name_layer;
  TextLayer *weights_layer;
  // text_layer_set_text stores the pointer rather than copying the string,
  // so each RepsLayer needs its own buffers that live as long as it does.
  char weights_text[WEIGHT_TEXT_SIZE];
  char reps_text[REPS_TEXT_SIZE];
  TextLayer *reps_layer;
};

RepsLayer *reps_layer_create(GRect frame)
{
  RepsLayer *reps_layer = malloc(sizeof(RepsLayer));
  reps_layer->root_layer = layer_create(frame);

  GRect name_bounds = layer_get_bounds(reps_layer->root_layer);
  int padding = 10;
  int name_height = 28;
  name_bounds.origin.x += padding;
  name_bounds.origin.y += padding;
  name_bounds.size.h = name_height;

  reps_layer->person_name_layer = text_layer_create(name_bounds);
  text_layer_set_background_color(reps_layer->person_name_layer, GColorClear);
  text_layer_set_text_color(reps_layer->person_name_layer, GColorBlack);
  text_layer_set_text_alignment(reps_layer->person_name_layer, GTextAlignmentLeft);
  text_layer_set_font(reps_layer->person_name_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28));

  layer_add_child(reps_layer->root_layer, text_layer_get_layer(reps_layer->person_name_layer));

  int weights_height = 24;
  GRect weights_bounds = layer_get_bounds(reps_layer->root_layer);
  weights_bounds.origin.x += padding;
  weights_bounds.origin.y = weights_bounds.origin.y + weights_bounds.size.h - (weights_height + padding);
  weights_bounds.size.h = weights_height;

  reps_layer->weights_layer = text_layer_create(weights_bounds);
  text_layer_set_background_color(reps_layer->weights_layer, GColorClear);
  text_layer_set_text_color(reps_layer->weights_layer, GColorBlack);
  text_layer_set_text_alignment(reps_layer->weights_layer, GTextAlignmentLeft);
  text_layer_set_font(reps_layer->weights_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  layer_add_child(reps_layer->root_layer, text_layer_get_layer(reps_layer->weights_layer));

  GRect reps_bounds = layer_get_bounds(reps_layer->root_layer);
  reps_bounds.origin.x += reps_bounds.size.w * 1 / 4;
  reps_bounds.size.w = reps_bounds.size.w * 3 / 4 - padding;
  reps_bounds.origin.y += padding;
  reps_layer->reps_layer = text_layer_create(reps_bounds);
  text_layer_set_background_color(reps_layer->reps_layer, GColorClear);
  text_layer_set_text_color(reps_layer->reps_layer, GColorBlack);
  text_layer_set_text_alignment(reps_layer->reps_layer, GTextAlignmentRight);
  text_layer_set_font(reps_layer->reps_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(reps_layer->root_layer, text_layer_get_layer(reps_layer->reps_layer));

  reps_layer->reps_text[0] = '\0';
  text_layer_set_text(reps_layer->reps_layer, reps_layer->reps_text);

  return reps_layer;
}

void reps_layer_set_person_name(RepsLayer *reps_layer, const char *name)
{
  text_layer_set_text(reps_layer->person_name_layer, name);
}

void reps_layer_set_weight(RepsLayer *reps_layer, int weight)
{
  reps_text_format_weight(reps_layer->weights_text, weight);
  text_layer_set_text(reps_layer->weights_layer, reps_layer->weights_text);
}

void reps_layer_set_reps(RepsLayer *reps_layer, const int reps[MAX_SETS], int set_count)
{
  reps_text_format_reps(reps_layer->reps_text, reps, set_count);
  text_layer_set_text(reps_layer->reps_layer, reps_layer->reps_text);
}

void reps_layer_destroy(RepsLayer *reps_layer)
{
  text_layer_destroy(reps_layer->person_name_layer);
  text_layer_destroy(reps_layer->weights_layer);
  text_layer_destroy(reps_layer->reps_layer);
  layer_destroy(reps_layer->root_layer);
  free(reps_layer);
}

Layer *reps_layer_get_layer(RepsLayer *reps_layer)
{
  return reps_layer->root_layer;
}
