#include "local-time.h"

const struct tm *local_time_or_null(const time_t *time) {
  return *time == 0 ? NULL : localtime(time);
}
