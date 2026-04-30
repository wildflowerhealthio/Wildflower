import localtunnel, { type Tunnel } from 'expo-localtunnel'
import { useState, useCallback, type JSX } from 'react'
import { ScrollView, Text, View, Button, Platform } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'

type TestResult = {
  name: string
  status: 'pass' | 'fail' | 'running' | 'pending'
  detail?: string
}

const LOCAL_PORT = 8765
// Android emulator uses 10.0.2.2 to reach the host machine
const LOCAL_HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function App(): JSX.Element {
  const [results, setResults] = useState<TestResult[]>([])
  const [running, setRunning] = useState(false)

  const updateResult = useCallback((index: number, update: Partial<TestResult>) => {
    setResults((prev) => prev.map((r, i) => (i === index ? { ...r, ...update } : r)))
  }, [])

  const runTests = useCallback(async () => {
    setRunning(true)
    const tests: TestResult[] = [
      { name: 'Create tunnel', status: 'pending' },
      { name: 'Tunnel has URL', status: 'pending' },
      { name: 'Fetch through tunnel', status: 'pending' },
      { name: 'Request event fires', status: 'pending' },
      { name: 'Close tunnel', status: 'pending' },
      { name: 'local_https throws', status: 'pending' },
    ]
    setResults(tests)

    let tunnel: Tunnel | null = null
    let requestFired = false

    // --- Test 1: Create tunnel ---
    const t1 = 0
    setResults((prev) => prev.map((r, i) => (i === t1 ? { ...r, status: 'running' } : r)))
    try {
      tunnel = await localtunnel({
        port: LOCAL_PORT,
        local_host: LOCAL_HOST,
        host: 'https://localtunnel.me',
      })

      tunnel.on('request', () => {
        requestFired = true
      })

      tunnel.on('error', (err: Error) => {
        // oxlint-disable-next-line no-console
        console.warn('Tunnel error:', err.message)
      })

      updateResult(t1, { status: 'pass', detail: 'Tunnel created' })
    } catch (e) {
      updateResult(t1, { status: 'fail', detail: errorMessage(e) })
      setRunning(false)
      return
    }

    if (!tunnel) {
      setRunning(false)
      return
    }

    // --- Test 2: Tunnel has URL ---
    const t2 = 1
    setResults((prev) => prev.map((r, i) => (i === t2 ? { ...r, status: 'running' } : r)))
    if (tunnel.url && typeof tunnel.url === 'string' && tunnel.url.startsWith('https://')) {
      updateResult(t2, { status: 'pass', detail: tunnel.url })
    } else {
      updateResult(t2, { status: 'fail', detail: `Got: ${String(tunnel.url)}` })
    }

    // --- Test 3: Fetch through tunnel ---
    const t3 = 2
    setResults((prev) => prev.map((r, i) => (i === t3 ? { ...r, status: 'running' } : r)))
    try {
      // Give connections a moment to establish
      await sleep(1000)
      const res = await fetch(tunnel.url ?? '', {
        headers: { Accept: 'application/json' },
      })
      const body: unknown = await res.json()
      const isOk = typeof body === 'object' && body !== null && 'ok' in body && body.ok === true
      if (isOk) {
        updateResult(t3, { status: 'pass', detail: `HTTP ${res.status}, body.ok=true` })
      } else {
        updateResult(t3, { status: 'fail', detail: `Unexpected body: ${JSON.stringify(body)}` })
      }
    } catch (e) {
      updateResult(t3, {
        status: 'fail',
        detail: `${errorMessage(e)} (is test-server.js running on port ${LOCAL_PORT}?)`,
      })
    }

    // --- Test 4: Request event ---
    const t4 = 3
    setResults((prev) => prev.map((r, i) => (i === t4 ? { ...r, status: 'running' } : r)))
    // Give event time to propagate
    await sleep(500)
    if (requestFired) {
      updateResult(t4, { status: 'pass', detail: 'request event received' })
    } else {
      updateResult(t4, { status: 'fail', detail: 'No request event received' })
    }

    // --- Test 5: Close tunnel ---
    const t5 = 4
    setResults((prev) => prev.map((r, i) => (i === t5 ? { ...r, status: 'running' } : r)))
    try {
      tunnel.close()
      updateResult(t5, { status: 'pass', detail: 'Closed without error' })
    } catch (e) {
      updateResult(t5, { status: 'fail', detail: errorMessage(e) })
    }

    // --- Test 6: local_https throws ---
    const t6 = 5
    setResults((prev) => prev.map((r, i) => (i === t6 ? { ...r, status: 'running' } : r)))
    try {
      const t = await localtunnel({ port: LOCAL_PORT, local_https: true })
      // If we get here, it should still error via event
      await sleep(500)
      t.close()
      updateResult(t6, { status: 'fail', detail: 'No error thrown for local_https' })
    } catch (e) {
      const message = errorMessage(e)
      if (message.includes('local_https')) {
        updateResult(t6, { status: 'pass', detail: 'Threw expected error' })
      } else {
        updateResult(t6, { status: 'fail', detail: `Wrong error: ${message}` })
      }
    }

    setRunning(false)
  }, [updateResult])

  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const total = results.length

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <ScrollView style={styles.container}>
          <Text style={styles.header}>expo-localtunnel E2E Tests</Text>
          <Text style={styles.hint}>
            Run `node test-server.js` on host machine first (port {LOCAL_PORT})
          </Text>

          <View style={styles.buttonRow}>
            <Button
              title={running ? 'Running...' : 'Run Tests'}
              onPress={runTests}
              disabled={running}
            />
          </View>

          {total > 0 && (
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {passed}/{total} passed
                {failed > 0 ? ` | ${failed} failed` : ''}
              </Text>
            </View>
          )}

          {results.map((r) => (
            <View key={r.name} style={styles.result}>
              <Text style={styles.resultIcon}>
                {r.status === 'pass'
                  ? 'PASS'
                  : r.status === 'fail'
                    ? 'FAIL'
                    : r.status === 'running'
                      ? '...'
                      : '  '}
              </Text>
              <View style={styles.resultText}>
                <Text style={styles.resultName}>{r.name}</Text>
                {r.detail ? <Text style={styles.resultDetail}>{r.detail}</Text> : null}
              </View>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const styles = {
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    fontSize: 24,
    fontWeight: 'bold' as const,
    color: '#fff',
    margin: 20,
    marginBottom: 4,
  },
  hint: {
    fontSize: 13,
    color: '#888',
    marginHorizontal: 20,
    marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  buttonRow: {
    marginHorizontal: 20,
    marginBottom: 16,
  },
  summary: {
    marginHorizontal: 20,
    marginBottom: 12,
    padding: 12,
    backgroundColor: '#16213e',
    borderRadius: 8,
  },
  summaryText: {
    fontSize: 16,
    fontWeight: 'bold' as const,
    color: '#e0e0e0',
  },
  result: {
    flexDirection: 'row' as const,
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 12,
    backgroundColor: '#16213e',
    borderRadius: 8,
    alignItems: 'flex-start' as const,
  },
  resultIcon: {
    fontSize: 13,
    fontWeight: 'bold' as const,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#e0e0e0',
    width: 42,
    marginTop: 2,
  },
  resultText: {
    flex: 1,
  },
  resultName: {
    fontSize: 15,
    color: '#fff',
    fontWeight: '500' as const,
  },
  resultDetail: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
}
