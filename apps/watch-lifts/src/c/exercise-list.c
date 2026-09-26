#include <pebble.h>

#include "exercise-list.h"
#include "ui-constants.h"

static MenuLayer *s_menu_layer;

static char *s_exercises[5] = {
    "Squat",
    "Bench Press",
    "Bent Over Row",
    "Overhead Press",
    "Deadlift"};

// static int s_sets[5] = {5, 5, 5, 5, 1};

static int s_weights[2][5] = {
    {60, 50, 50, 50, 85},
    {65, 55, 55, 45, 85}};

static char *s_people_names[] = {"Ruth", "Chloe"};

// static int s_editing_set_index = -1;

/// /////////

static uint16_t get_num_rows_callback(MenuLayer *menu_layer,
                                      uint16_t section_index, void *context)
{
  int num_exercises = sizeof(s_exercises) / sizeof(s_exercises[0]);
  const uint16_t num_rows = num_exercises;
  return num_rows;
}

static void draw_row_callback(GContext *ctx, const Layer *cell_layer,
                              MenuIndex *cell_index, void *context)
{

  int exercise_index = cell_index->row;

  char label[100];

  snprintf(
      label,
      sizeof(label),
      "%s: %i lbs / %s: %i lbs",
      s_people_names[0],
      s_weights[0][exercise_index],
      s_people_names[1],
      s_weights[1][exercise_index]);

  char *exercise_title = s_exercises[exercise_index];

  menu_cell_basic_draw(ctx, cell_layer, exercise_title, label, NULL);
}

static int16_t get_cell_height_callback(struct MenuLayer *menu_layer,
                                        MenuIndex *cell_index, void *context)
{
  return 50;
}

static void select_callback(struct MenuLayer *menu_layer,
                            MenuIndex *cell_index, void *context)
{

  menu_layer_reload_data(s_menu_layer);
}

static void long_select_callback(struct MenuLayer *menu_layer,
                                 MenuIndex *cell_index, void *context)
{
  menu_layer_reload_data(s_menu_layer);
}

/////

void exercise_list_window_load(Window *window)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  bounds.size.h -= (title_bar_height + stats_bar_height); // Adjust the height to make room for padding
  bounds.origin.y = title_bar_height;
  // Create the MenuLayer
  s_menu_layer = menu_layer_create(bounds);

  // Let it receive click events
  menu_layer_set_click_config_onto_window(s_menu_layer, window);

  // Set the callbacks for behavior and rendering
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
                                                   .get_num_rows = get_num_rows_callback,
                                                   .draw_row = draw_row_callback,
                                                   .get_cell_height = get_cell_height_callback,
                                                   .select_click = select_callback,
                                                   .select_long_click = long_select_callback,

                                               });

  menu_layer_pad_bottom_enable(s_menu_layer, true);
  // Add to the Window
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
}

void exercise_list_window_unload(Window *window)
{
  menu_layer_destroy(s_menu_layer);
}
