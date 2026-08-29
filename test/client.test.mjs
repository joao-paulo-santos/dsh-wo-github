/**
 * dsh-wo-github - client + host tests against fakes.
 *
 * Client side: the patch hunk parser (true line numbers from @@ headers)
 * and the tab contract. Host side: the four routes against a stubbed
 * global fetch (GitHub API), including cache hits and rate-limit mapping.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = pathDirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE_PATH = pathResolve(HERE, '../lib/client.js')
const HOST_ENTRY_PATH = pathResolve(HERE, '../lib/index.js')

// ---------------------------------------------------------------- client

const mkReact = () => ({
  createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
})

const mkDocument = () => {
  const head = { children: [] }
  head.appendChild = (tag) => { head.children.push(tag) }
  return {
    head,
    createElement: (tagName) => {
      const tag = { tagName, dataset: {}, textContent: '' }
      tag.remove = () => { const at = head.children.indexOf(tag); if (at >= 0) head.children.splice(at, 1) }
      return tag
    },
  }
}

const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return (node.children ?? []).map(textOf).join('')
}

const loadClient = () => {
  const react = mkReact()
  let mod
  globalThis.window = { __ModuleLoader__: { load: (h) => { mod = h.factory((spec) => {
    if (spec === 'react') return react
    throw new Error('unexpected require: ' + spec)
  }) } } }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  delete globalThis.window
  return mod
}

test('client registers the github subtab with the workspaceOverview facade', () => {
  const mod = loadClient()
  assert.equal(mod.name, 'wo-github-client')
  assert.deepEqual(mod.inject, ['workspaceOverview'])
  const registered = []
  const off = { called: false }
  const overview = { registerTab: (options, component) => { registered.push({ options, component }); return () => { off.called = true } } }
  const provided = {}
  const ctx = {
    inject: mod.inject,
    get: (n) => (mod.inject.includes(n) ? provided[n] : undefined),
    provide: (n, a) => { provided[n] = a },
    workspaceOverview: overview,
  }
  const dispose = mod.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.id, 'github')
  assert.equal(registered[0].options.label, 'GitHub')
  assert.equal(typeof registered[0].component, 'function')
  dispose()
  assert.equal(off.called, true, 'disposer unregisters the tab')
})

test('hunksOfPatch: bases from @@ headers, per-row numbers, \\ lines skipped', () => {
  const mod = loadClient()
  const hunks = mod._internal.hunksOfPatch([
    '@@ -3,4 +3,5 @@',
    ' ctx a',
    '-old one',
    '-old two',
    '+new one',
    '+new two',
    '+new three',
    ' ctx b',
    '\\ No newline at end of file',
    '@@ -20,2 +21,2 @@',
    '-gone',
    ' kept',
  ].join('\n'))
  assert.equal(hunks.length, 2)
  const [h1, h2] = hunks
  assert.equal(h1.oldStart, 3)
  assert.equal(h1.newStart, 3)
  const ctxRow = h1.rows[0]
  assert.deepEqual({ k: ctxRow.k, oldNo: ctxRow.oldNo, newNo: ctxRow.newNo }, { k: 'ctx', oldNo: 3, newNo: 3 })
  assert.deepEqual(h1.rows[1].oldNo, 4)   // -old one
  assert.deepEqual(h1.rows[2].oldNo, 5)   // -old two
  assert.deepEqual(h1.rows[3].newNo, 4)   // +new one (oldNo undefined)
  assert.deepEqual(h1.rows[5].newNo, 6)   // +new three
  const ctxB = h1.rows[6]
  assert.deepEqual({ oldNo: ctxB.oldNo, newNo: ctxB.newNo }, { oldNo: 6, newNo: 7 })
  // second hunk re-bases
  assert.equal(h2.oldStart, 20)
  assert.equal(h2.rows[0].oldNo, 20)      // -gone
  assert.equal(h2.rows[1].newNo, 21)      // ' kept' (new side starts at 21)
})

test('timeAgoOf and firstLineOf', () => {
  const mod = loadClient()
  assert.equal(mod._internal.firstLineOf('subject\n\nbody'), 'subject')
  assert.equal(mod._internal.firstLineOf('only'), 'only')
  const now = Date.now()
  assert.equal(mod._internal.timeAgoOf(new Date(now - 30_000).toISOString()), 'just now')
  assert.equal(mod._internal.timeAgoOf(new Date(now - 2 * 60_000).toISOString()), '2 minutes ago')
  assert.equal(mod._internal.timeAgoOf(new Date(now - 3 * 3600_000).toISOString()), '3 hours ago')
  assert.equal(mod._internal.timeAgoOf(new Date(now - 2 * 86400_000).toISOString()), '2 days ago')
})

// ------------------------------------------------------------------ host

const jsonResponse = (body, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
})

const mkHostHarness = () => {
  const routes = new Map()
  const webServer = { register: (spec) => { routes.set(spec.path, spec.handler); return () => routes.delete(spec.path) } }
  const ctx = { webServer }
  const calls = []
  const savedFetch = globalThis.fetch
  return {
    routes, calls,
    setFetch(fn) { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fn(url, init) } },
    async get(path) {
      const res = { statusCode: 0, headers: {}, body: '' }
      await routes.get(new URL(path, 'http://localhost').pathname)(
        { url: path }, {
          set statusCode(v) { res.statusCode = v },
          get statusCode() { return res.statusCode },
          setHeader(k, v) { res.headers[k] = v },
          end(b) { res.body = b },
        })
      return { status: res.statusCode, body: JSON.parse(res.body) }
    },
    cleanup() { globalThis.fetch = savedFetch },
  }
}

test('host routes: meta + readme + commits + commit, cached, rate limit mapped', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch((url) => {
    const u = new URL(url)
    if (u.pathname === '/repos/o/r') return jsonResponse({ full_name: 'o/r', description: 'd', stargazers_count: 5, forks_count: 1, open_issues_count: 2, subscribers_count: 3, language: 'JS', default_branch: 'main', license: { spdx_id: 'MIT' }, topics: ['t'], updated_at: '2026-01-01T00:00:00Z', pushed_at: '2026-01-01T00:00:00Z', owner: { login: 'o', avatar_url: 'a.png' }, html_url: 'https://github.com/o/r', private: false })
    if (u.pathname === '/repos/o/r/readme') return jsonResponse({ name: 'README.md', content: Buffer.from('# Hello').toString('base64') })
    if (u.pathname === '/repos/o/r/commits') {
      return jsonResponse([{ sha: 'a'.repeat(40), commit: { message: 'msg', author: { name: 'A', date: '2026-01-01T00:00:00Z' } }, author: { login: 'a' }, html_url: 'u' }])
    }
    if (/^\/repos\/o\/r\/commits\/[0-9a-f]+$/.test(u.pathname)) {
      return jsonResponse({ sha: 'b'.repeat(40), commit: { message: 'm', author: { name: 'A', date: '2026-01-01T00:00:00Z' } }, stats: { additions: 1, deletions: 0 }, files: [{ filename: 'f', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b' }] })
    }
    return jsonResponse({ message: 'nope' })
  })
  try {
    const meta = await h.get('/wo-github/meta?repo=o/r')
    assert.equal(meta.status, 200)
    assert.equal(meta.body.fullName, 'o/r')
    assert.equal(meta.body.stars, 5)

    const readme = await h.get('/wo-github/readme?repo=o/r')
    assert.equal(readme.body.text, '# Hello')

    const commits = await h.get('/wo-github/commits?repo=o/r')
    assert.equal(commits.body.count, 1)
    assert.equal(commits.body.commits[0].sha, 'a'.repeat(40))

    const commit = await h.get('/wo-github/commit?repo=o/r&sha=' + 'b'.repeat(40))
    assert.equal(commit.body.files[0].filename, 'f')

    // cache hits: a second round trips ZERO new fetches
    const before = h.calls.length
    await h.get('/wo-github/meta?repo=o/r')
    await h.get('/wo-github/readme?repo=o/r')
    await h.get('/wo-github/commit?repo=o/r&sha=' + 'b'.repeat(40))
    assert.equal(h.calls.length, before, 'served from cache')

    // bad repo shape -> 400 without touching the network
    const bad = await h.get('/wo-github/meta?repo=nope')
    assert.equal(bad.status, 400)
    assert.equal(h.calls.length, before)

    // bad sha -> 400
    const badSha = await h.get('/wo-github/commit?repo=o/r&sha=ZZZ')
    assert.equal(badSha.status, 400)
  } finally {
    h.cleanup()
  }
})

test('host: rate-limit exhaustion maps to 503 with reset', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch(() => ({
    ok: false,
    status: 403,
    headers: { get: (name) => (name === 'x-ratelimit-remaining' ? '0' : name === 'x-ratelimit-reset' ? '1900000000' : null) },
    json: async () => ({}),
  }))
  try {
    const res = await h.get('/wo-github/meta?repo=o/limited')   // not cached by the earlier test
    assert.equal(res.status, 503)
    assert.match(res.body.error, /rate limit/)
  } finally {
    h.cleanup()
  }
})

test('host: absent readme surfaces as { absent: true }, not an error', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch((url) => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }) }))
  try {
    const res = await h.get('/wo-github/readme?repo=o/empty')
    assert.equal(res.status, 200)
    assert.equal(res.body.absent, true)
  } finally {
    h.cleanup()
  }
})
