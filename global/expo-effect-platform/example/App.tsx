import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import { ExpoHttpServer, ExpoContext } from 'expo-effect-platform'
import NativeModule from 'expo-effect-platform/build/ExpoEffectPlatformModule'
import { useState } from 'react'
import { SafeAreaView, ScrollView, Text, View, Button, StyleSheet } from 'react-native'

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = HttpRouter.empty.pipe(
  HttpRouter.get('/', HttpServerResponse.text('Hello from Effect on Expo!')),
  HttpRouter.get('/json', HttpServerResponse.unsafeJson({ status: 'ok', framework: 'effect' })),

  // Echoes body back — works for both text and JSON POST
  HttpRouter.post(
    '/echo',
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const body = yield* req.text
      return yield* HttpServerResponse.text(body)
    })
  ),

  // Returns request headers + query params in one response
  HttpRouter.get(
    '/inspect',
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(req.url, 'http://localhost')
      return yield* HttpServerResponse.unsafeJson({
        headers: req.headers,
        query: Object.fromEntries(url.searchParams.entries()),
      })
    })
  ),

  // Custom status code + custom response headers in one endpoint
  HttpRouter.get(
    '/fancy',
    HttpServerResponse.text('created', {
      status: 201,
      headers: { 'x-custom': 'hello', 'x-server': 'expo-effect' } as any,
    })
  ),

  // Sleeps longer than handlerTimeoutSeconds
  HttpRouter.get(
    '/slow',
    Effect.gen(function* () {
      yield* Effect.sleep('10 seconds')
      return yield* HttpServerResponse.text('too late')
    })
  )
)

// ---------------------------------------------------------------------------
// Server (2s handler timeout for /slow test)
// ---------------------------------------------------------------------------

const ServerLive = ExpoHttpServer.layer({
  port: 8080,
  hostname: '127.0.0.1',
  handlerTimeoutSeconds: 2,
}).pipe(Layer.provide(ExpoContext.layer))

const program = router.pipe(HttpServer.serve(), Layer.provide(ServerLive), Layer.launch)

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; pass: boolean; detail: string }
type Test = { name: string; run: () => Promise<TestResult> }

const BASE = 'http://127.0.0.1:8080'

const t = (name: string, fn: () => Promise<{ pass: boolean; detail: string }>): Test => ({
  name,
  run: async () => ({ name, ...(await fn()) }),
})

