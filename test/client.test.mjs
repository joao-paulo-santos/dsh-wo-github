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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = pathDirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE_PATH = pathResolve(HERE, '../lib/client.js')

/** Same bucketing as @deepseek-ai/dsh-client-ui-primitives/relative-time. */
const fakeRelativeTime = (at, now) => {
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
  const diff = Math.max(0, now - at)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
// Minimal stand-ins matching the primitive contracts the plugin uses.
const PRIMITIVES_FAKE = {
  relativeTime: fakeRelativeTime,
  Button: (props) => ({ type: 'button', props, children: [props.children].flat(Infinity) }),
  Checkbox: (props) => ({
    type: 'label',
    props: { className: props.className, title: props.title },
    children: [
      { type: 'input', props: { type: 'checkbox', checked: props.checked, disabled: props.disabled }, children: [] },
      { type: 'span', props: {}, children: [props.label] },
    ],
  }),
  Input: (props) => ({ type: 'input', props, children: [] }),
  SegmentedControl: (props) => ({
    type: 'div',
    props: { role: 'tablist', 'aria-label': props.label },
    children: props.options.map((o) => ({ type: 'button', props: { key: o.value, onClick: () => { props.onChange(o.value) } }, children: [o.label] })),
  }),
}
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
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
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
  assert.deepEqual(mod.inject, ['workspaceOverview', 'slots'])
  const registered = []
  const off = { called: false }
  const overview = { registerTab: (options, component) => { registered.push({ options, component }); return () => { off.called = true } } }
  const provided = {}
  const ctx = {
    inject: mod.inject,
    get: (n) => (mod.inject.includes(n) ? provided[n] : undefined),
    provide: (n, a) => { provided[n] = a },
    workspaceOverview: overview,
    slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
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
  const mkRes = () => {
    const res = { statusCode: 0, headers: {}, body: '' }
    return {
      res,
      set statusCode(v) { res.statusCode = v },
      get statusCode() { return res.statusCode },
      setHeader(k, v) { res.headers[k] = v },
      end(b) { res.body = b },
    }
  }
  return {
    routes, calls,
    setFetch(fn) { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fn(url, init) } },
    async get(path) {
      const res = mkRes()
      await routes.get(new URL(path, 'http://localhost').pathname)({ url: path, method: 'GET' }, res)
      return { status: res.res.statusCode, body: JSON.parse(res.res.body) }
    },
    async post(path, body) {
      const res = mkRes()
      const listeners = {}
      const req = {
        method: 'POST', url: path,
        on: (event, fn) => { listeners[event] = fn },
        destroy: () => {},
      }
      const pending = routes.get(new URL(path, 'http://localhost').pathname)(req, res)
      if (listeners.data !== undefined) listeners.data(Buffer.from(JSON.stringify(body)))
      if (listeners.end !== undefined) listeners.end()
      await pending
      return { status: res.res.statusCode, body: JSON.parse(res.res.body) }
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
    assert.equal(meta.body.github.fullName, 'o/r')
    assert.equal(meta.body.github.stars, 5)
    assert.equal(meta.body.local, undefined)

    const readme = await h.get('/wo-github/readme?repo=o/r')
    assert.equal(readme.body.text, '# Hello')

    const commits = await h.get('/wo-github/commits?repo=o/r')
    assert.equal(commits.body.hasMore, false)
    assert.equal(commits.body.source, 'github')
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

// ------------------------------------------------------------------ local git

/** A real tiny clone: two commits, README.md + code file changed in the second. */
const mkFixtureRepo = () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wog-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  writeFileSync(pathJoin(dir, 'README.md'), '# Fixture\n\nlocal readme body\n')
  git('add', '-A'); git('commit', '-m', 'first: add readme')
  writeFileSync(pathJoin(dir, 'code.js'), 'let a = 1;\n')
  git('add', '-A'); git('commit', '-m', 'second: add code\n\nbody line')
  return dir
}

test('pending lifecycle: status, whole-file stage, hunk stage, untracked, commit', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogpend-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const lines = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1))
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  writeFileSync(pathJoin(dir, 'code.js'), lines.join('\n') + '\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  // adjacent edits (lines 1-2, one hunk with two changed lines) + one
  // distant edit (line 18, second hunk) + one untracked file
  writeFileSync(pathJoin(dir, 'code.js'),
    lines.map((l, i) => (i === 0 ? 'HEAD EDIT' : i === 1 ? 'SECOND EDIT' : i === 17 ? 'TAIL EDIT' : l)).join('\n') + '\n')
  writeFileSync(pathJoin(dir, 'new.txt'), 'fresh\ncontent\n')
  try {
    let pending = await h.get('/wo-github/pending?path=' + encodeURIComponent(dir))
    assert.equal(pending.status, 200)
    assert.equal(pending.body.count, 2)
    const code = pending.body.files.find((f) => f.file === 'code.js')
    const fresh = pending.body.files.find((f) => f.file === 'new.txt')
    assert.equal(code.staged, false, 'modification starts unstaged')
    assert.equal(fresh.untracked, true)

    // branch route carries the dirty count
    const branch = await h.get('/wo-github/branch?path=' + encodeURIComponent(dir))
    assert.equal(branch.body.pending, 2)

    // untracked file's diff comes back as whole-file additions (before staging)
    const untrackedDiff = await h.get('/wo-github/pending-diff?path=' + encodeURIComponent(dir) + '&file=new.txt')
    assert.equal(untrackedDiff.body.untrackedText, 'fresh\ncontent\n')

    // whole-file stage of the untracked file
    const staged = await h.post('/wo-github/pending-stage', { path: dir, file: 'new.txt', stage: true })
    assert.equal(staged.body.files.find((f) => f.file === 'new.txt').staged, true)

    // LINE-level staging: stage only the FIRST changed line of hunk 1
    // (the same patch the client's partialHunkPatch builds on line click).
    const codeDiff = await h.get('/wo-github/pending-diff?path=' + encodeURIComponent(dir) + '&file=code.js')
    const text = codeDiff.body.unstaged
    assert.equal(text.split('\n').filter((l) => l.startsWith('@@')).length, 2, 'two hunks in the worktree diff')
    const firstAt = text.indexOf('@@')
    const secondAt = text.indexOf('\n@@', firstAt + 2)
    const hunk1 = text.slice(firstAt, secondAt + 1).split('\n')
    const head = hunk1[0]
    const body = hunk1.slice(1).filter((l) => l !== '')
    const plusAt = body.findIndex((l) => l.startsWith('+'))
    const partialBody = body.map((l, i) => {
      if (l.startsWith('+')) return i === plusAt ? l : null
      if (l.startsWith('-')) return i === plusAt ? l : ' ' + l.slice(1)
      return l
    }).filter((l) => l !== null)
    const partial = text.slice(0, firstAt) + head + '\n' + partialBody.join('\n') + '\n'
    assert.match(partial, /^diff --git /)
    assert.match(partial, /\+HEAD EDIT/)
    assert.doesNotMatch(partial, /\+SECOND EDIT/)

    const lineStaged = await h.post('/wo-github/pending-stage-hunk', { path: dir, patch: partial })
    const codeRow = lineStaged.body.files.find((f) => f.file === 'code.js')
    assert.equal(codeRow.staged, true, 'file reports staged after one line lands in the index')
    assert.equal(codeRow.unstaged, true, 'the rest is still unstaged')

    const afterLine = await h.get('/wo-github/pending-diff?path=' + encodeURIComponent(dir) + '&file=code.js')
    assert.match(afterLine.body.staged, /\+HEAD EDIT/, 'exactly the clicked line is staged')
    assert.doesNotMatch(afterLine.body.staged, /SECOND EDIT/, 'the sibling line is NOT staged')
    assert.match(afterLine.body.unstaged, /SECOND EDIT/, 'the sibling line remains unstaged')
    assert.match(afterLine.body.unstaged, /TAIL EDIT/, 'the tail hunk remains unstaged')

    // commit exactly the index (new.txt + the single staged line)
    const committed = await h.post('/wo-github/pending-commit', { path: dir, summary: 'line stage commit' })
    assert.equal(committed.body.committed, true)

    const after = await h.get('/wo-github/pending?path=' + encodeURIComponent(dir))
    const rows = after.body.files
    assert.equal(rows.length, 1, 'only the remaining unstaged changes of code.js are pending')
    assert.equal(rows[0].file, 'code.js')
    assert.equal(rows[0].staged, false)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
})

test('local: locate, readme, commits, commit detail, meta — no network', async () => {
  const dir = mkFixtureRepo()
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch(() => { throw new Error('network must not be used for local git data') })
  try {
    const enc = encodeURIComponent(dir)

    const locate = await h.get('/wo-github/locate?path=' + enc)
    assert.equal(locate.body.git, true)

    const readme = await h.get('/wo-github/readme?path=' + enc)
    assert.equal(readme.body.name, 'README.md')
    assert.match(readme.body.text, /local readme body/)

    const commits = await h.get('/wo-github/commits?path=' + enc + '&page=1')
    assert.equal(commits.body.source, 'local')
    assert.equal(commits.body.commits.length, 2)
    assert.equal(commits.body.hasMore, false)
    assert.equal(commits.body.commits[0].message, 'second: add code')
    const fullSha = commits.body.commits[0].sha

    const detail = await h.get('/wo-github/commit?path=' + enc + '&sha=' + fullSha)
    assert.equal(detail.body.source, 'local')
    assert.equal(detail.body.files.length, 1)
    const file = detail.body.files[0]
    assert.equal(file.filename, 'code.js')
    assert.equal(file.status, 'added')
    assert.equal(file.additions, 1)
    assert.match(file.patch, /^@@ -0,0 \+1 @@/)

    const meta = await h.get('/wo-github/meta?path=' + enc)
    assert.equal(meta.body.github, undefined)
    assert.equal(meta.body.local.branch, 'main')
    assert.match(meta.body.local.subject, /second: add code/)
    assert.ok(meta.body.local.lastCommitAt)

    // page far beyond the history: empty, no hasMore
    const empty = await h.get('/wo-github/commits?path=' + enc + '&page=9')
    assert.equal(empty.body.commits.length, 0)
    assert.equal(empty.body.hasMore, false)
  } finally {
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local: non-git path falls back to GitHub when a repo is given', async () => {
  const emptyDir = mkdtempSync(pathJoin(tmpdir(), 'wogempty-'))
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch((url) => {
    const u = new URL(url)
    if (u.pathname === '/repos/o/r') return jsonResponse({ full_name: 'o/r', stargazers_count: 9, forks_count: 0, open_issues_count: 0, subscribers_count: 0, default_branch: 'main', topics: [], owner: { login: 'o' }, html_url: 'u', private: false })
    return jsonResponse({ message: 'nope' })
  })
  try {
    const locate = await h.get('/wo-github/locate?path=' + encodeURIComponent(emptyDir) + '&repo=o/r')
    assert.equal(locate.body.git, false)
    assert.equal(locate.body.slug, 'o/r')

    const meta = await h.get('/wo-github/meta?path=' + encodeURIComponent(emptyDir) + '&repo=o/r')
    assert.equal(meta.body.github.fullName, 'o/r')
    assert.equal(meta.body.local, undefined)
  } finally {
    h.cleanup()
    rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('local: neither git nor repo -> locate says git:false and client would show empty state', async () => {
  const emptyDir = mkdtempSync(pathJoin(tmpdir(), 'wognone-'))
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  h.setFetch(() => { throw new Error('no network expected') })
  try {
    const locate = await h.get('/wo-github/locate?path=' + encodeURIComponent(emptyDir))
    assert.equal(locate.body.git, false)
    assert.equal(locate.body.slug, null)
    const readme = await h.get('/wo-github/readme?path=' + encodeURIComponent(emptyDir))
    assert.equal(readme.body.absent, true)
  } finally {
    h.cleanup()
    rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('CommitsPane: hook count is stable across selection (React #300 regression)', async () => {
  // A fake React that counts hooks executed per render pass.
  let hookIdx = 0
  const slots = []
  const counts = []
  let counting = false
  const react = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
    Fragment: 'F',
    useState: (init) => {
      if (counting) counts[counts.length - 1]++
      const i = hookIdx++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect: () => { if (counting) counts[counts.length - 1]++ },
  }
  let mod
  globalThis.window = { __ModuleLoader__: { load: (h) => { mod = h.factory((s) => {
    if (s === 'react') return react
    if (s === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
    throw new Error('unexpected require: ' + s)
  }) } } }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  delete globalThis.window
  mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {} }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
  const CommitsPane = mod._internal.CommitsPane
  const loc = { path: '/tmp', repo: undefined }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ source: 'local', hasMore: false, commits: [{ sha: 'abc1234', message: 'm', author: 'A', date: '2026-01-01T00:00:00Z' }] }) })
  // pass 1: list view (page + selected + useRepoData's state + its effect)
  counting = true; counts.push(0); hookIdx = 0
  CommitsPane({ loc })
  const beforeSelection = counts[0]
  assert.equal(beforeSelection, 4, 'page + selected + list state + list effect')
  // pass 2: a commit is selected — the hook count must not change
  slots[1] = 'abc1234'
  counts.push(0); hookIdx = 0
  CommitsPane({ loc })
  const afterSelection = counts[1]
  assert.equal(afterSelection, beforeSelection, 'selection must not change the hook count (early return before hooks = React #300)')
})

// ------------------------------------------------- branch pill (host + client)

const mkRepo = () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogbranch-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  git('init', '-b', 'main')
  writeFileSync(pathJoin(dir, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'c1')
  return { dir, git, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch (e) {} } }
}

test('host branch route: branch, agent checkout, detached, non-repo', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const repo = mkRepo()
  try {
    const onMain = await h.get('/wo-github/branch?path=' + encodeURIComponent(repo.dir))
    assert.equal(onMain.status, 200)
    assert.equal(onMain.body.branch, 'main')
    assert.equal(onMain.body.sha, null)

    // the agent checks out a new branch: the pill's next poll sees it
    repo.git('checkout', '-b', 'feature/x')
    const onFeature = await h.get('/wo-github/branch?path=' + encodeURIComponent(repo.dir))
    assert.equal(onFeature.body.branch, 'feature/x')

    // detached HEAD: branch null, short sha present
    repo.git('checkout', '--detach', 'HEAD')
    const onDetached = await h.get('/wo-github/branch?path=' + encodeURIComponent(repo.dir))
    assert.equal(onDetached.body.branch, null)
    assert.match(onDetached.body.sha, /^[0-9a-f]{7,}$/)

    const emptyDir = mkdtempSync(pathJoin(tmpdir(), 'wogbranchnone-'))
    try {
      const notRepo = await h.get('/wo-github/branch?path=' + encodeURIComponent(emptyDir))
      assert.equal(notRepo.status, 200)
      assert.equal(notRepo.body.branch, null)
      assert.equal(notRepo.body.sha, null)
    } finally { rmSync(emptyDir, { recursive: true, force: true }) }
  } finally {
    repo.cleanup()
  }
})

test('client BranchPill: shows the branch with slug link, hides without a repo', async () => {
  // A loader whose fake React COLLECTS effects so the pill's fetch runs.
  const effects = []
  const react = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
    Fragment: 'F',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, (v) => {}],
    useEffect: (fn) => { effects.push(fn) },
  }
  let mod
  globalThis.window = {
    __ModuleLoader__: {
      load: (h) => {
        mod = h.factory((s) => {
          if (s === 'react') return react
          if (s === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
          throw new Error('unexpected require: ' + s)
        })
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  const { BranchPill } = mod._internal
  const savedFetch = globalThis.fetch
  const mkProps = (cwd) => ({
    sessionId: 's1',
    useSessions: (sel) => sel({ current: 's1', byId: { s1: { cwd } } }),
  })
  const flush = async () => {
    const cleanups = []
    for (let round = 0; round < 4; round++) {
      const pending = effects.splice(0)
      for (const fn of pending) {
        const r = fn()
        if (r && typeof r.then === 'function') await r
        else if (typeof r === 'function') cleanups.push(r)
      }
      await new Promise((r) => setTimeout(r, 2))
    }
    return () => { for (const fn of cleanups) { try { fn() } catch (e) {} } }
  }
  try {
    // First mount runs the poll effect; the fake React's state is frozen, so
    // assert against the module cache the effect fills: a remount reads it.
    globalThis.fetch = async (url) => {
      const u = String(url)
      if (u.startsWith('/wo-github/branch')) return { ok: true, json: async () => ({ branch: 'feature/x', sha: null, pending: 3 }) }
      if (u.startsWith('/wo-github/locate')) return { ok: true, json: async () => ({ git: true, slug: 'o/r' }) }
      return { ok: false, json: async () => ({}) }
    }
    BranchPill(mkProps('/w/repo'))
    const unmountRepo = await flush()
    const tree = BranchPill(mkProps('/w/repo'))
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.includes('feature/x'), 'branch label rendered')
    const badge = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchpill-badge'))
    assert.equal(badge !== undefined && textOf(badge), '3', 'pending count badge rendered')
    const anchor = flatten(tree).find((n) => n.type === 'a')
    assert.ok(anchor !== undefined, 'pill links to the branch tree')
    assert.equal(anchor.props.href, 'https://github.com/o/r/tree/feature/x')

    // no repo: the pill renders nothing
    effects.length = 0
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ branch: null, sha: null }) })
    BranchPill(mkProps('/w/plain'))
    const unmountPlain = await flush()
    assert.equal(BranchPill(mkProps('/w/plain')), null)
    unmountRepo()
    unmountPlain()
  } finally {
    globalThis.fetch = savedFetch
    try { unmountRepo !== undefined && unmountRepo() } catch (e) {}
    try { unmountPlain !== undefined && unmountPlain() } catch (e) {}
    delete globalThis.window
  }
})

