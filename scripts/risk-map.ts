#!/usr/bin/env node
// Emits a JSON map of `{ <pkgName>: <multiplier> }` for the kitchen-sink
// `numRunsFor` helper to consume via the FC_RISK_MAP env var. Packages
// reachable in the reverse workspace dep graph from a changed file get the
// HIGH multiplier (1.0); everything else gets LOW (0.2). Root-config or
// lockfile changes promote every package to HIGH.
import { execSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HIGH = 1.0
const LOW = 0.2

const ROOT_CONFIG_FILES = new Set([
  'vite.config.base.ts',
  'vite.config.ts',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
])

const PER_PKG_FORCE_HIGH_BASENAMES = new Set(['package.json', 'vite.config.ts'])

type Pkg = { name: string; dir: string; relDir: string; deps: Set<string> }

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()

const collectChangedFiles = (): Set<string> => {
  const mergeBase = execSync('git merge-base origin/main HEAD', {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const commands = [
    `git diff --name-only ${mergeBase}..HEAD`,
    'git diff --name-only',
    'git diff --name-only --staged',
    'git ls-files --others --exclude-standard',
  ]
  const out = new Set<string>()
  for (const cmd of commands) {
    const text = execSync(cmd, { cwd: repoRoot, encoding: 'utf8' })
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line) out.add(line)
    }
  }
  return out
}

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== 'object' || value === null) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}

const loadPackages = (): Pkg[] => {
  const patterns = [
    'apps/*/package.json',
    'global/*/package.json',
    'global/effect-messaging/*/package.json',
    'global/expo-effect-platform/example/package.json',
    'slices/**/package.json',
  ]
  const seen = new Set<string>()
  const pkgs: Pkg[] = []
  for (const pattern of patterns) {
    for (const rel of globSync(pattern, {
      cwd: repoRoot,
      exclude: (p: string) => p.includes('node_modules') || p.includes('dist'),
    })) {
      if (seen.has(rel)) continue
      seen.add(rel)
      const abs = join(repoRoot, rel)
      const json: unknown = JSON.parse(readFileSync(abs, 'utf8'))
      if (typeof json !== 'object' || json === null) continue
      const record: Record<string, unknown> = { ...json }
      const name = record.name
      if (typeof name !== 'string') continue
      const deps = new Set<string>()
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const sectionValue = record[section]
        if (!isStringRecord(sectionValue)) continue
        for (const [depName, ver] of Object.entries(sectionValue)) {
          if (ver.startsWith('workspace:')) deps.add(depName)
        }
      }
      pkgs.push({ name, dir: dirname(abs), relDir: dirname(rel), deps })
    }
  }
  return pkgs
}

const ownerFor = (file: string, packagesByDepth: Pkg[]): Pkg | undefined => {
  for (const pkg of packagesByDepth) {
    if (file === pkg.relDir || file.startsWith(`${pkg.relDir}/`)) return pkg
  }
  return undefined
}

const emit = (map: Record<string, number>): never => {
  process.stdout.write(JSON.stringify(map))
  process.exit(0)
}

const changedFiles = collectChangedFiles()
const packages = loadPackages()

const allHigh = (reason: string): never => {
  const map: Record<string, number> = {}
  for (const p of packages) map[p.name] = HIGH
  process.stderr.write(`risk: ${reason} — all ${packages.length} packages at high risk (${HIGH})\n`)
  return emit(map)
}

for (const f of changedFiles) {
  if (ROOT_CONFIG_FILES.has(f)) allHigh(`root config changed (${f})`)
}

const packagesByDepth = [...packages].toSorted((a, b) => b.relDir.length - a.relDir.length)
const directlyChanged = new Set<string>()
for (const file of changedFiles) {
  const owner = ownerFor(file, packagesByDepth)
  if (!owner) continue
  directlyChanged.add(owner.name)
  const base = file.slice(owner.relDir.length + 1)
  if (PER_PKG_FORCE_HIGH_BASENAMES.has(base)) {
    // Per-package config change — still just marks that package as changed
    // (the transitive walk below handles the propagation).
  }
}

const reverseDeps = new Map<string, Set<string>>()
for (const p of packages) reverseDeps.set(p.name, new Set())
for (const p of packages) {
  for (const dep of p.deps) {
    const r = reverseDeps.get(dep)
    if (r) r.add(p.name)
  }
}

const highRisk = new Set(directlyChanged)
const queue = [...directlyChanged]
while (queue.length > 0) {
  const cur = queue.shift()!
  for (const depender of reverseDeps.get(cur) ?? []) {
    if (highRisk.has(depender)) continue
    highRisk.add(depender)
    queue.push(depender)
  }
}

const map: Record<string, number> = {}
for (const p of packages) map[p.name] = highRisk.has(p.name) ? HIGH : LOW

const highList = [...highRisk].toSorted()
const lowCount = packages.length - highRisk.size
process.stderr.write(
  `risk: ${highRisk.size} high (${HIGH}), ${lowCount} low (${LOW}) — changed: ${directlyChanged.size}\n`
)
if (highList.length > 0 && highList.length <= 20) {
  process.stderr.write(`  high: ${highList.join(', ')}\n`)
} else if (highList.length > 20) {
  process.stderr.write(`  high (first 20): ${highList.slice(0, 20).join(', ')}, ...\n`)
}

emit(map)
