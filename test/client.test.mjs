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
      { type: 'input', props: { type: 'checkbox', checked: props.checked, disabled: props.disabled, onChange: props.onChange }, children: [] },
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
    assert.equal(untrackedDiff.body.combined, '', 'untracked has no combined patch')

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
    // the combined patch (HEAD vs worktree) carries EVERYTHING: the one
    // view the client renders with per-line stage marks
    assert.match(afterLine.body.combined, /HEAD EDIT/)
    assert.match(afterLine.body.combined, /SECOND EDIT/)
    assert.match(afterLine.body.combined, /TAIL EDIT/)

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
  globalThis.fetch = async (url) => {
    if (String(url).includes('/wo-github/commit?')) {
      return { ok: true, json: async () => ({ sha: 'abc1234', message: 'm', author: 'A', date: '2026-01-01T00:00:00Z', additions: 1, deletions: 0, files: [{ filename: 'f', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b' }] }) }
    }
    return { ok: true, json: async () => ({ source: 'local', hasMore: false, commits: [{ sha: 'abc1234', message: 'm', author: 'A', date: '2026-01-01T00:00:00Z' }] }) }
  }
  // pass 1: history layout (page + pick + commits state/effect + detail state/effect)
  counting = true; counts.push(0); hookIdx = 0
  CommitsPane({ loc })
  const beforeSelection = counts[0]
  assert.equal(beforeSelection, 6, 'page + pick + commits state/effect + detail state/effect')
  // pass 2: a commit is picked — the hook count must not change
  slots[1] = { sha: 'abc1234', file: 'f' }
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

    // stashed changes surface in the branch route — but ONLY this
    // branch's entries count
    writeFileSync(pathJoin(repo.dir, 'c.txt'), 'stashed away\n')
    repo.git('stash', 'push', '--include-untracked', '-m', 'test stash')
    repo.git('checkout', '-q', '-b', 'side')
    writeFileSync(pathJoin(repo.dir, 'c.txt'), 'other branch\n')
    repo.git('stash', 'push', '--include-untracked', '-m', 'side stash')
    repo.git('checkout', '-q', 'main')
    const withStash = await h.get('/wo-github/branch?path=' + encodeURIComponent(repo.dir))
    assert.equal(withStash.body.stashes, 1, 'only THIS branch\'s stash counts')
    const onSide = await h.get('/wo-github/stashes?path=' + encodeURIComponent(repo.dir))
    assert.equal(onSide.body.entries.length, 2, 'the full stash list still sees both')
    repo.git('stash', 'pop')
    repo.git('branch', '-D', 'side')

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
  const overviewCalls = []
  mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {}, requestTab: (id) => { overviewCalls.push(id) } }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
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
      if (u.startsWith('/wo-github/branch')) return { ok: true, json: async () => ({ branch: 'feature/x', sha: null, pending: 3, stashes: 2 }) }
      if (u.startsWith('/wo-github/locate')) return { ok: true, json: async () => ({ git: true, slug: 'o/r' }) }
      return { ok: false, json: async () => ({}) }
    }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    BranchPill(mkProps('/w/repo'))
    const unmountRepo = await flush()
    const tree = resolve(BranchPill(mkProps('/w/repo')))
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.includes('feature/x'), 'branch label rendered')
    const badge = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchpill-badge'))
    assert.equal(badge !== undefined && textOf(badge), '3', 'pending count badge rendered')
    // With pending changes the pill is a BUTTON that jumps to the Pending
    // pane (not an outbound link): the click records the pane request.
    const button = flatten(tree).find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.split(' ').includes('wog-branchpill'))
    const anchor = flatten(tree).find((n) => n.type === 'a')
    assert.ok(button !== undefined && anchor === undefined, 'dirty worktree: pill button, no link')
    const chevron = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchchev'))
    assert.ok(chevron !== undefined, 'the branch switcher chevron renders beside the pill')
    // stashed changes: amber bag icon between the pill and the chevron;
    // the COUNT lives in the tooltip, not as text beside it
    const stash = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchstash'))
    assert.ok(stash !== undefined, 'the stash indicator renders')
    assert.equal(textOf(stash), '', 'no numeric count beside the icon')
    assert.match(stash.props.title, /^this branch has stashed changes/, 'simple tooltip')
    assert.ok((stash.children ?? []).some((c) => c.type === 'svg'), 'the bag glyph renders')
    assert.ok(String(button.props.title).includes('open Pending'))
    button.props.onClick()
    assert.equal(mod._internal.paneRequestOf(), 'pending', 'the click requested the pending pane')
    assert.deepEqual(overviewCalls, ['github'], 'the click also requested the GitHub subtab (the overview page owns that state)')

    // TOGGLE: overview already open on the GitHub subtab -> the pill closes
    // it (selects the conversation's first view) instead of re-opening.
    let chatClicked = false
    const strip = {
      querySelector: (sel) => sel === 'button[aria-selected="true"]' ? { textContent: 'Workspace Overview' } : null,
      querySelectorAll: () => [{ textContent: 'Workspace Overview', click: () => {} }],
      firstElementChild: { click: () => { chatClicked = true } },
    }
    const savedDocument = globalThis.document
    globalThis.document = Object.assign(mkDocument(), { querySelector: () => strip })
    mod._internal.requestPane(undefined)   // clear the previous request
    let activeSubtab = 'github'
    mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {}, activeTab: () => activeSubtab }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
    button.props.onClick()
    assert.equal(chatClicked, true, 'the first view (chat) tab was clicked to close the panel')
    assert.equal(mod._internal.paneRequestOf(), undefined, 'no new pane request while toggling off')
    // on a DIFFERENT subtab the click still opens GitHub/Pending
    activeSubtab = 'overview'
    button.props.onClick()
    assert.equal(mod._internal.paneRequestOf(), 'pending', 'different subtab: opens pending again')
    globalThis.document = savedDocument

    // FALLBACK: an older workspace-overview without requestTab still lands
    // on GitHub by clicking the subtab button in the DOM
    let githubSubtabClicked = false
    mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {} }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
    mod._internal.requestPane(undefined)
    globalThis.document = Object.assign(mkDocument(), {
      querySelector: () => undefined,
      querySelectorAll: () => [{ textContent: 'GitHub', click: () => { githubSubtabClicked = true } }],
    })
    button.props.onClick()
    assert.equal(githubSubtabClicked, true, 'without the facade, the GitHub subtab button is clicked directly')
    assert.equal(mod._internal.paneRequestOf(), 'pending', 'the pane request still fires')
    globalThis.document = savedDocument

    // clean worktree, no stashes: the pill still OPENS the panel (Pending)
    effects.length = 0
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ branch: 'feature/x', sha: null, pending: 0, stashes: 0 }) })
    BranchPill(mkProps('/w/repo'))
    const unmountClean = await flush()
    let cleanTree = resolve(BranchPill(mkProps('/w/repo')))
    const cleanPill = flatten(cleanTree).find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.split(' ').includes('wog-branchpill'))
    assert.ok(cleanPill !== undefined, 'clean worktree: still a button')
    assert.equal(flatten(cleanTree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchstash')), undefined, 'no stash indicator without stashes')
    mod._internal.requestPane(undefined)
    cleanPill.props.onClick()
    assert.equal(mod._internal.paneRequestOf(), 'pending', 'clean and no stash: still opens Pending')
    unmountClean()

    // clean worktree WITH stashes: the pill routes to the STASH pane, and
    // the bag indicator opens it too
    effects.length = 0
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ branch: 'feature/x', sha: null, pending: 0, stashes: 1 }) })
    BranchPill(mkProps('/w/repo'))
    const unmountStashed = await flush()
    cleanTree = resolve(BranchPill(mkProps('/w/repo')))
    const stashPill = flatten(cleanTree).find((n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.split(' ').includes('wog-branchpill'))
    mod._internal.requestPane(undefined)
    stashPill.props.onClick()
    assert.equal(mod._internal.paneRequestOf(), 'stash', 'clean with stashes: pill opens the Stash pane')
    const bag = flatten(cleanTree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchstash'))
    assert.ok(bag !== undefined && bag.props.onClick === undefined, 'the bag is a plain indicator, not clickable')
    unmountStashed()

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
            { file: 'staged.txt', staged: true, unstaged: false, untracked: false, status: 'M', stagedCounts: { additions: 2, deletions: 0 } },
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
    // ONE flat list (no staged/unstaged split)
    const titles = flatten(tree)
      .filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-pendinggroup-title'))
      .map(textOf)
    assert.deepEqual(titles, ['Changes · 2'])
    assert.ok(texts.includes('staged.txt') && texts.includes('dirty.txt'), 'file rows rendered')
    // three-state boxes: fully staged -> check, nothing staged -> empty
    const tris = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-tri'))
    assert.equal(tris.length, 2, 'one tri-state per file')
    const staged = tris.find((t) => textOf(t) === '\u2713')
    const empty = tris.find((t) => textOf(t) === '\u00a0')
    assert.ok(staged !== undefined && empty !== undefined, 'check for fully staged, empty for unstaged')
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
      throw new Error('unexpected require: ' + spec)
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
          { file: 'alpha.txt', staged: true, unstaged: false, untracked: false, status: 'M ', stagedCounts: { additions: 2, deletions: 0 } },
          { file: 'beta.txt', staged: false, unstaged: true, untracked: false, status: ' M' },
          { file: 'fresh.txt', staged: false, unstaged: true, untracked: true, status: '??' },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending-diff?')) {
        // combined = both distant hunks; index holds only the first one
        return { ok: true, json: async () => ({
          combined: 'diff --git a/alpha.txt b/alpha.txt\nindex 111..222 100644\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,3 +1,3 @@\n top ctx\n-old alpha\n+new alpha\n@@ -30,3 +30,3 @@\n tail ctx\n-old alpha tail\n+new alpha tail\n',
          staged: 'diff --git a/alpha.txt b/alpha.txt\nindex 111..999 100644\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,3 +1,3 @@\n top ctx\n-old alpha\n+new alpha\n',
          unstaged: 'diff --git a/alpha.txt b/alpha.txt\nindex 999..222 100644\n--- a/alpha.txt\n+++ b/alpha.txt\n@@ -30,3 +30,3 @@\n tail ctx\n-old alpha tail\n+new alpha tail\n',
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
    let tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    const byClass = (cls) => flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
    assert.equal(byClass('wog-pending-layout').length, 1, 'the two-pane layout renders')
    assert.equal(byClass('wog-pending-side').length, 1, 'the list side renders')
    assert.equal(byClass('wog-pending-main').length, 1, 'the diff side renders alongside the list')
    const active = byClass('wog-pendingrow-active')
    assert.equal(active.length, 1, 'exactly one selected row')
    assert.ok(textOf(active[0]).includes('alpha.txt'), 'the staged file auto-selects first (GitHub Desktop order)')
    // ONE combined whole-file diff (not staged/unstaged sections): both
    // distant hunks land in a single view, and the chip reports how many
    // changed lines the index already holds.
    let diffs = byClass('fakediff')
    assert.equal(diffs.length, 1, 'one single combined diff view')
    let diffText = flatten(diffs[0]).map(textOf).join('')
    assert.ok(diffText.includes('new alpha') && diffText.includes('new alpha tail'), 'both distant hunks in ONE continuous view')
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('2/4 staged')), 'the chip shows the staged fraction (2 of 4 changed lines)')
    assert.ok(texts.some((t) => t === '+2'), 'the row shows the staged additions (+2)')
    assert.ok(!texts.some((t) => t === '+0') && !texts.some((t) => t === '−0'), 'zero counts stay hidden')
    assert.ok(!texts.some((t) => t === '−2'), 'a zero-deletion file shows no red count')

    // Clicking the other file's row keeps the single combined view.
    const betaRow = flatten(tree).find((n) => typeof n.props?.className === 'string'
      && n.props.className.split(' ').includes('wog-pendingrow') && textOf(n).includes('beta.txt'))
    betaRow.props.onClick()
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()                                   // PendingFile refetches for the new file
    tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    diffs = byClass('fakediff')
    assert.equal(diffs.length, 1, 'still exactly one diff view after switching rows')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('PendingFile: per-line checkmarks, section checkbox, and the exact patches they post', async () => {
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
  const posts = []
  // A consistent world: head 42 lines; index holds the head-region change
  // (staged); the tail region is still unstaged.
  const HEADH = 'diff --git a/code.js b/code.js\nindex 111..999 100644\n--- a/code.js\n+++ b/code.js\n'
  const combinedPatch = HEADH
    + '@@ -1,3 +1,3 @@\n ctx\n-old head\n+new head\n'
    + '@@ -40,3 +40,4 @@\n tail\n-old tail\n+new tail\n+added tail\n tail end\n'
  const stagedPatch = HEADH + '@@ -1,3 +1,3 @@\n ctx\n-old head\n+new head\n ctx2\n'
  const unstagedPatch = HEADH + '@@ -40,3 +40,4 @@\n tail\n-old tail\n+new tail\n+added tail\n tail end\n'
  const indexLines = ['ctx', 'new head', 'ctx2']
  for (let n = 4; n <= 39; n += 1) indexLines.push('filler ' + n)
  indexLines.push('tail', 'old tail', 'tail end')
  const indexText = indexLines.join('\n') + '\n'
  try {
    const captured = []
    const fakeDiffView = {
      diffFileComponent: () => (props) => {
        captured.push(props)
        return { type: 'div', props: { className: 'fakediff' }, children: [] }
      },
    }
    mod.apply({
      inject: mod.inject,
      workspaceOverview: { registerTab: () => () => {} },
      slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
      get: (n) => (n === 'diffView' ? fakeDiffView : undefined),
      provide: () => {},
    })
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) })
        return { ok: true, json: async () => ({ count: 1, files: [
          { file: 'code.js', staged: true, unstaged: true, untracked: false, status: 'M' },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending?')) {
        return { ok: true, json: async () => ({ count: 1, files: [
          { file: 'code.js', staged: true, unstaged: true, untracked: false, status: 'M' },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending-diff?')) {
        return { ok: true, json: async () => ({ combined: combinedPatch, staged: stagedPatch, unstaged: unstagedPatch, indexText }) }
      }
      return { ok: false, json: async () => ({}) }
    }
    const renderPane = (props) => { hookIdx = 0; return mod._internal.PendingPane(props) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    const props = captured[captured.length - 1]
    assert.ok(props !== undefined, 'the diff component received its props')
    assert.equal(props.hunks.length, 2, 'the COMBINED patch feeds ONE diff view')

    // Per-line checkmarks: hunk 0 (index already holds it) is fully
    // staged; hunk 1 is not; context lines carry no mark.
    const mark = (hunkIndex, src) => props.lineMark(hunkIndex, src)
    assert.equal(mark(0, 0), undefined, 'context: no mark')
    assert.equal(mark(0, 1), true, 'staged deletion (head line 2)')
    assert.equal(mark(0, 2), true, 'staged addition (came from the index)')
    assert.equal(mark(1, 1), false, 'unstaged deletion')
    assert.equal(mark(1, 2), false, 'unstaged addition')
    assert.equal(mark(1, 3), false, 'unstaged addition')
    assert.equal(mark(1, 4), undefined, 'context: no mark')

    // Section marks report all-lines-staged as a boolean (rendered by the
    // diff component in the section column, on the section's first row).
    assert.equal(props.hunkMark(0), true, 'hunk 0 fully staged')
    assert.equal(props.hunkMark(1), false, 'hunk 1 has unstaged lines')
    const stagingPatchOf = mod._internal.stagingPatchOf
    const stagedParts = stagingPatchOf(stagedPatch)
    const unstagedParts = stagingPatchOf(unstagedPatch)

    // Unstage the staged deletion: re-insert 'old head' before index line 3,
    // patched against exact index content (never a reversed partial).
    props.onLineToggle(0, 1)
    await flush()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].body.patch, HEADH + '@@ -1,5 +1,6 @@\n ctx\n new head\n+old head\n ctx2\n filler 4\n filler 5\n')
    assert.equal(posts[0].body.reverse, false, 'unstaging patches the index directly')

    // Unstage the staged addition: remove index line 2 ('new head').
    props.onLineToggle(0, 2)
    await flush()
    assert.equal(posts.length, 2)
    assert.equal(posts[1].body.patch, HEADH + '@@ -1,5 +1,4 @@\n ctx\n-new head\n ctx2\n filler 4\n filler 5\n')
    assert.equal(posts[1].body.reverse, false)

    // Stage an unstaged deletion: head 41 is untouched by the staged patch,
    // so it maps to index 41, then forward partial of the unstaged hunk.
    props.onLineToggle(1, 1)
    await flush()
    assert.equal(posts.length, 3)
    assert.equal(posts[2].body.patch, unstagedParts.header + mod._internal.partialHunkPatch(unstagedParts.hunks[0], 1))
    assert.equal(posts[2].body.reverse, false, 'unstaged line toggled ON')

    // Stage an unstaged addition: worktree 42 is an unstaged add; forward.
    props.onLineToggle(1, 3)
    await flush()
    assert.equal(posts.length, 4)
    assert.equal(posts[3].body.patch, unstagedParts.header + mod._internal.partialHunkPatch(unstagedParts.hunks[0], 3))
    assert.equal(posts[3].body.reverse, false)

    // STALE-HANDLER regression: a second rapid click can arrive through
    // the still-mounted pre-action props (React commits asynchronously).
    // The synchronous busy guard must drop it instead of posting a patch
    // built from pre-action state.
    props.onLineToggle(1, 2)   // first click: stage '+new tail'
    props.onLineToggle(1, 3)   // second click from the SAME stale props
    await flush()
    assert.equal(posts.length, 5, 'the stale second click is dropped, not posted')
    assert.equal(posts[4].body.patch, unstagedParts.header + mod._internal.partialHunkPatch(unstagedParts.hunks[0], 2))
    props.onHunkToggle(0)
    await flush()
    assert.equal(posts.length, 6)
    assert.equal(posts[5].body.patch, stagedParts.header + stagedParts.hunks[0].raw)
    assert.equal(posts[5].body.reverse, true)

    // Section mark click on the unstaged section: stage ALL of it at once.
    props.onHunkToggle(1)
    await flush()
    assert.equal(posts.length, 7)
    assert.equal(posts[6].body.patch, unstagedParts.header + unstagedParts.hunks[0].raw)
    assert.equal(posts[6].body.reverse, false)
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('staging controller end-to-end: every toggle path applies against real git', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogctrl-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const base = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  writeFileSync(pathJoin(dir, 'README.md'), base)
  git('add', '.'); git('commit', '-qm', 'base')
  const wt = base.split('\n')
  wt.splice(1, 0, 'MARKER')
  wt[28] = 'CHANGED 28'
  wt[29] = 'CHANGED 29'
  writeFileSync(pathJoin(dir, 'README.md'), wt.join('\n'))

  const mod = loadClient()
  const { stagingController } = mod._internal
  // fresh controller from the REAL host diff; toggles POST through the
  // REAL apply route; the next controller reads the refreshed state.
  const diffOf = async () => (await h.get('/wo-github/pending-diff?path=' + encodeURIComponent(dir) + '&file=README.md')).body
  const toggleLine = async (hunkIndex, src, log) => {
    const controller = stagingController(await diffOf())
    const action = controller.toggleLinePatch(hunkIndex, src)
    assert.ok(action !== undefined, log + ': action mapped')
    const res = await h.post('/wo-github/pending-stage-hunk', { path: dir, patch: action.patch, reverse: action.reverse })
    assert.equal(res.status, 200, log + ': applied')
  }
  const toggleHunk = async (hunkIndex, log) => {
    const controller = stagingController(await diffOf())
    const action = controller.toggleHunkPatch(hunkIndex)
    assert.ok(action !== undefined, log + ': action mapped')
    const res = await h.post('/wo-github/pending-stage-hunk', { path: dir, patch: action.patch, reverse: action.reverse })
    assert.equal(res.status, 200, log + ': applied')
  }
  try {
    // hunk 0 = +MARKER at src 1; hunk 1 = two replaces
    await toggleLine(0, 1, 'stage +MARKER')
    await toggleLine(0, 1, 'unstage +MARKER (index-content patch)')
    await toggleLine(0, 1, 're-stage +MARKER')
    // bottom hunk: ctx ctx ctx -28 -29 +28c +29c ctx
    await toggleLine(1, 3, 'stage -line 28')
    await toggleLine(1, 5, 'stage +CHANGED 28 (index shifted)')
    await toggleLine(1, 3, 'unstage -line 28 (staged del, direct)')
    await toggleLine(1, 6, 'unstage +CHANGED 29 (mapped staged add)')
    await toggleLine(1, 4, 'stage -line 29 (sibling del also staged)')
    await toggleLine(1, 3, 'unstage -line 28 while -line 29 staged (the regression)')
    await toggleLine(1, 3, 're-stage -line 28')
    await toggleHunk(0, 'section top fully staged -> unstage all')
    await toggleHunk(0, 'section top -> stage all')
    await toggleHunk(1, 'section bottom -> stage rest')
    await toggleHunk(1, 'section bottom -> unstage all')
    // per-line marks agree with git at every step of a full sweep
    const controller = stagingController(await diffOf())
    assert.equal(controller.hunks.length, 2)
    assert.equal(controller.lineMark(0, 1), true, 'MARKER staged again by the section stage-all')
    for (const e of controller.entriesByHunk[1]) {
      if (e.sign === ' ') continue
      assert.equal(controller.lineMark(1, e.src), false, 'bottom section ends fully unstaged: ' + e.text)
    }
    git('reset', '-q')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('staging mappings: kept lines walk between HEAD, index and worktree space', () => {
  const mod = loadClient()
  const { stagingPatchOf, mapOldToNew, mapNewToOld } = mod._internal
  // staged patch replaces head lines 2-3 with one line (net -1)
  const staged = stagingPatchOf('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,3 @@\n a\n-b\n-c\n+x\n d\n')
  assert.equal(mapOldToNew(staged.hunks, 1), 1, 'before the hunk: identity')
  assert.equal(mapOldToNew(staged.hunks, 4), 3, 'after the hunk: d shifts up by the net delta')
  assert.equal(mapOldToNew(staged.hunks, 2), undefined, 'a deleted line has no index counterpart')
  // unstaged patch inserts one line at worktree 2 (net +1)
  const unstaged = stagingPatchOf('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n+b\n c\n')
  assert.equal(mapNewToOld(unstaged.hunks, 3), 2, 'worktree 3 is index 2 after the insert')
  assert.equal(mapNewToOld(unstaged.hunks, 1), 1, 'before the hunk: identity')
  assert.equal(mapNewToOld(unstaged.hunks, 2), undefined, 'an inserted line has no index counterpart')
})

test('tri-state file checkbox and the immediate diff refresh', async () => {
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
  const combined = 'diff --git a/code.js b/code.js\n--- a/code.js\n+++ b/code.js\n@@ -1,2 +1,2 @@\n ctx\n-a\n+b\n'
  let diffGets = 0
  const stagePosts = []
  try {
    const fakeDiffView = { diffFileComponent: () => () => ({ type: 'div', props: { className: 'fakediff' }, children: [] }) }
    mod.apply({
      inject: mod.inject,
      workspaceOverview: { registerTab: () => () => {} },
      slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
      get: (n) => (n === 'diffView' ? fakeDiffView : undefined),
      provide: () => {},
    })
    let mm = true
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        stagePosts.push(JSON.parse(init.body))
        mm = false   // unstaging the dash clears the index side
        return { ok: true, json: async () => ({ count: 1, files: [
          { file: 'code.js', staged: false, unstaged: true, untracked: false, status: ' M' },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending?')) {
        return { ok: true, json: async () => ({ count: 1, files: [
          { file: 'code.js', staged: mm, unstaged: true, untracked: false, status: 'MM', stagedCounts: { additions: 0, deletions: 3 } },
        ] }) }
      }
      if (String(url).startsWith('/wo-github/pending-diff?')) {
        diffGets += 1
        return { ok: true, json: async () => ({ combined, staged: mm ? combined : '', unstaged: combined, indexText: 'ctx\nb\n' }) }
      }
      return { ok: false, json: async () => ({}) }
    }
    const renderPane = (props) => { hookIdx = 0; return mod._internal.PendingPane(props) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    let tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    // partially staged file -> the DASH in the tri-state box
    const tri = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-tri-partial'))
    assert.ok(tri !== undefined, 'MM file shows the partial dash')
    assert.equal(textOf(tri), '\u2013')
    assert.equal(tri.props['aria-checked'], 'mixed')
    const rowTexts = flatten(tree).map(textOf)
    assert.ok(rowTexts.some((t) => t === '−3'), 'deletions-only staged counts show the red number')
    assert.ok(!rowTexts.some((t) => t === '+0'), 'no green +0 beside it')
    const diffGetsBefore = diffGets
    // clicking the dash UNSTAGES the whole file...
    tri.props.onClick()
    await flush()
    assert.equal(stagePosts.length, 1)
    assert.equal(stagePosts[0].file, 'code.js')
    assert.equal(stagePosts[0].stage, false, 'dash click unchecks (unstages all)')
    // ...and the diff refetches IMMEDIATELY (refresh counter), not on the
    // next 5s poll tick
    tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    assert.ok(diffGets > diffGetsBefore, 'the diff refetched right after the file stage action')
    const empty = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-tri-none'))
    assert.ok(empty !== undefined, 'the box is empty after unstaging')
    // clicking the empty box stages everything
    empty.props.onClick()
    await flush()
    assert.equal(stagePosts.length, 2)
    assert.equal(stagePosts[1].stage, true, 'empty click checks all (stages the file)')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('History layout: commits | files | diff, all visible and clickable', async () => {
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
    const captured = []
    const fakeDiffView = {
      diffFileComponent: () => (props) => {
        captured.push(props)
        return { type: 'div', props: { className: 'fakediff' }, children: (props.hunks ?? []).flatMap((h) => h.lines.map((l) => l.slice(1))) }
      },
    }
    mod.apply({
      inject: mod.inject,
      workspaceOverview: { registerTab: () => () => {} },
      slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
      get: (n) => (n === 'diffView' ? fakeDiffView : undefined),
      provide: () => {},
    })
    const readmeCommit = { sha: 'a'.repeat(40), message: 'first: add readme', author: 'A', date: '2026-01-01T00:00:00Z' }
    const codeCommit = { sha: 'b'.repeat(40), message: 'second: add code', author: 'B', date: '2026-01-02T00:00:00Z' }
    globalThis.fetch = async (url) => {
      if (String(url).includes('/wo-github/commit?')) {
        const isReadme = String(url).includes('sha=' + 'a'.repeat(40))
        return { ok: true, json: async () => (isReadme
          ? { sha: readmeCommit.sha, message: readmeCommit.message, author: 'A', date: readmeCommit.date, additions: 1, deletions: 0, files: [
              { filename: 'README.md', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+# hello readme' }] }
          : { sha: codeCommit.sha, message: codeCommit.message, author: 'B', date: codeCommit.date, additions: 2, deletions: 1, files: [
              { filename: 'code.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-old code\n+new code' },
              { filename: 'other.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n line\n+extra' }] }) }
      }
      return { ok: true, json: async () => ({ source: 'local', hasMore: false, commits: [codeCommit, readmeCommit] }) }
    }
    const renderPane = (props) => { hookIdx = 0; return mod._internal.CommitsPane(props) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    const byClass = (tree, cls) => flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
    resolve(renderPane({ loc: { path: '/w/repo' } }))
    await flush()
    let tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    // three regions at once
    assert.equal(byClass(tree, 'wog-history-layout').length, 1)
    assert.equal(byClass(tree, 'wog-history-commits').length, 1, 'commit list column')
    assert.equal(byClass(tree, 'wog-history-files').length, 1, 'changed-files column')
    assert.equal(byClass(tree, 'wog-history-diff').length, 1, 'diff column beside them')
    assert.equal(byClass(tree, 'wog-commit-row').length, 2, 'both commits listed')
    // newest (code commit) auto-selected; its FIRST file's diff shows
    assert.ok(byClass(tree, 'wog-commit-row-active').length === 1)
    assert.ok(textOf(byClass(tree, 'wog-commit-row-active')[0]).includes('second: add code'))
    let texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('new code')), "the auto-selected commit's first file diff renders")
    // clicking the OTHER file in the list switches the diff
    const otherRow = byClass(tree, 'wog-history-filerow').find((r) => textOf(r).includes('other.txt'))
    otherRow.props.onClick()
    tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('extra')), 'the clicked file\'s diff replaces the previous one')
    assert.ok(!texts.some((t) => t.includes('new code')), 'the previous file\'s diff is gone')
    // clicking the OTHER commit swaps files AND diff
    const readmeRow = byClass(tree, 'wog-commit-row').find((r) => textOf(r).includes('first: add readme'))
    readmeRow.props.onClick()
    resolve(renderPane({ loc: { path: '/w/repo' } }))   // queues the new commit's detail fetch
    await flush()
    tree = resolve(renderPane({ loc: { path: '/w/repo' } }))
    texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('hello readme')), 'the selected commit\'s file diff renders')
    assert.ok(!texts.some((t) => t.includes('extra')), 'the previous commit\'s diff is gone')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('host branches/checkout/create-branch: list, dirty guard, pending carries', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const repo = mkRepo()
  try {
    const enc = encodeURIComponent(repo.dir)
    repo.git('branch', 'feature/x')
    const list = await h.get('/wo-github/branches?path=' + enc)
    assert.equal(list.status, 200)
    assert.equal(list.body.current, 'main')
    assert.deepEqual(list.body.branches, ['feature/x', 'main'])

    // dirty worktree: switching is REFUSED, creating carries the change
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'one and a half\n')
    const blocked = await h.post('/wo-github/checkout', { path: repo.dir, branch: 'feature/x' })
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.error, /clean worktree/)
    const created = await h.post('/wo-github/create-branch', { path: repo.dir, name: 'feature/y' })
    assert.equal(created.status, 200)
    assert.equal(created.body.branch, 'feature/y')
    const branch = await h.get('/wo-github/branch?path=' + enc)
    assert.equal(branch.body.branch, 'feature/y')
    assert.equal(branch.body.pending, 1, 'the pending change carried into the new branch')

    // guards: duplicate name, invalid name, unknown branch
    assert.equal((await h.post('/wo-github/create-branch', { path: repo.dir, name: 'main' })).status, 409)
    assert.equal((await h.post('/wo-github/create-branch', { path: repo.dir, name: 'not a branch' })).status, 400)
    assert.equal((await h.post('/wo-github/checkout', { path: repo.dir, branch: 'nope' })).status, 404)

    // clean worktree: switching works
    repo.git('add', '.')
    repo.git('commit', '-m', 'c2')
    const ok = await h.post('/wo-github/checkout', { path: repo.dir, branch: 'main' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.branch, 'main')
  } finally {
    repo.cleanup()
  }
})

test('branch pill switcher: menu lists branches, blocks switching when dirty, creates with pending', async () => {
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
  const posts = []
  const mkProps = (cwd) => ({
    sessionId: 's1',
    useSessions: (sel) => sel({ current: 's1', byId: { s1: { cwd } } }),
  })
  const renderPill = (props) => { hookIdx = 0; return mod._internal.BranchPill(props) }
  try {
    mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {} }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
    let liveBranch = 'main'
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body) })
        if (String(url).includes('/wo-github/create-branch')) {
          liveBranch = JSON.parse(init.body).name
          return { ok: true, json: async () => ({ branch: liveBranch }) }
        }
        return { ok: false, json: async () => ({ error: 'switching branches needs a clean worktree' }) }
      }
      if (String(url).includes('/wo-github/branches')) {
        return { ok: true, json: async () => ({ current: 'main', branches: ['feature/x', 'main'] }) }
      }
      return { ok: true, json: async () => ({ branch: liveBranch, sha: null, pending: 1 }) }
    }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    renderPill(mkProps('/w/repo'))
    await flush()
    let tree = resolve(renderPill(mkProps('/w/repo')))
    // open the switcher (the chevron lives inside the shared BranchSwitcher)
    const chevron = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchchev'))
    chevron.props.onClick()
    resolve(renderPill(mkProps('/w/repo')))   // queues the switcher's open-state effect
    await flush()   // branches land
    tree = resolve(renderPill(mkProps('/w/repo')))
    const menu = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchmenu'))
    assert.ok(menu !== undefined, 'the switcher menu opened')
    const items = flatten(menu).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchitem'))
    assert.equal(items.length, 2, 'both branches listed')
    const mainItem = items.find((n) => textOf(n).includes('main'))
    const featureItem = items.find((n) => textOf(n).includes('feature/x'))
    assert.equal(mainItem.props.disabled, true, 'current branch disabled (checked)')
    assert.ok(textOf(mainItem).includes('\u2713'), 'current branch carries the check')
    // DIRTY worktree: clicking a branch opens the GitHub Desktop CHOICE
    // (leave stashed here vs bring along), not a dead end
    assert.equal(featureItem.props.disabled, false, 'the branch is clickable when dirty')
    assert.match(featureItem.props.title, /choose what happens/)
    featureItem.props.onClick()
    tree = resolve(renderPill(mkProps('/w/repo')))
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('Leave my changes on main')), 'choice: leave (stash) option')
    assert.ok(texts.some((t) => t.includes('Bring my changes to feature/x')), 'choice: bring option')
    const bring = flatten(tree).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('keep the pending changes'))
    bring.props.onClick()
    await flush()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, '/wo-github/checkout')
    assert.equal(posts[0].body.branch, 'feature/x')
    assert.equal(posts[0].body.mode, 'carry', 'bring = carry the pending changes')
    // the carry POST failed in this fake, so the CHOICE stays open with
    // the error: pick the leave (stash) option from the same view
    tree = resolve(renderPill(mkProps('/w/repo')))
    assert.ok(flatten(tree).map(textOf).some((t) => t.includes('clean worktree')), 'git-style refusal shows in the menu')
    flatten(tree).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('stash all changes on this branch')).props.onClick()
    await flush()
    assert.equal(posts.length, 2)
    assert.equal(posts[1].body.mode, 'stash', 'leave = stash all changes here')
    // reopen the menu fresh (the checkout POSTs above failed on purpose in
    // this fake, so retry the list view) and create a branch instead
    tree = resolve(renderPill(mkProps('/w/repo')))
    flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchback')).props.onClick()
    tree = resolve(renderPill(mkProps('/w/repo')))
    const input = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchinput'))
    input.props.onChange({ target: { value: 'feature/y' } })
    tree = resolve(renderPill(mkProps('/w/repo')))
    const createBtn = flatten(tree).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('take your 1 pending file'))
    assert.ok(createBtn !== undefined, 'create stays available with pending changes')
    createBtn.props.onClick()
    await flush()
    assert.equal(posts.length, 3)
    assert.equal(posts[2].url, '/wo-github/create-branch')
    assert.equal(posts[2].body.name, 'feature/y')
    tree = resolve(renderPill(mkProps('/w/repo')))
    assert.ok(flatten(tree).map(textOf).some((t) => t.includes('feature/y')), 'the pill label follows the checkout immediately')
    const menuAfter = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchmenu'))
    assert.equal(menuAfter, undefined, 'the menu closed after creating')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('host checkout modes: carry keeps pending, stash cleans, conflicts refuse atomically', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const repo = mkRepo()
  try {
    const enc = encodeURIComponent(repo.dir)
    repo.git('branch', 'feature/x')
    // non-conflicting dirty change: carry moves it along
    writeFileSync(pathJoin(repo.dir, 'b.txt'), 'new file\n')
    const carry = await h.post('/wo-github/checkout', { path: repo.dir, branch: 'feature/x', mode: 'carry' })
    assert.equal(carry.status, 200)
    assert.equal(carry.body.branch, 'feature/x')
    assert.equal(carry.body.pending, 1, 'the change carried to the target branch')
    repo.git('checkout', 'main')

    // stash: worktree ends clean, recoverable stash entry recorded
    const stash = await h.post('/wo-github/checkout', { path: repo.dir, branch: 'feature/x', mode: 'stash' })
    assert.equal(stash.status, 200)
    assert.equal(stash.body.pending, 0, 'stashing leaves the worktree clean')
    assert.equal(repo.git('stash', 'list').toString().trim().split('\n').filter((l) => l !== '').length, 1, 'the stash entry exists')
    repo.git('checkout', 'main')
    repo.git('stash', 'pop')

    // conflicting carry: git refuses atomically, error surfaces
    repo.git('checkout', 'feature/x')
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'different on feature\n')
    repo.git('add', '.'); repo.git('commit', '-m', 'diverge a.txt')
    repo.git('checkout', 'main')
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'dirty on main\n')
    const conflict = await h.post('/wo-github/checkout', { path: repo.dir, branch: 'feature/x', mode: 'carry' })
    assert.equal(conflict.status, 400)
    assert.match(conflict.body.error, /overwritten by checkout/i)
    // nothing half-applied: still on main with the dirty change intact
    const after = await h.get('/wo-github/branch?path=' + enc)
    assert.equal(after.body.branch, 'main')
    assert.equal(after.body.pending, 1)
  } finally {
    repo.cleanup()
  }
})

test('host stash routes: list with branch, pop restores, drop discards', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const repo = mkRepo()
  try {
    const enc = encodeURIComponent(repo.dir)
    writeFileSync(pathJoin(repo.dir, 'b.txt'), 'stashed b\n')
    repo.git('stash', 'push', '--include-untracked', '-m', 'first stash')
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'modified a\n')
    repo.git('stash', 'push', '-m', 'second stash')
    repo.git('branch', 'other')

    const list = await h.get('/wo-github/stashes?path=' + enc)
    assert.equal(list.status, 200)
    assert.equal(list.body.branch, 'main')
    assert.equal(list.body.entries.length, 2)
    assert.equal(list.body.entries[0].ref, 'stash@{0}')
    assert.equal(list.body.entries[0].branch, 'main')
    assert.ok(list.body.entries[0].subject.includes('second stash'))

    // pop restores into the worktree and removes the entry
    const popped = await h.post('/wo-github/stash-pop', { path: repo.dir, index: 0 })
    assert.equal(popped.status, 200)
    assert.ok(popped.body.pending >= 1, 'the popped change lands in the worktree')
    const afterPop = await h.get('/wo-github/stashes?path=' + enc)
    assert.equal(afterPop.body.entries.length, 1)
    assert.ok(afterPop.body.entries[0].subject.includes('first stash'))

    // drop discards for good
    const dropped = await h.post('/wo-github/stash-drop', { path: repo.dir, index: 0 })
    assert.equal(dropped.status, 200)
    assert.equal((await h.get('/wo-github/stashes?path=' + enc)).body.entries.length, 0)
    // guards
    assert.equal((await h.post('/wo-github/stash-pop', { path: repo.dir, index: -1 })).status, 400)
    assert.equal((await h.post('/wo-github/stash-pop', { path: repo.dir, index: 'x' })).status, 400)
  } finally {
    repo.cleanup()
  }
})

