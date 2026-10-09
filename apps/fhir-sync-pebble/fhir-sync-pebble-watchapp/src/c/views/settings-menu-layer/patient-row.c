#include "patient-row.h"
#include "../../menu-text.h"

void patient_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state) {
  const Connection *connection = &state->connection;
  char subtitle[PATIENT_SUBTITLE_SIZE];
  menu_text_format_patient_subtitle(subtitle, state->connected, connection->birth_date);
  menu_cell_basic_draw(
    ctx,
    cell_layer,
    menu_text_patient_title(state->connected, connection->patient_name),
    subtitle,
    NULL
  );
}
