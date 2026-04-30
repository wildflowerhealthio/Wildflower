/* oxlint-disable @typescript-eslint/no-unsafe-assignment, no-console */
// Simple HTTP server for E2E testing.
// Run this on your host machine before launching the example app:
//   node test-server.js
//
// iOS Simulator: "localhost" from the app reaches this server.
// Android Emulator: use local_host "10.0.2.2" in the app.

const http = require('http')

const PORT = 8765

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url} (Host: ${req.headers.host})`)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      ok: true,
      method: req.method,
      url: req.url,
      headers: req.headers,
    })
  )
})

server.listen(PORT, () => {
  console.log(`Test server listening on http://localhost:${PORT}`)
  console.log('Press Ctrl+C to stop')
})
