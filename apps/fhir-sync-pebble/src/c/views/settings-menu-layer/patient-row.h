#pragma once

#include <pebble.h>

#include "../../state.h"

// Draws the patient's name as the title and their birth date as the subtitle,
// or a prompt to open the settings when not connected.
void patient_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state);
