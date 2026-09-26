#include <pebble.h>

#include "reps-layer.h"

struct RepsLayer
{
  Layer *root_layer;
};

RepsLayer *reps_layer_create(GRect frame)
{
  RepsLayer *reps_layer = malloc(sizeof(RepsLayer));
  reps_layer->root_layer = layer_create(frame);
  return reps_layer;
}

void reps_layer_destroy(RepsLayer *reps_layer)
{
  layer_destroy(reps_layer->root_layer);
  free(reps_layer);
}

Layer *reps_layer_get_layer(RepsLayer *reps_layer)
{
  return reps_layer->root_layer;
}
