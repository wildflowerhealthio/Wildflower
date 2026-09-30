#include <pebble.h>

#include "exercise-list-layer.h"
#include "../../state.h"

struct ExerciseListLayer {
  MenuLayer *menu_layer;
  ExerciseSelectedHandler on_exercise_selected;
};

static uint16_t get_num_rows_callback(
  MenuLayer *menu_layer,
  uint16_t section_index,
  void *context
) {
  int num_exercises = sizeof(s_exercises) / sizeof(s_exercises[0]);
  const uint16_t num_rows = num_exercises;
  return num_rows;
}

static void draw_row_callback(
  GContext *ctx,
  const Layer *cell_layer,
  MenuIndex *cell_index,
  void *context
) {

  int exercise_index = cell_index->row;

  char label[100];

  snprintf(
    label,
    sizeof(label),
    "%s: %i lbs / %s: %i lbs",
    s_people_names[0],
    s_weights[0][exercise_index],
    s_people_names[1],
    s_weights[1][exercise_index]
  );

  char *exercise_title = s_exercises[exercise_index];

  menu_cell_basic_draw(ctx, cell_layer, exercise_title, label, NULL);
}

static int16_t get_cell_height_callback(
  struct MenuLayer *menu_layer,
  MenuIndex *cell_index,
  void *context
) {
  return 50;
}

static void select_callback(struct MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  ExerciseListLayer *exercise_list_layer = context;
  exercise_list_layer->on_exercise_selected(cell_index->row);
}

ExerciseListLayer *exercise_list_layer_create(
  GRect frame,
  Window *click_window,
  ExerciseSelectedHandler on_exercise_selected
) {
  ExerciseListLayer *exercise_list_layer = malloc(sizeof(ExerciseListLayer));
  exercise_list_layer->on_exercise_selected = on_exercise_selected;
  exercise_list_layer->menu_layer = menu_layer_create(frame);

  menu_layer_set_click_config_onto_window(exercise_list_layer->menu_layer, click_window);
  menu_layer_set_callbacks(
    exercise_list_layer->menu_layer,
    exercise_list_layer,
    (MenuLayerCallbacks){
      .get_num_rows = get_num_rows_callback,
      .draw_row = draw_row_callback,
      .get_cell_height = get_cell_height_callback,
      .select_click = select_callback,
    }
  );
  menu_layer_pad_bottom_enable(exercise_list_layer->menu_layer, true);

  return exercise_list_layer;
}

void exercise_list_layer_reload(ExerciseListLayer *exercise_list_layer) {
  menu_layer_reload_data(exercise_list_layer->menu_layer);
}

void exercise_list_layer_destroy(ExerciseListLayer *exercise_list_layer) {
  menu_layer_destroy(exercise_list_layer->menu_layer);
  free(exercise_list_layer);
}

Layer *exercise_list_layer_get_layer(ExerciseListLayer *exercise_list_layer) {
  return menu_layer_get_layer(exercise_list_layer->menu_layer);
}
