import { describe, expect, it } from 'vite-plus/test'

import { healthCheckTitle } from './-health-check-title.ts'

describe('healthCheckTitle', () => {
  it.each([
    ['server', 'Server'],
    ['connectivity', 'Connectivity'],
    ['databaseConnection', 'Database Connection'],
    ['DatabaseConnection', 'Database Connection'],
    ['fhir-r4', 'Fhir R4'],
    ['db:responseTime', 'Db Response Time'],
    ['uptime_seconds', 'Uptime Seconds'],
    ['HTTPServer', 'HTTP Server'],
    ['cpu utilization', 'Cpu Utilization'],
    ['::', '::'],
  ])('should title %j as %j', (key, title) => {
    expect(healthCheckTitle(key)).toBe(title)
  })
})
