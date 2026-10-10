// A host stand-in for the part of the Pebble SDK's pebble.h that state.c
// uses, so the host tests can build it: the standard headers pebble.h brings
// in, and declarations of the persist storage calls it makes, which
// state-driver.c defines over memory. state.test.ts puts this directory on
// the include path.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t status_t;

// What persist_get_size returns for a key never written.
#define E_DOES_NOT_EXIST (-9)

// Persist storage.
int persist_get_size(const uint32_t key);
int persist_read_data(const uint32_t key, void *buffer, const size_t buffer_size);
int persist_write_data(const uint32_t key, const void *data, const size_t size);
