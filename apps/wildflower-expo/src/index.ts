import './side-effect-imports/polyfill.ts'
// Telemetry init must run before `livestore-store.ts` evaluates so
// `getLivestoreOtelOptions` captures a real tracer (not the no-op
// fallback) in the options snapshot used by the module-scope retain.
import './side-effect-imports/setup-instrumentation.ts'
import './side-effect-imports/prevent-splash-hide.ts'
// Triggers the module-scope `wildflowerStoreRegistry.retain(...)` —
// kicks off `makeAdapter` (~946 ms cold) at module-eval so it overlaps
// bundle eval / RN bridge warmup / splash display rather than landing
// inside the Suspense window in `AppRuntimeProvider`.
import './livestore/livestore-store.ts'
import 'expo-router/entry'