test('client PendingPane: groups, row checkbox, disabled commit without stages', async () => {
  const effects = []
  const unmounts = []
  // Stateful fake React: slots persist across renders so the pane's fetch
  // lands in state and the NEXT render shows the ready view.
  let hookIdx = 0
  const slots = []
  const react = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
    Fragment: 'F',
    useState: (initial) => {
      const i = hookIdx++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  const renderPane = (props) => { hookIdx = 0; return mod._internal.PendingPane(props) }
  let mod
  globalThis.window = {
    __ModuleLoader__: {
      load: (h) => {
        mod = h.factory((s) => {
          if (s === 'react') return react
          if (s === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
          throw new Error('unexpected require: ' + s)
        })
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  const savedFetch = globalThis.fetch
  const flush = async () => {
    for (let round = 0; round < 4; round++) {
      for (const fn of effects.splice(0)) {
        const r = fn()
        if (r && typeof r.then === 'function') await r
        else if (typeof r === 'function') unmounts.push(r)
      }
      await new Promise((r) => setTimeout(r, 2))
    }
  }
  try {
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/wo-github/pending?')) {
        return { ok: true, json: async () => ({
          count: 2,
          files: [
            { file: 'staged.txt', staged: true, unstaged: false, untracked: false, status: 'M', stagedCounts: { additions: 2, deletions: 1 } },
            { file: 'dirty.txt', staged: false, unstaged: true, untracked: false, status: 'M', unstagedCounts: { additions: 5, deletions: 0 } },
          ],
        }) }
      }
      return { ok: false, json: async () => ({}) }
    }
    // Mini-React never executes function-typed elements; resolve them so the
    // primitive fakes (Checkbox, Button) actually render.
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    renderPane({ loc: { path: '/w/repo' } })
    await flush()
    const tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('Staged')), 'staged group present')
    assert.ok(texts.some((t) => t.includes('Unstaged')), 'unstaged group present')
    assert.ok(texts.includes('staged.txt') && texts.includes('dirty.txt'), 'file rows rendered')
    // one file staged, but the empty summary keeps Commit disabled
    const commitBtn = flatten(tree).find((n) => n.type === 'button' && textOf(n).startsWith('Commit'))
    assert.ok(commitBtn !== undefined, 'commit button rendered')
    assert.equal(commitBtn.props.disabled, true, 'empty summary keeps commit disabled')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('partialHunkPatch: one selected line; sibling deletions become context, sibling additions drop', () => {
  const mod = loadClient()
  const { partialHunkPatch } = mod._internal
  const hunk = {
    head: '@@ -1,5 +1,5 @@',
    lines: [' keep', '-drop me', '-keep me', '+added pick', '+skip me', ' tail'],
  }
  // Select '+added pick' (src index 3): unselected deletions stay in the
  // index as context; the unselected addition is omitted entirely.
  const patch = partialHunkPatch(hunk, 3)
  assert.equal(patch, '@@ -1,5 +1,5 @@\n keep\n drop me\n keep me\n+added pick\n tail\n')
})

test('PendingPane layout: side-by-side list and diff; first file auto-selected', async () => {
  const effects = []
  let hookIdx = 0
  const slots = []
  const react = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
    Fragment: 'F',
    useState: (initial) => {
      const i = hookIdx++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  let mod
  globalThis.window = {
    __ModuleLoader__: { load: (h) => { mod = h.factory((s) => {
      if (s === 'react') return react
      if (s === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
      throw new Error('unexpected require: ' + s)
    }) } },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  globalThis.document = mkDocument()
  ;(0, eval)(readFileSync(CLIENT_BUNDLE_PATH, 'utf8'))
  const savedFetch = globalThis.fetch
  const unmounts = []
  const flush = async () => {
    for (let round = 0; round < 4; round++) {
      for (const fn of effects.splice(0)) {
        const r = fn()
        if (r && typeof r.then === 'function') await r
        else if (typeof r === 'function') unmounts.push(r)
      }
      await new Promise((r) => setTimeout(r, 2))
    }
  }
  try {
    // A fake diffView whose component READS hunk.lines: passing the parser's
    // rows-shaped hunks (the live #2 crash) throws here instead.
    const fakeDiffView = {
      diffFileComponent: () => (props) => ({
        type: 'div',
        props: { className: 'fakediff', 'data-mode': props.mode },
        children: (props.hunks ?? []).flatMap((h) => h.lines.map((l) => l.slice(1))),
      }),
    }
    mod.apply({
      inject: mod.inject,
      workspaceOverview: { registerTab: () => () => {} },
      slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
      get: (n) => (n === 'diffView' ? fakeDiffView : undefined),
      provide: () => {},
    })
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/wo-github/pending?')) {
        return { ok: true, json: async () => ({ count: 2, files: [
          { file: 'alpha.txt', staged: true, unstaged: false, untracked: false, status: 'M' },
          { file: 'beta.txt', staged: false, unstaged: true, untracked: false, status: 'M' },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending-diff?')) {
        return { ok: true, json: async () => ({
          staged: 'diff --git a/alpha.txt b/alpha.txt\nindex 111..222 100644\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,2 +1,2 @@\n context\n-old alpha\n+new alpha\n',
          unstaged: 'diff --git a/alpha.txt b/alpha.txt\nindex 222..333 100644\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -9,1 +9,1 @@\n tail ctx\n-old tail\n+new tail\n',
        }) }
      }
      return { ok: false, json: async () => ({}) }
    }
    const renderPane = (props) => { hookIdx = 0; return mod._internal.PendingPane(props) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    renderPane({ loc: { path: '/w/repo' } })
    await flush()                                   // list ready
    resolve(renderPane({ loc: { path: '/w/repo' } }))   // mounts PendingFile (registers its fetch)
    await flush()                                   // diff lands in PendingFile's state
    const tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    const byClass = (cls) => flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
    assert.equal(byClass('wog-pending-layout').length, 1, 'the two-pane layout renders')
    assert.equal(byClass('wog-pending-side').length, 1, 'the list side renders')
    assert.equal(byClass('wog-pending-main').length, 1, 'the diff side renders alongside the list')
    const active = byClass('wog-pendingrow-active')
    assert.equal(active.length, 1, 'exactly one selected row')
    assert.ok(textOf(active[0]).includes('alpha.txt'), 'the first file is auto-selected')
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('new alpha')), 'the staged hunk renders through the diff component')
    assert.ok(texts.some((t) => t.includes('new tail')), 'the unstaged hunk renders through the diff component')
    assert.ok(texts.some((t) => t.includes('Staged changes')), 'the staged section is titled')
    assert.ok(texts.some((t) => t.includes('Unstaged changes')), 'the unstaged section is titled')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})