const tests: Test[] = [
  t('GET / — text response', async () => {
    const res = await fetch(`${BASE}/`)
    const text = await res.text()
    return { pass: res.ok && text === 'Hello from Effect on Expo!', detail: text }
  }),

  t('GET /json — JSON response', async () => {
    const res = await fetch(`${BASE}/json`)
    const json = await res.json()
    const pass = res.ok && json.status === 'ok' && json.framework === 'effect'
    return { pass, detail: JSON.stringify(json) }
  }),

  t('POST /echo — text body round-trip', async () => {
    const sent = 'ping from test'
    const res = await fetch(`${BASE}/echo`, { method: 'POST', body: sent })
    const text = await res.text()
    return { pass: res.ok && text === sent, detail: text }
  }),

  t('POST /echo — JSON body round-trip', async () => {
    const payload = { hello: 'world', n: 42 }
    const res = await fetch(`${BASE}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = JSON.parse(await res.text())
    const pass = res.ok && json.hello === 'world' && json.n === 42
    return { pass, detail: JSON.stringify(json) }
  }),

  t('GET /inspect — request headers', async () => {
    const res = await fetch(`${BASE}/inspect`, { headers: { 'x-test': 'abc123' } })
    const json = await res.json()
    return {
      pass: res.ok && json.headers['x-test'] === 'abc123',
      detail: `x-test=${json.headers['x-test']}`,
    }
  }),

  t('GET /inspect?a=1&b=2 — query params', async () => {
    const res = await fetch(`${BASE}/inspect?a=1&b=2`)
    const json = await res.json()
    const pass = res.ok && json.query.a === '1' && json.query.b === '2'
    return { pass, detail: JSON.stringify(json.query) }
  }),

  t('GET /fancy — status 201 + custom headers', async () => {
    const res = await fetch(`${BASE}/fancy`)
    const xCustom = res.headers.get('x-custom')
    const xServer = res.headers.get('x-server')
    const pass = res.status === 201 && xCustom === 'hello' && xServer === 'expo-effect'
    return { pass, detail: `status=${res.status} x-custom="${xCustom}" x-server="${xServer}"` }
  }),

  t('GET /nonexistent — 404', async () => {
    const res = await fetch(`${BASE}/nonexistent`)
    return { pass: res.status === 404, detail: `status=${res.status}` }
  }),

  t('GET /slow — handler timeout', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`${BASE}/slow`, { signal: controller.signal })
      clearTimeout(timer)
      // Server should respond with an error status before the handler completes
      const pass = res.status >= 400
      return { pass, detail: `status=${res.status} (expected timeout error)` }
    } catch (err: any) {
      clearTimeout(timer)
      // Connection dropped by server counts as a pass too
      const isAbort = err.name === 'AbortError'
      return {
        pass: !isAbort,
        detail: isAbort
          ? 'client timeout (server never responded)'
          : `server dropped: ${err.message}`,
      }
    }
  }),

  t('Hostname bind — loopback reachable', async () => {
    const res = await fetch('http://127.0.0.1:8080/')
    const text = await res.text()
    return { pass: res.ok, detail: `status=${res.status} body="${text}"` }
  }),

  t('Hostname bind — LAN IP unreachable', async () => {
    const interfaces = NativeModule.getNetworkInterfaces()
    const lanIp = interfaces['en0'] ?? interfaces['wlan0']
    if (!lanIp || lanIp === '127.0.0.1') {
      return { pass: true, detail: 'skipped — no LAN interface available' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch(`http://${lanIp}:8080/`, { signal: controller.signal })
      clearTimeout(timer)
      // If we got a response, the server is reachable on LAN — that's a failure
      return { pass: false, detail: `unexpected status=${res.status} on ${lanIp}` }
    } catch (err: any) {
      clearTimeout(timer)
      // Connection refused or timeout means the hostname binding worked
      return { pass: true, detail: `${lanIp} refused: ${err.message}` }
    }
  }),
]

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [status, setStatus] = useState('Stopped')
  const [address, setAddress] = useState('')
  const [results, setResults] = useState<TestResult[]>([])
  const [testing, setTesting] = useState(false)

  const startServer = () => {
    setStatus('Starting...')
    setAddress('http://127.0.0.1:8080')

    Effect.runFork(Effect.tap(program, () => Effect.sync(() => setStatus('Running'))))
    setStatus('Running')
  }

  const runTests = async () => {
    setTesting(true)
    setResults([])
    const out: TestResult[] = []
    for (const test of tests) {
      try {
        out.push(await test.run())
      } catch (err: any) {
        out.push({ name: test.name, pass: false, detail: err.message ?? String(err) })
      }
      setResults([...out])
    }
    setTesting(false)
  }

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length

  return (
    <SafeAreaView style={s.container}>
      <ScrollView style={s.container}>
        <Text style={s.header}>expo-effect-platform</Text>

        <View style={s.group}>
          <Text style={s.groupHeader}>HTTP Server</Text>
          <Text>Status: {status}</Text>
          {address ? <Text selectable>Address: {address}</Text> : null}
          <View style={{ marginTop: 12 }}>
            <Button title="Start Server" onPress={startServer} disabled={status === 'Running'} />
          </View>
        </View>

        <View style={s.group}>
          <Text style={s.groupHeader}>Feature Tests</Text>
          <View style={{ marginBottom: 12 }}>
            <Button
              title={testing ? 'Running...' : 'Run Tests'}
              onPress={runTests}
              disabled={status !== 'Running' || testing}
            />
          </View>

          {results.length > 0 && (
            <View style={s.summary}>
              <Text style={s.summaryText}>
                {passed} passed, {failed} failed
                {testing ? ` - ${tests.length - results.length} In-Progress` : ' - Finished'}
              </Text>
            </View>
          )}

          {results.map((r, i) => (
            <View key={i} style={[s.testRow, r.pass ? s.pass : s.fail]}>
              <Text style={s.testLabel}>
                {r.pass ? 'PASS' : 'FAIL'} {r.name}
              </Text>
              <Text style={s.testDetail}>{r.detail}</Text>
            </View>
          ))}

          {results.length === 0 && (
            <Text style={{ color: '#888' }}>
              {status === 'Running'
                ? 'Press "Run Tests" to test each endpoint'
                : 'Start the server first'}
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#eee' },
  header: { fontSize: 30, margin: 20, fontWeight: 'bold' },
  groupHeader: { fontSize: 20, marginBottom: 12, fontWeight: '600' },
  group: { margin: 20, backgroundColor: '#fff', borderRadius: 10, padding: 20 },
  summary: { backgroundColor: '#f0f0f0', borderRadius: 6, padding: 10, marginBottom: 12 },
  summaryText: { fontWeight: '600', fontSize: 15 },
  testRow: { borderRadius: 6, padding: 10, marginBottom: 6 },
  pass: { backgroundColor: '#e6f9e6' },
  fail: { backgroundColor: '#fde8e8' },
  testLabel: { fontWeight: '600', fontSize: 14 },
  testDetail: { fontSize: 12, color: '#555', marginTop: 2 },
})
