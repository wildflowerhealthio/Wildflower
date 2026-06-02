import * as SplashScreen from 'expo-splash-screen'

// Side-effect import. Block the splash from auto-hiding before the
// embedded SPA's bridge has flushed its first `RouteChanged`. Must
// run *before* `expo-router/entry`'s `registerRootComponent` (which
// schedules the first mount that would otherwise trigger auto-hide).
void SplashScreen.preventAutoHideAsync()
setTimeout(() => {
  void SplashScreen.hideAsync().catch((cause) => {
    // Log, but don't crash if the splash screen API fails — the app
    // can still function, just with a janky flash. Surface at `error`:
    // hitting this branch means `UIReady` never arrived within 10s,
    // which is a stuck-startup signal worth telemetry attention.
    // oxlint-disable-next-line no-console -- intentional last-resort telemetry from a side-effect import
    console.error('SplashScreen.hideAsync (10s fallback) failed', cause)
  })
}, 10_000)
