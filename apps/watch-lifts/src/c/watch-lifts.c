#include <pebble.h>

#include "clock-layer.h"
#include "heart-rate-layer.h"
#include "exercise-list.h"
#include "title-layer.h"

static Window *s_window;

static void prv_select_click_handler(ClickRecognizerRef recognizer, void *context)
{
}

static void prv_up_click_handler(ClickRecognizerRef recognizer, void *context)
{
}

static void prv_down_click_handler(ClickRecognizerRef recognizer, void *context)
{
}

static void prv_click_config_provider(void *context)
{
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_select_click_handler);
  window_single_click_subscribe(BUTTON_ID_UP, prv_up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_down_click_handler);
}

static void prv_window_load(Window *window)
{
  title_layer_window_load(window);
  exercise_list_window_load(window);
  clock_layer_window_load(window);
  heart_rate_layer_window_load(window);
}

static void prv_window_unload(Window *window)
{
  title_layer_window_unload(window);
  clock_layer_window_unload(window);
  heart_rate_layer_window_unload(window);
  exercise_list_window_unload(window);
}

static void prv_init(void)
{
  s_window = window_create();
  window_set_click_config_provider(s_window, prv_click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers){
                                           .load = prv_window_load,
                                           .unload = prv_window_unload,
                                       });
  const bool animated = true;
  window_stack_push(s_window, animated);
}

static void prv_deinit(void)
{
  window_destroy(s_window);
}

int main(void)
{
  prv_init();

  APP_LOG(APP_LOG_LEVEL_DEBUG, "Done initializing, pushed window: %p", s_window);

  app_event_loop();
  prv_deinit();
}