test('StashPane: rows for this branch, Pop/Drop post the right index, other branches noted', async () => {
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
  const posts = []
  const entries = [
    { ref: 'stash@{0}', date: '2026-01-02T10:00:00+00:00', subject: 'On main: second stash', branch: 'main' },
    { ref: 'stash@{1}', date: '2026-01-01T10:00:00+00:00', subject: 'On main: first stash', branch: 'main' },
    { ref: 'stash@{2}', date: '2025-12-31T10:00:00+00:00', subject: 'On other: elsewhere', branch: 'other' },
  ]
  try {
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        posts.push({ url: new URL(url, 'http://x').pathname, body: JSON.parse(init.body) })
        entries.splice(init.body.includes('"index":0') ? 0 : 1, init.body.includes('"index":0') ? 1 : 1)
        return { ok: true, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({ branch: 'main', entries }) }
    }
    const render = () => { hookIdx = 0; return mod._internal.StashPane({ loc: { path: '/w/repo' } }) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    render()
    await flush()
    let tree = resolve(render())
    let texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('second stash')) && texts.some((t) => t.includes('first stash')),
      'this branch\'s stash entries render')
    assert.ok(!texts.some((t) => t.includes('elsewhere')), 'other branches\' entries stay out')
    assert.ok(texts.some((t) => t.includes('1 stash entry from other branches')), 'other-branch note renders')
    const rows = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stashrow'))
    assert.equal(rows.length, 2)
    // Pop the FIRST row (stash@{0})
    const popBtn = flatten(rows[0]).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('restore'))
    popBtn.props.onClick()
    await flush()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, '/wo-github/stash-pop')
    assert.equal(posts[0].body.index, 0)
    // Drop the next first row after the refresh
    tree = resolve(render())
    await flush()
    const rowsAfter = flatten(resolve(render())).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stashrow'))
    const dropBtn = flatten(rowsAfter[0]).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('discard'))
    dropBtn.props.onClick()
    await flush()
    assert.equal(posts.length, 2)
    assert.equal(posts[1].url, '/wo-github/stash-drop')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('OverviewPane: name and branch render instantly, fetched fields skeleton', async () => {
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
    // seed the pill's branch cache: the branch is known without any fetch
    mod._internal.branchCache.set('/w/repo', { branch: 'main', sha: null, pending: 0, stashes: 0 })
    const render = () => { hookIdx = 0; return mod._internal.OverviewPane({ loc: { path: '/w/repo', repo: 'o/r' } }) }
    let metaAsked = false
    globalThis.fetch = async (url) => {
      if (String(url).includes('/wo-github/meta?')) {
        // hold the response: the pane must already show the structure
        assert.ok(flatten(render()).some((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-repo-name')),
          'repo name visible while meta is still in flight')
        return { ok: true, json: async () => ({
          github: { fullName: 'o/r', description: 'the description', stars: 5, watchers: 1, forks: 2, openIssues: 0, topics: [], language: 'JS', license: 'MIT', pushedAt: '2026-01-01T00:00:00Z', htmlUrl: 'https://github.com/o/r', owner: { login: 'o' }, isPrivate: false },
          local: { branch: 'main', shortSha: 'abc1234', lastCommitAt: '2026-01-01T00:00:00Z', subject: 'last subject' },
        }) }
      }
      return { ok: true, json: async () => ({ absent: true }) }
    }
    let tree = render()
    let texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t === 'o/r'), 'repo name from the git slug, no fetch needed')
    assert.ok(texts.some((t) => t === 'branch main'), 'branch from the pill cache, no fetch needed')
    assert.ok(!texts.some((t) => t.includes('Loading repository')), 'no whole-page loading blank')
    const skel = flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-skeleton'))
    assert.ok(skel.length > 0, 'fetched fields show skeletons')
    await flush()
    tree = render()
    texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('the description')), 'description after the fetch')
    assert.ok(texts.some((t) => t.includes('5')), 'stats after the fetch')
    assert.ok(texts.some((t) => t.includes('last subject')), 'local facts after the fetch')
    assert.equal(flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-skeleton')).length, 0, 'skeletons gone')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('GithubTab: branch header above the tabs, panes keyed by branch', async () => {
  const effects = []
  let hookIdx = 0
  const slots = []
  const react = {
    createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
    Fragment: 'F',
    useState: (initial) => {
      const i = hookIdx++
      const store = slots   // shared store; components render in a fixed order
      if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
      return [store[i], (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v }]
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
    let liveBranch = 'main'
    const posts = []
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        posts.push(JSON.parse(init.body))
        liveBranch = JSON.parse(init.body).branch
        return { ok: true, json: async () => ({ branch: liveBranch, pending: 0 }) }
      }
      if (String(url).includes('/wo-github/branches')) return { ok: true, json: async () => ({ current: liveBranch, branches: ['feature/x', liveBranch] }) }
      if (String(url).includes('/wo-github/branch')) return { ok: true, json: async () => ({ branch: liveBranch, sha: null, pending: 0, stashes: 0 }) }
      if (String(url).includes('/wo-github/locate')) return { ok: true, json: async () => ({ git: true, slug: 'o/r' }) }
      if (String(url).includes('/workspace-overview/github')) return { ok: true, json: async () => ({ github: null }) }
      return { ok: true, json: async () => ({}) }
    }
    mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {} }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
    const mkProps = () => ({
      sessionId: 's1',
      useSessions: (sel) => sel({ current: 's1', byId: { s1: { cwd: '/w/repo' } } }),
      useWorkspaces: (sel) => sel({ items: [{ path: '/w/repo', sessionIds: ['s1'] }] }),
    })
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    const render = () => { hookIdx = 0; return mod._internal.GithubTab(mkProps()) }
    render()
    await flush()
    render()
    await flush()
    let tree = resolve(render())
    // the branch header sits ABOVE the subtab strip
    const byClass = (cls) => flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
    assert.equal(byClass('wog-tabbranch').length, 1, 'branch header present')
    assert.ok(textOf(byClass('wog-tabbranch-name')[0]).includes('main'), 'header shows the branch')
    assert.ok(textOf(byClass('wog-tabbranch')[0]).includes('Current branch:'), 'the label spells out what the name is')
    const order = flatten(tree).map((n) => n.props?.className)
    const headerAt = order.findIndex((c) => typeof c === 'string' && c.includes('wog-tabbranch'))
    const tabsAt = order.findIndex((c) => typeof c === 'string' && c.includes('wog-subtabs'))
    assert.ok(headerAt !== -1 && tabsAt !== -1 && headerAt < tabsAt, 'header before the tabs')
    assert.ok(byClass('wog-branchchev').length >= 1, 'the shared switcher renders in the header')
    assert.equal(byClass('wog-pane')[0].props.key, 'main', 'pane body keyed by branch')
    // switch via the header's switcher: the pane key follows the checkout
    byClass('wog-branchchev')[0].props.onClick()
    resolve(render())
    await flush()
    tree = resolve(render())
    const menuDown = flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchmenu-down'))
    assert.ok(menuDown !== undefined, 'under the panel header the menu opens DOWNWARD (up would hide behind the outer tabs)')
    const item = flatten(tree).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('checkout feature/x'))
    item.props.onClick()
    await flush()
    tree = resolve(render())
    assert.equal(flatten(tree).filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-pane'))[0].props.key, 'feature/x',
      'after the switch the pane body is keyed to the new branch (all panes remount)')
    assert.ok(textOf(flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-tabbranch-name'))).includes('feature/x'),
      'the header follows the checkout')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('switcher choice survives a detached click target (composedPath race)', async () => {
  const effects = []
  let hookIdx = 0
  const slots = []
  const docListeners = {}
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
  globalThis.document = Object.assign(mkDocument(), {
    addEventListener: (event, fn) => { docListeners[event] = fn },
    removeEventListener: () => {},
  })
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
  const resolve = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
    return { ...node, children: (node.children ?? []).map(resolve) }
  }
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/wo-github/branches')) return { ok: true, json: async () => ({ current: 'main', branches: ['feature/x', 'main'] }) }
      return { ok: true, json: async () => ({ branch: 'main', sha: null, pending: 1, stashes: 0 }) }
    }
    const renderPill = () => { hookIdx = 0; return mod._internal.BranchPill({ sessionId: 's1', useSessions: (sel) => sel({ current: 's1', byId: { s1: { cwd: '/w/repo' } } }) }) }
    renderPill()
    await flush()
    let tree = resolve(renderPill())
    // open the menu
    flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchchev')).props.onClick()
    resolve(renderPill())
    await flush()
    tree = resolve(renderPill())
    const item = flatten(tree).find((n) => typeof n.props?.title === 'string' && n.props.title.includes('choose what happens'))
    // click the item, then simulate the OUTSIDE-CLICK listener firing with
    // a target that React already DETACHED (closest misses; composedPath
    // must still recognize the menu and keep it open)
    item.props.onClick()
    docListeners.click({
      target: { closest: () => null },   // detached node: no ancestors
      composedPath: () => [{ closest: (sel) => sel.includes('wog-branchmenu') ? {} : null }],
    })
    tree = resolve(renderPill())
    const texts = flatten(tree).map(textOf)
    assert.ok(texts.some((t) => t.includes('Leave my changes on main')), 'the choice popup stays open despite the detached-target race')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('host stash-staged / discard-staged: named entry, partial files, unstaged kept', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogss-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  const stagePartially = (stagedText, bothText) => {
    // index gets ONLY the staged change; worktree gets staged + unstaged
    writeFileSync(pathJoin(dir, 'f.txt'), stagedText)
    git('add', 'f.txt')
    writeFileSync(pathJoin(dir, 'f.txt'), bothText)
  }
  try {
    const enc = encodeURIComponent(dir)
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
    const lines = Array.from({ length: 20 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
    const withStaged = (marker) => { const s2 = lines.split('\n'); s2[1] = marker; return s2.join('\n') }
    const withBoth = (marker) => { const s2 = lines.split('\n'); s2[1] = marker; s2[18] = 'UNSTAGED'; return s2.join('\n') }
    writeFileSync(pathJoin(dir, 'f.txt'), lines)
    git('add', '.'); git('commit', '-qm', 'base')

    // nothing staged guard
    assert.equal((await h.post('/wo-github/stash-staged', { path: dir })).status, 400)

    // stash-staged under a custom name; the distant unstaged edit survives
    stagePartially(withStaged('STAGED'), withBoth('STAGED'))
    const stashed = await h.post('/wo-github/stash-staged', { path: dir, message: 'wip: partial line' })
    assert.equal(stashed.status, 200)
    const list = (await h.get('/wo-github/stashes?path=' + enc)).body.entries
    assert.equal(list.length, 1)
    assert.ok(list[0].subject.includes('wip: partial line'), 'the custom name is the stash message')
    assert.equal(list[0].branch, 'main')
    const afterText = readFileSync(pathJoin(dir, 'f.txt'), 'utf8')
    assert.ok(!afterText.split('\n').includes('STAGED'), 'the staged line is gone from the worktree')
    assert.ok(afterText.split('\n').includes('UNSTAGED'), 'the distant unstaged edit SURVIVED')

    // discard-staged: stage again, discard, no leftover stash entry
    stagePartially(withStaged('STAGED2'), withBoth('STAGED2'))
    const discarded = await h.post('/wo-github/discard-staged', { path: dir })
    assert.equal(discarded.status, 200)
    const afterText2 = readFileSync(pathJoin(dir, 'f.txt'), 'utf8')
    assert.ok(!afterText2.split('\n').includes('STAGED2'), 'discarded staged line removed')
    assert.ok(afterText2.split('\n').includes('UNSTAGED'), 'unstaged edit still there')
    const list2 = (await h.get('/wo-github/stashes?path=' + enc)).body.entries
    assert.equal(list2.filter((e) => e.subject.includes('discarded staged changes')).length, 0, 'no leftover stash entry from the discard')

    // ADJACENT staged + unstaged lines: refused cleanly (409), nothing
    // changes, no stray stash entry
    const adjacentBoth = () => { const s2 = lines.split('\n'); s2[1] = 'ADJ_STAGED'; s2[2] = 'ADJ_UNSTAGED'; return s2.join('\n') }
    const adjacentStaged = () => { const s2 = lines.split('\n'); s2[1] = 'ADJ_STAGED'; return s2.join('\n') }
    stagePartially(adjacentStaged(), adjacentBoth())
    const refused = await h.post('/wo-github/stash-staged', { path: dir, message: 'should refuse' })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /adjacent lines/)
    const adjacentText = readFileSync(pathJoin(dir, 'f.txt'), 'utf8')
    assert.ok(adjacentText.split('\n').includes('ADJ_STAGED') && adjacentText.split('\n').includes('ADJ_UNSTAGED'),
      'worktree untouched by the refusal')
    const adjacentStatus = git('status', '--porcelain').toString().trim()
    assert.match(adjacentStatus, /^MM/, 'index still staged, worktree still dirty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host discard-staged: deterministic — one staged line among adjacent unstaged lines', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogds-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  // set the INDEX content without touching the worktree (partial staging)
  const indexSet = (file, text) => {
    const sha = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: text }).toString().trim()
    git('update-index', '--add', '--cacheinfo', '100644,' + sha + ',' + file)
  }
  try {
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
    const head = Array.from({ length: 10 }, (_, i) => 'l' + (i + 1))
    writeFileSync(pathJoin(dir, 'f.txt'), head.join('\n') + '\n')
    git('add', '.'); git('commit', '-qm', 'base')

    // section of 3 added lines, ONLY the middle one staged — the exact
    // case `stash push --staged` refuses (adjacent lines)
    writeFileSync(pathJoin(dir, 'f.txt'), ['l1', 'l2', 'X', 'Y', 'Z', ...head.slice(2)].join('\n') + '\n')
    indexSet('f.txt', ['l1', 'l2', 'Y', ...head.slice(2)].join('\n') + '\n')
    assert.equal(git('status', '--porcelain').toString().trim(), 'MM f.txt')
    const r = await h.post('/wo-github/discard-staged', { path: dir })
    assert.equal(r.status, 200)
    const after = readFileSync(pathJoin(dir, 'f.txt'), 'utf8').split('\n')
    assert.ok(after.includes('X') && after.includes('Z'), 'adjacent unstaged lines survive')
    assert.ok(!after.includes('Y'), 'the single staged line is gone')
    assert.equal(git('status', '--porcelain').toString().trimEnd(), ' M f.txt', 'nothing staged anymore')
    assert.equal(git('stash', 'list').toString().trim(), '', 'no stash entry involved')
    git('checkout', '-q', '--', 'f.txt')

    // staged line edited AGAIN unstaged (same line): inseparable, 409,
    // nothing changes
    writeFileSync(pathJoin(dir, 'f.txt'), ['l1', 'l2', 'Y2', ...head.slice(2)].join('\n') + '\n')
    indexSet('f.txt', ['l1', 'l2', 'Y', ...head.slice(2)].join('\n') + '\n')
    const refused = await h.post('/wo-github/discard-staged', { path: dir })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /same lines/)
    assert.equal(git('status', '--porcelain').toString().trim(), 'MM f.txt', 'the refusal touched nothing')

    // staged deletion + unstaged insertion on the neighbouring line
    indexSet('f.txt', head.filter((l) => l !== 'l3').join('\n') + '\n')
    writeFileSync(pathJoin(dir, 'f.txt'), ['l1', 'l2', 'l4', 'N', ...head.slice(4)].join('\n') + '\n')
    const r2 = await h.post('/wo-github/discard-staged', { path: dir })
    assert.equal(r2.status, 200)
    assert.equal(readFileSync(pathJoin(dir, 'f.txt'), 'utf8'),
      ['l1', 'l2', 'l3', 'l4', 'N', ...head.slice(4)].join('\n') + '\n',
      'deleted line restored, unstaged insertion kept')
    assert.equal(git('status', '--porcelain').toString().trimEnd(), ' M f.txt')
    git('checkout', '-q', '--', 'f.txt')

    // staged NEW file with unstaged extra lines: the remainder survives
    writeFileSync(pathJoin(dir, 'n.txt'), 'A\nB\n')
    indexSet('n.txt', 'A\n')
    const r3 = await h.post('/wo-github/discard-staged', { path: dir })
    assert.equal(r3.status, 200)
    assert.equal(readFileSync(pathJoin(dir, 'n.txt'), 'utf8'), 'B\n', 'only the unstaged remainder survives')
    assert.equal(git('status', '--porcelain').toString().trim(), '?? n.txt', 'back to a plain untracked file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PendingPane: Stash staged and Discard selected flows', async () => {
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
  const posts = []
  try {
    mod.apply({ inject: mod.inject, workspaceOverview: { registerTab: () => () => {} }, slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c }, get: () => undefined, provide: () => {} })
    let staged = true
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST') {
        posts.push({ url: new URL(url, 'http://x').pathname, body: JSON.parse(init.body) })
        if (String(url).includes('discard-staged')) staged = false
        return { ok: true, json: async () => ({ count: 0, files: [] }) }
      }
      return { ok: true, json: async () => ({ count: 1, files: [
        { file: 'f.txt', staged, unstaged: !staged, untracked: false, status: staged ? 'M ' : ' M' }] }) }
    }
    const render = () => { hookIdx = 0; return mod._internal.PendingPane({ loc: { path: '/w/repo' } }) }
    const resolve = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
      return { ...node, children: (node.children ?? []).map(resolve) }
    }
    render()
    await flush()
    let tree = resolve(render())
    const byTitle = (t, tree2) => flatten(tree2).find((n) => typeof n.props?.title === 'string' && n.props.title.includes(t))
    // nothing staged yet? f.txt IS staged in the fake -> buttons enabled
    assert.ok(byTitle('stash the staged changes under a name', tree) !== undefined, 'Stash staged button present and enabled')
    // a REFUSED stash (e.g. staged part of a section, adjacent lines)
    // surfaces its error instead of silently doing nothing
    let refuseOnce = true
    const savedPost = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (init !== undefined && init.method === 'POST' && String(url).includes('stash-staged') && refuseOnce) {
        refuseOnce = false
        return { ok: false, json: async () => ({ error: 'the staged changes cannot be separated from your unstaged edits (they sit on adjacent lines); stash or commit everything instead' }) }
      }
      return savedPost(url, init)
    }
    byTitle('stash the staged changes under a name', tree).props.onClick()
    tree = resolve(render())
    flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stash-input'))
      .props.onChange({ target: { value: 'nope' } })
    tree = resolve(render())
    byTitle('stash the staged changes under this name', tree).props.onClick()
    await flush()
    tree = resolve(render())
    const errorTexts = flatten(tree).map(textOf)
    assert.ok(errorTexts.some((t) => t.includes('cannot be separated from your unstaged edits')), 'the refusal error renders visibly')
    assert.ok(flatten(tree).some((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stash-input')), 'the form stays open for retry')
    globalThis.fetch = savedPost

    // retry inside the still-open form: type a name and Stash
    flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stash-input'))
      .props.onChange({ target: { value: 'wip: thing' } })
    tree = resolve(render())
    byTitle('stash the staged changes under this name', tree).props.onClick()
    await flush()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, '/wo-github/stash-staged')
    assert.equal(posts[0].body.message, 'wip: thing', 'the user-chosen name reaches git')
    tree = resolve(render())
    assert.equal(flatten(tree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-stash-input')), undefined, 'name form closed after success')
    const afterErrorGone = flatten(tree).map(textOf)
    assert.ok(!afterErrorGone.some((t) => t.includes('cannot be separated')), 'the error clears on success')
    // discard: arm -> confirm posts; cancel path disarms
    render()
    await flush()
    tree = resolve(render())
    byTitle('permanently discard the staged changes', tree).props.onClick()
    tree = resolve(render())
    byTitle('yes, throw the staged changes away', tree).props.onClick()
    await flush()
    assert.equal(posts.length, 2)
    assert.equal(posts[1].url, '/wo-github/discard-staged')
  } finally {
    globalThis.fetch = savedFetch
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
  }
})

test('host stash-pop: merges the stash back over the surviving unstaged part', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const dir = mkdtempSync(pathJoin(tmpdir(), 'wogpop-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  })
  try {
    const enc = encodeURIComponent(dir)
    git('init', '-q', '-b', 'main', '.')
    git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
    const lines = Array.from({ length: 10 }, (_, i) => 'l' + (i + 1)).join('\n') + '\n'
    writeFileSync(pathJoin(dir, 'f.txt'), lines)
    git('add', '.'); git('commit', '-qm', 'base')
    // partial: staged line 2, unstaged line 10
    const both = 'l1\nSTAGED\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nUNSTAGED\n'
    writeFileSync(pathJoin(dir, 'f.txt'), both)
    // stage only the top hunk through a temp write
    writeFileSync(pathJoin(dir, 'f.txt'), 'l1\nSTAGED\n' + lines.split('\n').slice(2).join('\n'))
    git('add', 'f.txt')
    writeFileSync(pathJoin(dir, 'f.txt'), both)
    // stash the staged part through our route (pre-check passes: distant)
    const stashed = await h.post('/wo-github/stash-staged', { path: dir, message: 'part' })
    assert.equal(stashed.status, 200)
    const midText = readFileSync(pathJoin(dir, 'f.txt'), 'utf8')
    assert.ok(midText.split('\n').includes('UNSTAGED') && !midText.split('\n').includes('STAGED'),
      'stash-staged left the unstaged part alone')
    // a NAIVE pop would refuse ("would be overwritten"); ours merges
    const popped = await h.post('/wo-github/stash-pop', { path: dir, index: 0 })
    assert.equal(popped.status, 200, 'pop merges the stash back over the unstaged part')
    const finalText = readFileSync(pathJoin(dir, 'f.txt'), 'utf8')
    assert.ok(finalText.split('\n').includes('STAGED') && finalText.split('\n').includes('UNSTAGED'),
      'both parts are back in the worktree')
    const list = (await h.get('/wo-github/stashes?path=' + enc)).body.entries
    assert.equal(list.length, 0, 'the entry was dropped after the successful pop')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('host stash-pop: foreign stashes never take the merge dance', async () => {
  const h = mkHostHarness()
  const host = await import(HOST_ENTRY_PATH)
  host.apply({ webServer: { register: (s) => { h.routes.set(s.path, s.handler); return () => {} } } })
  const repo = mkRepo()
  try {
    const enc = encodeURIComponent(repo.dir)
    // a FOREIGN stash whose changes CONFLICT with the dirty worktree:
    // the deterministic merge check refuses BEFORE anything is touched
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'foreign content\n')
    repo.git('stash', 'push', '-m', 'made by git itself')
    writeFileSync(pathJoin(repo.dir, 'a.txt'), 'dirty again\n')
    const refused = await h.post('/wo-github/stash-pop', { path: repo.dir, index: 0 })
    assert.equal(refused.status, 409, 'conflicting foreign stash: deterministic refusal')
    assert.match(refused.body.error, /would conflict/)
    assert.match(refused.body.error, /a\.txt/)
    assert.equal(readFileSync(pathJoin(repo.dir, 'a.txt'), 'utf8'), 'dirty again\n', 'worktree untouched')
    assert.equal((await h.get('/wo-github/stashes?path=' + enc)).body.entries.length, 1, 'entry still there')

    // a foreign stash that does NOT overlap the dirty worktree now pops
    // deterministically (no provenance marker needed at all)
    writeFileSync(pathJoin(repo.dir, 'b.txt'), 'stashed b\n')
    repo.git('stash', 'push', '-m', 'another foreign one')
    const foreignPop = await h.post('/wo-github/stash-pop', { path: repo.dir, index: 0 })
    assert.equal(foreignPop.status, 200, 'non-conflicting foreign stash pops over dirty worktree')
    assert.equal(readFileSync(pathJoin(repo.dir, 'b.txt'), 'utf8'), 'stashed b\n', 'its content landed')
    assert.equal(readFileSync(pathJoin(repo.dir, 'a.txt'), 'utf8'), 'dirty again\n', 'the dirty edit survived')
  } finally {
    repo.cleanup()
  }
})
