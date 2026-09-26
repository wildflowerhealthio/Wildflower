#include <pebble.h>

#include "select-exercise-window.h"
#include "select-exercise-window/exercise-list-layer.h"
#include "exercise-detail-window.h"
#include "../ui-constants.h"
#include "../views/title-layer.h"
#include "../views/stats-bar-layer.h"

typedef struct SelectExerciseWindow
{
  TitleLayer *title_layer;
  ExerciseListLayer *exercise_list_layer;
  StatsBarLayer *stats_bar_layer;
} SelectExerciseWindow;

// Window handlers receive only the Window, and its user data is reserved for
// the StatsBarLayer, so the single instance is reached through this static.
static SelectExerciseWindow *s_select_exercise_window;

static void prv_on_exercise_selected(int exercise_index)
{
  exercise_detail_window_push(exercise_index);
}

static void prv_window_load(Window *window)
{
  Layer *root_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root_layer);

  s_select_exercise_window->title_layer = title_layer_create(
      GRect(0, 0, bounds.size.w, title_bar_height), "Pick an Exercise");
  layer_add_child(root_layer, title_layer_get_layer(s_select_exercise_window->title_layer));

  s_select_exercise_window->exercise_list_layer = exercise_list_layer_create(
      GRect(0, title_bar_height, bounds.size.w, bounds.size.h - (title_bar_height + stats_bar_height)),
      window, prv_on_exercise_selected);
  layer_add_child(root_layer, exercise_list_layer_get_layer(s_select_exercise_window->exercise_list_layer));

  s_select_exercise_window->stats_bar_layer = stats_bar_layer_create(
      GRect(0, bounds.size.h - stats_bar_height, bounds.size.w, stats_bar_height));
  layer_add_child(root_layer, stats_bar_layer_get_layer(s_select_exercise_window->stats_bar_layer));
  window_set_user_data(window, s_select_exercise_window->stats_bar_layer);
}

static void prv_window_appear(Window *window)
{
  stats_bar_layer_refresh(s_select_exercise_window->stats_bar_layer);
}

static void prv_window_unload(Window *window)
{
  stats_bar_layer_destroy(s_select_exercise_window->stats_bar_layer);
  exercise_list_layer_destroy(s_select_exercise_window->exercise_list_layer);
  title_layer_destroy(s_select_exercise_window->title_layer);
  free(s_select_exercise_window);
  s_select_exercise_window = NULL;
  window_destroy(window);
}

void select_exercise_window_push(void)
{
  s_select_exercise_window = malloc(sizeof(SelectExerciseWindow));
  Window *window = window_create();
  window_set_window_handlers(window, (WindowHandlers){
                                         .load = prv_window_load,
                                         .appear = prv_window_appear,
                                         .unload = prv_window_unload,
                                     });
  window_stack_push(window, true);
}
