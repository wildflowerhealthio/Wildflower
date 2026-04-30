# expo-effect-platform-example

Manual test harness for [`expo-effect-platform`](../). Builds a dev client that runs an Effect `HttpServer` on-device and lets you exercise it from the UI.

## Run

```sh
pnpm start            # Metro + dev client launcher
```

Then press `a` for Android, `i` for iOS.

## Why `NODE_OPTIONS=--dns-result-order=ipv4first` in every script

On macOS, `getaddrinfo("localhost")` returns `::1` (IPv6 loopback) before `127.0.0.1`. Node binds servers to the first resolved address only, so `expo start --localhost` ends up with Metro listening on `[::1]:8081`. The Android emulator's `adb reverse` forwards traffic via IPv4 — it can't reach IPv6-only Metro and the dev client crashes with `Unable to load script` before any JS runs.

`--dns-result-order=ipv4first` flips Node's DNS preference so Metro binds to `127.0.0.1`. iOS Simulator works either way (it shares the host's network stack), but the flag is harmless there and keeps the scripts symmetric.
