#pragma once

#include <pebble.h>

#include "../../data-type.h"
#include "../../state.h"

// Draws data_type's title, its last sync and a checkbox showing whether it
// syncs.
void data_type_row_draw(
  GContext *ctx,
  const Layer *cell_layer,
  const AppState *state,
  DataType data_type
);
