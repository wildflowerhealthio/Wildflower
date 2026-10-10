#pragma once

#include <pebble.h>

// time in the watch's time zone, or NULL when it is 0 ("never"). The result
// is localtime's shared buffer: format it before the next call.
const struct tm *local_time_or_null(const time_t *time);
