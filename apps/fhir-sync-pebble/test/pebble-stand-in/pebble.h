// A host stand-in for the part of the Pebble SDK's pebble.h that state.c uses,
// so state-driver.c can build it with the host compiler: the standard headers
// pebble.h brings in, and persist storage, which state-driver.c keeps in
// memory. state.test.ts puts this directory on the include path.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

typedef int32_t status_t;

bool persist_exists(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
status_t persist_write_int(const uint32_t key, const int32_t value);
int persist_read_string(const uint32_t key, char *buffer, const size_t buffer_size);
int persist_write_string(const uint32_t key, const char *cstring);
