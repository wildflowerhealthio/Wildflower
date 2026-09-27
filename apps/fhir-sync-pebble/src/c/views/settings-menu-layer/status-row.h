#pragma once

#include <pebble.h>

#include "../../state.h"

// Draws the last sync as the title and the last sign-in as the subtitle.
void status_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state);
