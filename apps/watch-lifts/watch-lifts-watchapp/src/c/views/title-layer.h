#pragma once

#include <pebble.h>

typedef struct TitleLayer TitleLayer;

// text_layer_set_text stores the pointer rather than copying the string, so
// title_text must outlive the TitleLayer (string literals and s_exercises do).
TitleLayer *title_layer_create(GRect frame, const char *title_text);
void title_layer_destroy(TitleLayer *title_layer);
Layer *title_layer_get_layer(TitleLayer *title_layer);
void title_layer_update_title(TitleLayer *title_layer, const char *title_text);
