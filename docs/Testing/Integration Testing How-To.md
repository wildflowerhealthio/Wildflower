# Integration Testing How-To

VCR-style record/playback testing for infrastructure code that calls external HTTP APIs. Uses `@assessmentis/vcr-js` (MSW + Talkback) to capture real HTTP interactions and replay them deterministically.

```plaintext
Your Code → MSW Intercept → Talkback → Real API (record) or Tape File (playback)
```

## 1. Vitest Configuration

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/test-config.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    maxWorkers: 1, // Sequential to avoid tape conflicts
  },
})
```

## 2. Test Config Setup

Create `test/helpers/test-config.ts`:

```typescript
import { http, HttpResponse } from 'msw'
import { beforeAll, afterAll, afterEach } from 'vite-plus/test'
import { setupServer } from 'msw/node'
import { setupInterceptServer } from '@assessmentis/vcr-js'

const mockHandlers = [
  http.get('http://metadata.google.internal/*', () => {
    return HttpResponse.json({ access_token: 'mock-token' })
  }),
]

const mswServer = await setupInterceptServer({
  mswSetup: setupServer,
  tapePath: __dirname + '/../tapes/',
  handlers: mockHandlers,
  hosts: [
    {
      name: 'Google Healthcare API',
      host: 'https://healthcare.googleapis.com',
      urlSubstitutions: [
        [/\/v1\/projects\/.*\/fhir/, 'FHIR'],
        [/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid'],
      ],
    },
  ],
})

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => mswServer.resetHandlers())
afterAll(() => mswServer.close())
```

### URL Substitutions

| Pattern              | Purpose                              |
| -------------------- | ------------------------------------ |
| UUID regex → `:uuid` | Same tape works for any generated ID |
| Long paths → `FHIR`  | Shorter, readable tape filenames     |
| Timestamps → `:ts`   | Normalize time-based parameters      |

## 3. Write Tests

Tests look like normal Vitest tests — the VCR layer is transparent:

```typescript
describe('Patient', () => {
  const tracker = createTracker()

  afterEach(async () => {
    if (tracker.count > 0) {
      await Effect.runPromise(tracker.cleanup().pipe(Effect.provide(LiveTestLayer)))
    }
  })

  it('should create a patient and return with generated ID', async () => {
    const program = Effect.gen(function* () {
      const client = yield* FhirR4Client
      return yield* client.create({
        type: 'Patient',
        resource: { resourceType: 'Patient', name: [{ given: ['Test'] }] },
      })
    }).pipe(Effect.provide(LiveTestLayer))

    const exit = await Effect.runPromiseExit(program)

    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.resourceType).toBe('Patient')
      tracker.track('Patient', exit.value.id)
    }
  })
})
```

## 4. Record Tapes

```bash
RECORD=true npm run test
```

Prerequisites: valid credentials (`gcloud auth login`), environment variables set, test environment accessible.

Tape files are saved as JSON5 organized by test name:

```plaintext
test/tapes/
└── Patient/
    └── create/
        └── should create a patient.../
            └── Google Healthcare API/
                ├── POST__FHIR__Patient__2026-01-28T22:39:50.json5
                └── DELETE__FHIR__Patient__:uuid__2026-01-28T22:39:51.json5
```

## Best Practices

- **Assert structure, not content**: Check `resourceType === 'Patient'` rather than `name === 'John'`
- **Track resources for cleanup**: Delete created resources after each test (especially in record mode)
- **Commit tapes**: CI runs in playback mode
- **Re-record when APIs change**: Delete old tapes and re-record
- **Use substitutions liberally**: Any dynamic value should have a substitution pattern
- **Run sequentially**: `maxWorkers: 1` to prevent tape conflicts

## When to Use Integration vs Unit Tests

| Integration Tests                              | Unit Tests           |
| ---------------------------------------------- | -------------------- |
| Infrastructure packages calling external APIs  | Pure domain logic    |
| Verifying HTTP request construction            | Schema validation    |
| Testing error handling from real API responses | Business rules       |
| OAuth/auth flows                               | Data transformations |

## See Also

- [Unit Testing How-To](./Unit%20Testing%20How-To.md)
- [React Testing Reference](./React%20Testing%20Reference.md)
