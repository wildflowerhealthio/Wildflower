#include <pebble.h>

static TextLayer *s_exercise_title_layer;

static char *s_exercises[] = {
    "Squat",
    "Bench Press",
    "Bent Over Row",
    "Overhead Press",
    "Deadlift"};

static int s_exercise_count = sizeof(s_exercises) / sizeof(s_exercises[0]);

static int s_exercise_index = 0;

static bool s_exercise_title_focused = false;

static void refresh_exercise_title()
{
  if (!s_exercise_title_focused)
  {
    text_layer_set_background_color(s_exercise_title_layer, GColorVividCerulean);
  }
  else
  {
    text_layer_set_background_color(s_exercise_title_layer, GColorClear);
  }

  text_layer_set_text(s_exercise_title_layer, s_exercises[s_exercise_index]);
}

static void next_exercise()
{
  s_exercise_index = (s_exercise_index + 1) % s_exercise_count;
  refresh_exercise_title();
}

static void on_exercise_title_focus()
{
  s_exercise_title_focused = true;
  refresh_exercise_title();
}

static void on_exercise_title_blur()
{
  s_exercise_title_focused = false;
  refresh_exercise_title();
}

static void exercise_title_window_load(Window *window)
{
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_exercise_title_layer = text_layer_create(GRect(0, 0, bounds.size.w, 40));
  text_layer_set_text_alignment(s_exercise_title_layer, GTextAlignmentLeft);
  text_layer_set_font(s_exercise_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  layer_add_child(window_layer, text_layer_get_layer(s_exercise_title_layer));
  refresh_exercise_title();
}

static void enter_top()
{
}

static void enter_bottom()
{
}