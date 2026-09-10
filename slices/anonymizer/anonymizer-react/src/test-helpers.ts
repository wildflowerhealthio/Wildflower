import { Effect, Schema } from 'effect'

import { emitHar, HarFromJson } from 'http-archive'
import { CAPTURE_FLOOR, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

/** A HAR shaped like a real capture — what matters is only that it parses. */
const RECOGNIZED_HAR: string = Effect.runSync(
  Schema.encode(HarFromJson)(
    emitHar(
      [
        traceExchange({
          requestId: 'req-0',
          url: 'https://r4.example.org/baseR4/Patient/pat-7?_format=json',
          headers: [['content-type', 'application/fhir+json']],
          body: {
            _tag: 'StoredBody',
            contentType: 'application/fhir+json',
            data: jsonBody({ resourceType: 'Patient', id: 'pat-7' }),
            size: 42,
            hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
          },
          startedAtMillis: CAPTURE_FLOOR,
        }),
      ],
      { sessionId: 'test-session' }
    )
  )
)

export { RECOGNIZED_HAR }
