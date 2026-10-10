#pragma once

#include <pebble.h>

#include "../../state.h"

// Draws the Sync Now button, greyed out unless it can start a sync.
void sync_now_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state);
