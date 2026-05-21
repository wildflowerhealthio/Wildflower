// Side-effect import from the top of `index.ts`; filename matches the Sentry SDK convention.
// Eagerly registers the OTEL provider so `whenOtelProviderReady()` resolves —
// without this, `injectActiveOtelContextWhenReady` (wrapping `createStore`)
// blocks forever and the bootstrap hangs at step 1.
import { initReactNativeTelemetryFromEnv } from 'telemetry-react-native'
import { SERVICE_NAME } from '../constants.ts'

initReactNativeTelemetryFromEnv({ otel: { serviceName: SERVICE_NAME } })
