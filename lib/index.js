/**
 * dsh-wo-github — host half.
 *
 * Read-only repository data for the GitHub subtab the browser half adds to
 * the Workspace Overview tab (dsh-workspace-overview). LOCAL FIRST: most
 * of what the tab shows lives in the workspace's own clone, so the routes
 * run git in the workspace and only fall back to api.github.com for what
 * git cannot know (stars, issues, topics) or when the clone fails us.
 *
 * Routes (GET unless noted):
 *   /wo-github/locate?path=          -> { git, slug }
 *   /wo-github/meta?path=&repo=      -> { local, github? }
 *   /wo-github/readme?path=&repo=    -> { name, text } | { absent: true }
 *   /wo-github/commits?path=&repo=&page= -> { commits, hasMore }
 *   /wo-github/commit?path=&repo=&sha=   -> { ...commit, files }
 *   /wo-github/branch?path=          -> { branch, sha, pending, stashes }
 *   /wo-github/pending?path=         -> { files, count }   uncommitted work
 *   /wo-github/pending-diff?path=&file=  -> { combined, staged, unstaged } patch text
 *   POST /wo-github/pending-stage        { path, file, stage }  whole file
 *   POST /wo-github/pending-stage-hunk   { path, patch, reverse } one hunk
 *   POST /wo-github/pending-commit       { path, summary, description }
 *   /wo-github/branches?path=         -> { current, branches } local refs
 *   POST /wo-github/checkout           { path, branch, mode? } mode: stash|carry
 *   POST /wo-github/create-branch      { path, name, from? } carries pending
 *   POST /wo-github/stash-staged       { path, message? } name + keep
 *   POST /wo-github/discard-staged     { path } drop the staged changes (unstaged edits stay)
 *   POST /wo-github/pending-discard-line { path, patch } revert one line
 *   /wo-github/stashes?path=          -> { branch, entries } stash list
 *   POST /wo-github/stash-pop         { path, index } restore + remove
 *   POST /wo-github/stash-drop        { path, index } discard
 *
 * `path` is the workspace (a git clone); `repo` is "owner/name" on
 * github.com. Order of preference per route: local git, then GitHub API.
 *
 * Caching: GitHub-API results keep their TTL caches (meta/readme 5 min,
 * lists 2 min, single commit forever — LRU). Local reads run uncached:
 * git is fast and the data is live by definition.
 *
 * GitHub specifics: anonymous access works for public repos; set
 * GITHUB_TOKEN in the harness environment to lift the 60 req/hour
 * ceiling. Rate-limit exhaustion surfaces as 503 with the reset epoch.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync as writeFileSyncNode } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'

export const name = 'wo-github'

export const inject = ['webServer']

const msg = (error) => (error && error.message ? error.message : String(error))

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[0-9a-f]{7,40}$/
const PATH_RE = /^\/.+/

const META_TTL_MS = 5 * 60_000
const README_TTL_MS = 5 * 60_000
const COMMITS_TTL_MS = 2 * 60_000
const COMMIT_LRU_MAX = 200

const metaCache = new Map()       // repo -> { at, data }
const readmeCache = new Map()     // repo -> { at, data }
const commitsCache = new Map()    // repo|page -> { at, data }
const commitCache = new Map()     // repo|sha -> data (immutable, LRU)

function cacheGet(cache, key, ttlMs) {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (ttlMs !== undefined && Date.now() - hit.at > ttlMs) {
    cache.delete(key)
    return undefined
  }
  return hit.data
}

function cachePut(cache, key, data, lruMax) {
  cache.set(key, { at: Date.now(), data })
  if (lruMax !== undefined && cache.size > lruMax) {
    cache.delete(cache.keys().next().value)
  }
}

// ---- local git -------------------------------------------------------------

/** Run git in the workspace with extra env (e.g. a TEMP index file for
 *  side-effect-free snapshots); same error mapping as gitOf. */
function gitOfEnv(path, args, env) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', path, ...args], {
      timeout: 8000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env },
    }, (err, stdout, stderr) => {
      if (err !== null) {
        const error = new Error('git ' + args[0] + ' failed: ' + (stderr !== '' && stderr !== undefined ? stderr : err.message).trim())
        error.status = 400
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

/** Run git in the workspace; rejects with a 400-mapped error on failure. */
function gitOf(path, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', path, ...args], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) {
        const error = new Error('git ' + args[0] + ' failed: ' + (stderr !== '' && stderr !== undefined ? stderr : err.message).trim())
        error.status = 400
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

const US = '\x1f'

/** Read one JSON request body (bounded to 4 MiB). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(Object.assign(new Error('body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/** git with stdin (patch application); same error shape as gitOf. */
function gitApply(path, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', path, ...args], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) {
        const error = new Error('git apply failed: ' + (stderr !== '' && stderr !== undefined ? stderr : err.message).trim())
        error.status = 400
        reject(error)
        return
      }
      resolve(stdout)
    })
    child.stdin.end(stdin)
  })
}

/** Mutation routes are POST-only. */
function requirePost(req) {
  if (req.method !== 'POST') throw Object.assign(new Error('POST required'), { status: 405 })
}

// ---- deterministic staged-discard line surgery ------------------------------
//
// `git stash push --staged` REFUSES when staged and unstaged edits sit on
// adjacent lines (its reverse patch needs matching context), so discarding
// one staged line of a multi-line section was impossible. The separation is
// nevertheless plain line arithmetic: the staged hunks (HEAD vs index) name
// the INDEX lines carrying staged changes; the unstaged hunks (index vs
// worktree) say where those lines sit in the worktree NOW. Revert the
// staged regions to their HEAD content at the mapped positions and the
// unstaged edits survive untouched. Only edits to the SAME lines are
// inseparable.

/** Split text into lines KEEPING each terminator (the last may have none),
 *  so slicing and joining are lossless. */
const splitKeepEnds = (text) => text === '' ? [] : text.split(/(?<=\n)/)

/** Hunk headers of a -U0 unified diff: { os, oc, ns, nc } (old/new start
 *  + count). A missing count means 1; count 0 marks an insertion point
 *  AFTER line <start> (start 0 = top of file). */
function u0HunksOf(patch) {
  const hunks = []
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let m
  while ((m = re.exec(patch)) !== null) {
    hunks.push({
      os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]),
      ns: Number(m[3]), nc: m[4] === undefined ? 1 : Number(m[4]),
    })
  }
  return hunks
}

/** Map a 1-based INDEX line number to its WORKTREE line number, shifted
 *  past every unstaged hunk sitting fully before it. */
function mapIndexToWork(unstaged, pos) {
  let delta = 0
  for (const u of unstaged) {
    const end = u.oc === 0 ? u.os : u.os + u.oc - 1   // affected index lines end here
    if (end < pos) delta += u.nc - u.oc
  }
  return pos + delta
}

/** true when `path` is (inside) a git work tree. */
async function gitIsRepo(path) {
  try {
    return (await gitOf(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch (e) {
    return false
  }
}

async function localMetaOf(path) {
  const branch = (await gitOf(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const head = await gitOf(path, ['log', '-1', '--format=%h' + US + '%cI' + US + '%s'])
  const [shortSha, lastCommitAt, subject] = head.trimEnd().split(US)
  let remoteUrl
  try { remoteUrl = (await gitOf(path, ['config', '--get', 'remote.origin.url'])).trim() } catch (e) { remoteUrl = undefined }
  return { branch, shortSha, lastCommitAt, subject, remoteUrl }
}

async function localReadmeOf(path) {
  const tracked = (await gitOf(path, ['ls-files'])).split('\n')
  const candidates = tracked.filter((name) => /^readme(\.md|\.txt)?$/i.test(name.trim()))
  if (candidates.length === 0) return { absent: true }
  candidates.sort((a, b) => (a.toLowerCase().endsWith('.md') ? 0 : 1) - (b.toLowerCase().endsWith('.md') ? 0 : 1))
  const name = candidates[0].trim()
  const text = await gitOf(path, ['show', 'HEAD:' + name])
  return { name, text }
}

const COMMIT_SEP = '\x1e'

async function localCommitsOf(path, page) {
  const perPage = 25
  const skip = (page - 1) * perPage
  const out = await gitOf(path, [
    'log', '--max-count=' + (perPage + 1), '--skip=' + skip,
    '--date=iso-strict', '--format=%H' + US + '%an' + US + '%cI' + US + '%s',
  ])
  const rows = out.split('\n').filter((line) => line !== '')
  const hasMore = rows.length > perPage
  return {
    source: 'local',
    hasMore,
    commits: rows.slice(0, perPage).map((line) => {
      const [sha, author, date, subject] = line.split(US)
      return { sha, message: subject, author, login: undefined, date, url: undefined }
    }),
  }
}

/** `git show <sha>` -> commit + per-file patches, parsed from unified diff. */
async function localCommitOf(path, sha) {
  const fmt = '--format=%H' + US + '%an' + US + '%cI' + US + '%B' + COMMIT_SEP
  const out = await gitOf(path, ['show', fmt, sha])
  const cut = out.indexOf(COMMIT_SEP)
  if (cut === -1) throw Object.assign(new Error('unexpected git show output'), { status: 500 })
  const [headSha, author, date, ...messageParts] = out.slice(0, cut).trimEnd().split(US)
  const diffText = out.slice(cut + COMMIT_SEP.length)

  const files = []
  let current = undefined
  let inHunk = false
  const pushLine = (line) => { if (current !== undefined && current.patch !== undefined) current.patch.push(line) }
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { filename: undefined, oldPath: undefined, status: 'modified', additions: 0, deletions: 0, patch: [] }
      files.push(current)
      inHunk = false
      continue
    }
    if (current === undefined) continue
    if (!inHunk) {
      if (line.startsWith('@@')) { inHunk = true; pushLine(line) }
      else if (line.startsWith('new file mode')) current.status = 'added'
      else if (line.startsWith('deleted file mode')) current.status = 'removed'
      else if (line.startsWith('rename to ')) { current.status = 'renamed'; current.filename = line.slice('rename to '.length).trim() }
      else if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length).trim()
      else if (line.startsWith('--- a/')) current.oldPath = line.slice('--- a/'.length)
      else if (line.startsWith('+++ b/')) current.filename = line.slice('+++ b/'.length)
      else if (line.startsWith('Binary files ')) current.patch = undefined
      continue
    }
    if (line === '' || line.startsWith('\\')) continue   // trailing blank, "\ No newline at end of file"
    if (line.startsWith('+')) { current.additions += 1; pushLine(line) }
    else if (line.startsWith('-')) { current.deletions += 1; pushLine(line) }
    else pushLine(line)
  }
  for (const file of files) {
    if (file.filename === undefined) file.filename = file.oldPath !== undefined ? file.oldPath : '(unknown)'
    delete file.oldPath
    file.patch = file.patch !== undefined && file.patch.length > 0 ? file.patch.join('\n') : undefined
  }
  return {
    source: 'local',
    sha: headSha,
    message: messageParts.join(US).trimEnd(),
    author,
    login: undefined,
    date,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    files,
  }
}

// ---- GitHub API ------------------------------------------------------------

/** One GitHub API call with the plugin's identity, optional token, timeout. */
async function ghJson(apiPath) {
  const headers = {
    'user-agent': 'dsh-wo-github (DSH plugin)',
    accept: 'application/vnd.github+json',
  }
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res
  try {
    res = await fetch('https://api.github.com' + apiPath, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const err = new Error('GitHub rate limit exhausted for this address')
    err.status = 503
    err.reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
    throw err
  }
  if (res.status === 404) {
    const err = new Error('not found on GitHub')
    err.status = 404
    throw err
  }
  if (!res.ok) {
    const err = new Error('GitHub API returned ' + res.status)
    err.status = 502
    throw err
  }
  return res.json()
}

// ---- param plumbing ----------------------------------------------------------

const paramsOf = (url) => new URL(url, 'http://localhost').searchParams
const repoOf = (search) => {
  const repo = search.get('repo')
  return repo !== null && REPO_RE.test(repo) ? repo : undefined
}
const pathOf = (search) => {
  const path = search.get('path')
  return path !== null && PATH_RE.test(path) ? path : undefined
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const disposers = []

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const handler = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      sendJson(res, error && error.status ? error.status : 500, { error: msg(error) })
    }
  }

  // ---- locate: does this workspace give us a repo view at all? ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/locate',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const repo = repoOf(search)
      const hasGit = path !== undefined && await gitIsRepo(path)
      sendJson(res, 200, { git: hasGit, slug: repo ?? null })
    }),
  }))

  // ---- branch: the composer pill's live checkout state. Read fresh every
  //      request (one rev-parse + one status) so agent checkouts and dirty
  //      trees surface immediately. ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/branch',
    handler: handler(async (req, res) => {
      const path = pathOf(paramsOf(req.url))
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      try {
        const branch = (await gitOf(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        const detached = branch === 'HEAD'
        const sha = detached ? (await gitOf(path, ['rev-parse', '--short', 'HEAD'])).trim() : null
        let pending = 0
        try {
          const status = await gitOf(path, ['status', '--porcelain'])
          pending = status.split('\n').filter((line) => line.trim() !== '').length
        } catch (e) { pending = 0 }
        // Only stashes made on THIS branch count for its indicator
        // (git prefixes entries with "On <branch>:" / "WIP on <branch>:").
        let stashes = 0
        try {
          const current = detached ? null : branch
          stashes = (await gitOf(path, ['stash', 'list', '--format=%gs']))
            .split('\n')
            .filter((line) => {
              if (line === '') return false
              const made = /^(?:On|WIP on) (\S+):/.exec(line)
              return current !== null && made !== null && made[1] === current
            }).length
        } catch (e) { stashes = 0 }
        sendJson(res, 200, { branch: detached ? null : branch, sha, pending, stashes })
      } catch (e) {
        sendJson(res, 200, { branch: null, sha: null, pending: 0 })   // not a repo
      }
    }),
  }))

  // ---- branches: local branch list for the pill's switcher ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/branches',
    handler: handler(async (req, res) => {
      const path = pathOf(paramsOf(req.url))
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const current = await gitOf(path, ['symbolic-ref', '--short', 'HEAD'])
        .then((out) => out.trim()).catch(() => null)
      const out = await gitOf(path, ['for-each-ref', 'refs/heads',
        '--sort=refname', '--format=%(refname:short)'])
      const branches = out.split('\n').map((name) => name.trim()).filter((name) => name !== '')
      sendJson(res, 200, { current, branches })
    }),
  }))

  // ---- checkout: switch to an existing local branch. BLOCKED while the
  //      worktree is dirty (commit or create a new branch to carry the
  //      changes with you); git itself would refuse conflicting switches,
  //      we refuse all of them so the rule is predictable. ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/checkout',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const branch = typeof body.branch === 'string' ? body.branch : undefined
      if (path === undefined || branch === undefined) throw Object.assign(new Error('path and branch required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const mode = body.mode === 'stash' || body.mode === 'carry' ? body.mode : undefined
      const exists = await gitOf(path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])
        .then((out) => out.trim() !== '').catch(() => false)
      if (!exists) throw Object.assign(new Error('branch not found: ' + branch), { status: 404 })
      const pending = await pendingOf(path)
      if (pending.count > 0 && mode === undefined) {
        throw Object.assign(new Error('switching branches needs a clean worktree: choose to leave the changes here (stashed) or bring them along, or create a new branch'), { status: 409 })
      }
      if (pending.count > 0 && mode === 'stash') {
        // Recoverable: git stash list / git stash pop on the original branch.
        await gitOf(path, ['stash', 'push', '--include-untracked',
          '-m', 'wo-github: stashed before switching from worktree to ' + branch])
      }
      // 'carry': plain checkout. git either carries the dirty state along
      // or refuses ATOMICALLY ("local changes would be overwritten") when
      // the target conflicts; nothing half-applies, the error goes to the
      // caller as-is.
      await gitOf(path, ['checkout', branch])
      sendJson(res, 200, { branch, pending: mode === 'stash' ? 0 : pending.count })
    }),
  }))

  /** Stash ONLY the staged changes (partial files included) under a name.
   *  `git stash push --staged` refuses — and leaves a stray entry — when
   *  unstaged edits sit inside the staged hunks' context (adjacent lines),
   *  so the separation is PRE-CHECKED: the reverse of the staged patch
   *  must apply cleanly against the worktree. Nothing is touched on a
   *  refusal. */
  const stashStagedOf = async (path, message) => {
    const stagedPatch = await gitOf(path, ['diff', '--cached'])
    if (stagedPatch.trim() === '') throw Object.assign(new Error('nothing is staged'), { status: 400 })
    try {
      await gitApply(path, ['apply', '--check', '-R', '--recount', '--unidiff-zero'], stagedPatch)
    } catch (e) {
      throw Object.assign(new Error(
        'the staged changes cannot be separated from your unstaged edits (they sit on adjacent lines); '
        + 'stash or commit everything instead'), { status: 409 })
    }
    const stashesBefore = (await gitOf(path, ['stash', 'list'])).trim() === '' ? 0
      : (await gitOf(path, ['stash', 'list'])).trim().split('\n').length
    try {
      await gitOf(path, ['stash', 'push', '--staged', '-m', message])
    } catch (e) {
      // a failure after entry creation leaves a stray stash: remove it so
      // the state is exactly as before
      const list = (await gitOf(path, ['stash', 'list'])).trim()
      const count = list === '' ? 0 : list.split('\n').length
      if (count > stashesBefore) {
        try { await gitOf(path, ['stash', 'drop', 'stash@{0}']) } catch (e2) {}
      }
      throw e
    }
    // Mark the entry as OURS (separated staged-only stash, pre-checked
    // against the unstaged part): only marked entries may take the
    // pop-over-unstaged merge later. A quiet git note; foreign stashes
    // (plain git / GitHub Desktop) carry no note and pop the normal way.
    try {
      const sha = (await gitOf(path, ['rev-parse', 'refs/stash'])).trim()
      if (sha !== '') await gitOf(path, ['notes', 'add', '-f', '-m', 'wog-staged-only', sha])
    } catch (e2) {}
  }

  /** true when the stash entry at `ref` was created by our stash-staged
   *  (carries the wog-staged-only note). */
  const isOurStagedStash = async (path, ref) => {
    try {
      const sha = (await gitOf(path, ['rev-parse', '--verify', '--quiet', ref])).trim()
      if (sha === '') return false
      const note = (await gitOf(path, ['notes', 'show', sha])).trim()
      return note === 'wog-staged-only'
    } catch (e) {
      return false
    }
  }

  // ---- discard ONE line of change (from the combined diff) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending-discard-line',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const patch = typeof body.patch === 'string' ? body.patch : undefined
      if (path === undefined || patch === undefined) throw Object.assign(new Error('path and patch required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      // The patch comes from the client's single-line mapping; it is a
      // forward patch against the INDEX (reverting the line to its
      // pre-change state). Apply it to the index AND the worktree: the
      // line disappears from both (for additions) or returns to both
      // (for deletions).
      await gitApply(path, ['apply', '--cached', '--recount', '--unidiff-zero'], patch)
      try {
        await gitApply(path, ['apply', '--recount', '--unidiff-zero'], patch)
      } catch (e) {
        // The index took it but the worktree has unstaged edits around
        // the line. Try to reverse just the worktree part: the worktree
        // contains the index state + unstaged edits, so the forward patch
        // should apply unless the unstaged edits touch the same context.
        // If it truly cannot, surface the error (index already reverted;
        // the worktree line stays until the next refresh shows the split).
        throw Object.assign(new Error('the line was reverted in the index but the worktree has nearby unstaged edits preventing a clean revert there; refresh to see the current state'), { status: 409 })
      }
      const pending = await pendingOf(path)
      sendJson(res, 200, { pending: pending.count })
    }),
  }))

  // ---- stash the STAGED changes (partial files included) under a name ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/stash-staged',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const pending = await pendingOf(path)
      if (!pending.files.some((f) => f.staged)) throw Object.assign(new Error('nothing is staged'), { status: 400 })
      const message = typeof body.message === 'string' && body.message.trim() !== ''
        ? body.message.trim() : 'wo-github: staged changes'
      await stashStagedOf(path, message)
      const after = await pendingOf(path)
      sendJson(res, 200, { pending: after.count, stagedLeft: after.files.some((f) => f.staged) })
    }),
  }))

  /** Discard EVERY staged change while keeping the unstaged edits — no
   *  stash, no context matching. Pass 1 computes every new worktree text
   *  (all refusals happen there, before anything is written); pass 2
   *  applies. */
  const discardStagedOf = async (path) => {
    const pending = await pendingOf(path)
    const stagedRows = pending.files.filter((f) => f.staged)
    if (stagedRows.length === 0) throw Object.assign(new Error('nothing is staged'), { status: 400 })
    for (const row of stagedRows) {
      if (row.renamedFrom !== undefined) {
        throw Object.assign(new Error('discarding a staged rename of ' + row.file + ' is not supported; unstage it first'), { status: 409 })
      }
      if (row.status.includes('U') || row.status === 'AA' || row.status === 'DD') {
        throw Object.assign(new Error('resolve the conflicts in ' + row.file + ' first'), { status: 409 })
      }
    }
    const rewrites = []
    for (const row of stagedRows) {
      const file = row.file
      const workPath = pathJoin(path, file)
      const inHead = await gitOf(path, ['cat-file', '-e', 'HEAD:' + file]).then(() => true, () => false)
      const inIndex = await gitOf(path, ['cat-file', '-e', ':' + file]).then(() => true, () => false)
      const workExists = existsSync(workPath)
      const hasUnstaged = (await gitOf(path, ['diff', '--numstat', '--', file]).then((s) => s.trim(), () => '')) !== ''
      if (!workExists) {
        // worktree file already gone: dropping the staged part is just
        // unstage; the missing file stays the user's own unstaged state
        rewrites.push({ file, kind: 'unstage' })
        continue
      }
      if (!hasUnstaged) {
        // clean split: restoring the whole file (or removing a staged new
        // file) fixes worktree AND index in one git step
        rewrites.push({ file, kind: inHead ? 'checkout' : 'rm' })
        continue
      }
      // staged + unstaged coexist in one file: line surgery
      const stagedNum = await gitOf(path, ['diff', '--cached', '--numstat', '--', file]).then((s) => s.trim(), () => '')
      if (stagedNum.startsWith('-\t')) {
        throw Object.assign(new Error('the staged changes in ' + file + ' are in a binary file that also has unstaged edits; they cannot be discarded separately'), { status: 409 })
      }
      const summary = await gitOf(path, ['diff', '--cached', '--summary', '--', file]).then((s) => s.trim(), () => '')
      if (/mode change|mode 120000|rewrite /.test(summary)) {
        throw Object.assign(new Error('the staged changes in ' + file + ' include mode or symlink changes and cannot be separated from its unstaged edits'), { status: 409 })
      }
      if (!inIndex) {
        // staged deletion with a file back at the path: only safe when it
        // already matches HEAD
        const headText = await gitOf(path, ['show', 'HEAD:' + file])
        if (readFileSync(workPath, 'utf8') === headText) { rewrites.push({ file, kind: 'checkout' }); continue }
        throw Object.assign(new Error('the staged deletion of ' + file + ' cannot be discarded while a different file sits at that path'), { status: 409 })
      }
      const headText = inHead ? await gitOf(path, ['show', 'HEAD:' + file]) : ''
      const indexText = await gitOf(path, ['show', ':' + file])
      const workText = readFileSync(workPath, 'utf8')
      const staged = u0HunksOf(await gitOf(path, ['diff', '--cached', '-U0', '--', file]))
      const unstaged = u0HunksOf(await gitOf(path, ['diff', '-U0', '--', file]))
      const headLines = splitKeepEnds(headText)
      const indexLines = splitKeepEnds(indexText)
      let lines = splitKeepEnds(workText)
      const crlf = workText.includes('\r\n')
      const toWorkEol = (arr) => crlf
        ? arr.map((l) => l.endsWith('\n') && !l.endsWith('\r\n') ? l.slice(0, -1) + '\r\n' : l) : arr
      const norm = (l) => l.replace(/\r\n$/, '\n')
      // inseparable = staged and unstaged touch the SAME lines; plain
      // adjacency is fine, the mapping handles it exactly
      for (const s of staged) {
        for (const u of unstaged) {
          const sEnd = s.ns + s.nc - 1
          const uEnd = u.os + u.oc - 1
          if (s.nc > 0 && u.oc > 0 && s.ns <= uEnd && u.os <= sEnd) {
            throw Object.assign(new Error('staged and unstaged edits touch the same lines in ' + file + '; they cannot be discarded separately'), { status: 409 })
          }
          // an unstaged insertion landing INSIDE a staged region would be
          // swallowed by the revert
          if (s.nc > 1 && u.oc === 0 && s.ns <= u.os && u.os < sEnd) {
            throw Object.assign(new Error('staged and unstaged edits touch the same lines in ' + file + '; they cannot be discarded separately'), { status: 409 })
          }
        }
      }
      // ops: worktree lines [start..end] become `lines` (start = end + 1
      // marks a pure insertion before line start); descending order keeps
      // earlier positions valid
      const ops = []
      for (const s of staged) {
        const replace = s.oc > 0 ? headLines.slice(s.os - 1, s.os - 1 + s.oc) : []
        if (s.nc > 0) {
          const ws = mapIndexToWork(unstaged, s.ns)
          ops.push({
            start: ws, end: ws + s.nc - 1, lines: toWorkEol(replace),
            expect: indexLines.slice(s.ns - 1, s.ns - 1 + s.nc),
          })
        } else {
          // a 0-count NEW range starts at the line the restored content
          // goes AFTER (0 = top of file), same convention as the old side
          const after = mapIndexToWork(unstaged, s.ns)
          ops.push({ start: after + 1, end: after, lines: toWorkEol(replace) })
        }
      }
      ops.sort((a, b) => b.start - a.start)
      for (const op of ops) {
        const misplaced = () => Object.assign(new Error('could not locate the staged lines of ' + file + ' in the worktree; refresh and retry'), { status: 409 })
        if (op.start < 1 || op.end > lines.length) throw misplaced()
        if (op.expect !== undefined) {
          // the worktree region must still hold exactly the index lines
          // the staged hunk produced (sanity + race backstop)
          const there = lines.slice(op.start - 1, op.end)
          if (there.length !== op.expect.length || there.some((l, i) => norm(l) !== norm(op.expect[i]))) throw misplaced()
        }
        lines = lines.slice(0, op.start - 1).concat(op.lines, lines.slice(op.end))
      }
      rewrites.push({ file, kind: 'write', text: lines.join('') })
    }
    for (const r of rewrites) {
      if (r.kind === 'checkout') await gitOf(path, ['checkout', '-q', 'HEAD', '--', r.file])
      else if (r.kind === 'rm') await gitOf(path, ['rm', '-q', '-f', '--', r.file])
      else if (r.kind === 'unstage') await gitOf(path, ['reset', '-q', 'HEAD', '--', r.file])
      else {
        writeFileSyncNode(pathJoin(path, r.file), r.text)
        await gitOf(path, ['reset', '-q', 'HEAD', '--', r.file])
      }
    }
  }

  // ---- discard the staged changes: deterministic line surgery, unstaged
  //      edits stay (a single staged line of a section works) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/discard-staged',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      await discardStagedOf(path)
      const after = await pendingOf(path)
      sendJson(res, 200, { pending: after.count })
    }),
  }))

  // ---- stashes: entries with the branch each was made on (pop/drop) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/stashes',
    handler: handler(async (req, res) => {
      const path = pathOf(paramsOf(req.url))
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const branch = await gitOf(path, ['symbolic-ref', '--short', 'HEAD'])
        .then((out) => out.trim()).catch(() => null)
      // %gd would expand the reflog selector with the custom date format;
      // the index is simply the list position (git numbers stashes newest
      // first), so only date + subject come from the format.
      const out = await gitOf(path, ['stash', 'list', '--date=iso',
        '--format=%ad\u001f%gs']).catch(() => '')
      const entries = out.split('\n').filter((line) => line !== '').map((line, index) => {
        const [date, subject] = line.split('\u001f')
        const onBranch = /^(?:On|WIP on) (\S+):/.exec(subject ?? '')
        return { ref: 'stash@{' + index + '}', date: date ?? '', subject: subject ?? '', branch: onBranch !== null ? onBranch[1] : undefined }
      })
      sendJson(res, 200, { branch, entries })
    }),
  }))

  /** Simulate the stash-pop 3-way merge WITHOUT touching anything.
   *  @returns { ok: true, tree } when the merge is clean,
   *           { ok: false, conflicted: true, files } on conflicts,
   *           { ok: false, conflicted: false } when merge-tree is
   *           unavailable (git older than 2.38). */
  const tryDeterministicPop = async (path, ref) => {
    try {
      const gitDir = (await gitOf(path, ['rev-parse', '--absolute-git-dir'])).trim()
      const tmpIndex = pathJoin(gitDir, 'wog-pop-index')
      const env = { GIT_INDEX_FILE: tmpIndex }
      try {
        // ours = a snapshot of the current worktree (tracked changes +
        // untracked-but-not-ignored files), built in a TEMP index
        await gitOfEnv(path, ['add', '-A', '--', '.'], env)
        const ours = (await gitOfEnv(path, ['write-tree'], env)).trim()
        const base = (await gitOf(path, ['rev-parse', ref + '^1^{tree}'])).trim()
        const theirs = (await gitOf(path, ['rev-parse', ref + '^{tree}'])).trim()
        const out = await new Promise((resolve) => {
          execFile('git', ['-C', path, 'merge-tree', '--write-tree', '--name-only',
            '--merge-base=' + base, ours, theirs],
            { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ code: err === null ? 0 : (err.code ?? 1), stdout: String(stdout), stderr: String(stderr ?? '') }))
        })
        if (out.code === 0) {
          const tree = out.stdout.split('\n')[0].trim()
          return tree !== '' ? { ok: true, tree } : { ok: false, conflicted: false }
        }
        // merge-tree exits 1 on conflicts: first line is still the tree,
        // the following lines are the conflicted paths
        const lines = out.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
        const files = lines.slice(1).join(', ')
        return { ok: false, conflicted: true, files: files === '' ? '(unknown)' : files }
      } finally {
        try { rmSync(tmpIndex, { force: true }) } catch (e2) {}
      }
    } catch (e) {
      return { ok: false, conflicted: false }
    }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/stash-pop',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const index = Number(body.index)
      if (path === undefined || !Number.isInteger(index) || index < 0) throw Object.assign(new Error('path and index required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const ref = 'stash@{' + index + '}'
      try {
        await gitOf(path, ['stash', 'pop', ref])   // conflicts surface verbatim
      } catch (e) {
        const message = String(e.message ?? '')
        if (!message.includes('would be overwritten')) throw e
        // The worktree holds unstaged edits to the same files, so plain
        // pop refuses at FILE level. Deterministically decide the merge
        // first: `git merge-tree` simulates the exact 3-way pop merge
        // (base = the stash's parent tree, ours = a snapshot of the
        // current worktree, theirs = the stash) in memory, touching
        // nothing. Clean tree -> materialize it into the worktree with
        // git restore. Conflicts -> refuse with the file list; the
        // worktree and the stash entry are untouched either way.
        const deterministic = await tryDeterministicPop(path, ref)
        if (deterministic.ok !== true) {
          if (deterministic.conflicted === true) {
            throw Object.assign(new Error('popping this stash would conflict with your uncommitted changes in: '
              + deterministic.files + ' — resolve or move them first'), { status: 409 })
          }
          // merge-tree unavailable (older git): only entries our
          // "Stash staged…" created (git note) take the park/apply/
          // restore fallback; foreign stashes keep git's own refusal.
          if (!(await isOurStagedStash(path, ref))) throw e
        } else {
          await gitOf(path, ['restore', '--source=' + deterministic.tree, '--worktree', '--', '.'])
          await gitOf(path, ['stash', 'drop', ref])
          const afterPop = await pendingOf(path)
          sendJson(res, 200, { pending: afterPop.count })
          return
        }
        const unstaged = await gitOf(path, ['diff'])
        const restore = async () => {
          if (unstaged.trim() === '') return
          await gitApply(path, ['apply', '--recount', '--unidiff-zero'], unstaged)
        }
        if (unstaged.trim() !== '') await gitOf(path, ['checkout', '--', '.'])
        try {
          await gitOf(path, ['stash', 'apply', ref])
          await restore()
        } catch (e2) {
          // Loss-proof: park a copy as a real stash entry first, then try
          // to put things back. Whatever happens, the unstaged edits are
          // recoverable and the message says where they are.
          if (unstaged.trim() !== '') {
            try { await restore() } catch (e3) {
              try {
                await gitApply(path, ['apply', '--3way', '--recount', '--unidiff-zero'], unstaged)
              } catch (e4) {
                const lossError = new Error('restoring your unstaged edits after the pop failed; they are NOT lost — this patch holds them:\n' + unstaged)
                lossError.status = 409
                throw lossError
              }
            }
          }
          throw e2
        }
        await gitOf(path, ['stash', 'drop', ref])
      }
      const pending = await pendingOf(path)
      sendJson(res, 200, { pending: pending.count })
    }),
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/stash-drop',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const index = Number(body.index)
      if (path === undefined || !Number.isInteger(index) || index < 0) throw Object.assign(new Error('path and index required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      await gitOf(path, ['stash', 'drop', 'stash@{' + index + '}'])
      sendJson(res, 200, { dropped: true })
    }),
  }))

  // ---- create-branch: git checkout -b; pending changes are CARRIED into
  //      the new branch on purpose (that is the escape hatch for a dirty
  //      worktree). ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/create-branch',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const name = typeof body.name === 'string' ? body.name.trim() : undefined
      const from = typeof body.from === 'string' && body.from.trim() !== '' ? body.from.trim() : undefined
      if (path === undefined || name === undefined || name === '') throw Object.assign(new Error('path and name required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      try {
        await gitOf(path, ['check-ref-format', '--branch', name])
      } catch (e) {
        throw Object.assign(new Error('invalid branch name: ' + name), { status: 400 })
      }
      const taken = await gitOf(path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + name])
        .then((out) => out.trim() !== '').catch(() => false)
      if (taken) throw Object.assign(new Error('branch already exists: ' + name), { status: 409 })
      await gitOf(path, ['checkout', '-b', name, ...(from !== undefined ? [from] : [])])
      sendJson(res, 200, { branch: name })
    }),
  }))

  // ---- About card: GitHub fields when the repo is on GitHub, local
  //      facts always (a git-only repo shows branch + last commit) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/meta',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const repo = repoOf(search)
      if (path === undefined && repo === undefined) throw Object.assign(new Error('path and/or repo required'), { status: 400 })
      let local
      if (path !== undefined && await gitIsRepo(path)) {
        try { local = await localMetaOf(path) } catch (e) { local = undefined }
      }
      let github
      if (repo !== undefined) {
        const cached = cacheGet(metaCache, repo, META_TTL_MS)
        if (cached !== undefined) {
          github = cached
        } else {
          try {
            const raw = await ghJson('/repos/' + repo)
            github = {
              fullName: raw.full_name,
              description: raw.description,
              htmlUrl: raw.html_url,
              homepage: raw.homepage || undefined,
              stars: raw.stargazers_count,
              forks: raw.forks_count,
              openIssues: raw.open_issues_count,
              watchers: raw.subscribers_count,
              language: raw.language,
              defaultBranch: raw.default_branch,
              license: raw.license && raw.license.spdx_id !== 'NOASSERTION' ? raw.license.spdx_id : undefined,
              topics: Array.isArray(raw.topics) ? raw.topics : [],
              updatedAt: raw.updated_at,
              pushedAt: raw.pushed_at,
              ownerLogin: raw.owner && raw.owner.login,
              ownerAvatar: raw.owner && raw.owner.avatar_url,
              isPrivate: raw.private === true,
            }
            cachePut(metaCache, repo, github)
          } catch (error) {
            if (local !== undefined || path !== undefined) github = undefined   // local covers us
            else throw error
          }
        }
      }
      if (local === undefined && github === undefined) {
        throw Object.assign(new Error('no repository view available'), { status: 404 })
      }
      sendJson(res, 200, { local, github })
    }),
  }))

  // ---- README: committed file from the clone, GitHub fallback ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/readme',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const repo = repoOf(search)
      if (path !== undefined && await gitIsRepo(path)) {
        try {
          const data = await localReadmeOf(path)
          if (data.absent !== true) return sendJson(res, 200, data)
        } catch (e) { /* fall through to GitHub */ }
      }
      if (repo === undefined) {
        return sendJson(res, 200, { absent: true })
      }
      const cached = cacheGet(readmeCache, repo, README_TTL_MS)
      if (cached !== undefined) return sendJson(res, 200, cached)
      let raw
      try {
        raw = await ghJson('/repos/' + repo + '/readme')
      } catch (error) {
        if (error.status === 404) {
          const data = { absent: true }
          cachePut(readmeCache, repo, data)
          return sendJson(res, 200, data)
        }
        throw error
      }
      const data = { name: raw.name, text: Buffer.from(raw.content, 'base64').toString('utf8') }
      cachePut(readmeCache, repo, data)
      sendJson(res, 200, data)
    }),
  }))

  // ---- commits: git log from the clone, GitHub fallback ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/commits',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const repo = repoOf(search)
      if (path === undefined && repo === undefined) throw Object.assign(new Error('path and/or repo required'), { status: 400 })
      const pageRaw = search.get('page')
      const page = Math.max(1, Math.min(100, Number.isFinite(Number(pageRaw)) && Number(pageRaw) > 0 ? Math.floor(Number(pageRaw)) : 1))
      if (path !== undefined && await gitIsRepo(path)) {
        try {
          return sendJson(res, 200, await localCommitsOf(path, page))
        } catch (e) { /* fall through to GitHub */ }
      }
      if (repo === undefined) throw Object.assign(new Error('no commit source available'), { status: 404 })
      const key = repo + '|' + page
      const cached = cacheGet(commitsCache, key, COMMITS_TTL_MS)
      if (cached !== undefined) return sendJson(res, 200, cached)
      const raw = await ghJson('/repos/' + repo + '/commits?per_page=25&page=' + page)
      const data = {
        source: 'github',
        hasMore: raw.length === 25,
        commits: raw.map((entry) => ({
          sha: entry.sha,
          message: entry.commit && typeof entry.commit.message === 'string' ? entry.commit.message : '',
          author: entry.commit && entry.commit.author && entry.commit.author.name,
          login: entry.author && entry.author.login,
          date: entry.commit && entry.commit.author && entry.commit.author.date,
          url: entry.html_url,
        })),
      }
      cachePut(commitsCache, key, data)
      sendJson(res, 200, data)
    }),
  }))

  // ---- one commit: git show from the clone, GitHub fallback ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/commit',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const repo = repoOf(search)
      if (path === undefined && repo === undefined) throw Object.assign(new Error('path and/or repo required'), { status: 400 })
      const sha = search.get('sha')
      if (sha === null || !SHA_RE.test(sha)) throw Object.assign(new Error('sha must be 7-40 hex chars'), { status: 400 })
      const key = repo !== undefined ? repo + '|' + sha : undefined
      if (key !== undefined) {
        const cached = cacheGet(commitCache, key)
        if (cached !== undefined) return sendJson(res, 200, cached)
      }
      if (path !== undefined && await gitIsRepo(path)) {
        try {
          const data = await localCommitOf(path, sha)
          if (key !== undefined) cachePut(commitCache, key, data, COMMIT_LRU_MAX)
          return sendJson(res, 200, data)
        } catch (e) {
          if (repo === undefined) throw e   // sha may simply not exist locally; GitHub gets the last word only if it can
        }
      }
      if (repo === undefined) throw Object.assign(new Error('commit not found in this clone'), { status: 404 })
      const raw = await ghJson('/repos/' + repo + '/commits/' + sha)
      const data = {
        source: 'github',
        sha: raw.sha,
        message: raw.commit && raw.commit.message,
        author: raw.commit && raw.commit.author && raw.commit.author.name,
        login: raw.author && raw.author.login,
        date: raw.commit && raw.commit.author && raw.commit.author.date,
        additions: raw.stats && raw.stats.additions,
        deletions: raw.stats && raw.stats.deletions,
        files: Array.isArray(raw.files) ? raw.files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: typeof file.patch === 'string' ? file.patch : undefined,
        })) : [],
      }
      if (key !== undefined) cachePut(commitCache, key, data, COMMIT_LRU_MAX)
      sendJson(res, 200, data)
    }),
  }))

  // ---- pending changes: the GitHub Desktop surface. The index is the
  //      source of truth: checkboxes stage/unstage immediately, and commit
  //      commits exactly what is staged. These routes never checkout, push,
  //      or rewrite history. ----

  const FILE_RE = /^[\w./@+-][\w./@+-]*$/

  /** porcelain status -> grouped rows with numstat line counts. */
  async function pendingOf(path) {
    const out = await gitOf(path, ['status', '--porcelain=v1', '-z'])
    const files = []
    let i = 0
    while (i < out.length) {
      const cut = out.indexOf('\0', i)
      const entry = cut === -1 ? out.slice(i) : out.slice(i, cut)
      if (entry === '') break
      i = cut === -1 ? out.length : cut + 1
      const code = entry.slice(0, 2)
      let file = entry.slice(3)
      let renamedFrom
      const renameCut = file.indexOf('\0')
      if (code[0] === 'R' || code[0] === 'C') {
        // R/C entries carry two NUL-separated paths: orig then new.
        const nextCut = out.indexOf('\0', i)
        renamedFrom = file
        file = out.slice(i, nextCut === -1 ? out.length : nextCut)
        i = nextCut === -1 ? out.length : nextCut + 1
        void renameCut
      }
      const staged = code[0] !== ' ' && code[0] !== '?'
      const unstaged = code[1] !== ' ' || code[0] === '?'
      files.push({
        file,
        renamedFrom,
        untracked: code === '??',
        staged,
        unstaged,
        status: code,   // raw porcelain XY code; the client words it
      })
    }
    // numstat: staged (HEAD vs index) and unstaged (index vs worktree)
    const countsOf = async (cached) => {
      const map = new Map()
      try {
        const args = ['diff', '--numstat', '-z']
        if (cached) args.push('--cached')
        const raw = await gitOf(path, args)
        let j = 0
        while (j < raw.length) {
          const cut = raw.indexOf('\0', j)
          const line = cut === -1 ? raw.slice(j) : raw.slice(j, cut)
          if (line === '') break
          j = cut === -1 ? raw.length : cut + 1
          const parts = line.split('\t')
          if (parts.length >= 3) map.set(parts[2], { additions: parts[0] === '-' ? null : Number(parts[0]), deletions: parts[1] === '-' ? null : Number(parts[1]) })
        }
      } catch (e) {}   // binary-only or empty: counts are cosmetic
      return map
    }
    const [stagedCounts, unstagedCounts] = await Promise.all([countsOf(true), countsOf(false)])
    for (const row of files) {
      const s = stagedCounts.get(row.file)
      const u = unstagedCounts.get(row.file)
      row.stagedCounts = s !== undefined && (row.staged || s.additions !== null) ? s : undefined
      row.unstagedCounts = u
      if (row.untracked) row.unstagedCounts = undefined
    }
    return { files, count: files.length }
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending',
    handler: handler(async (req, res) => {
      const path = pathOf(paramsOf(req.url))
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (!(await gitIsRepo(path))) { sendJson(res, 200, { files: [], count: 0 }); return }
      sendJson(res, 200, await pendingOf(path))
    }),
  }))

  /** One file's patches: combined (HEAD vs worktree, the ONE view the
   *  client renders with per-line stage marks), staged (HEAD vs index) and
   *  unstaged (index vs worktree), as unified patch text the client parses
   *  into hunks. */
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending-diff',
    handler: handler(async (req, res) => {
      const search = paramsOf(req.url)
      const path = pathOf(search)
      const file = search.get('file')
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (file === null || !FILE_RE.test(file)) throw Object.assign(new Error('file required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      // Untracked: no diff exists; return the worktree text (bounded) and let
      // the client render it as whole-file additions.
      try {
        const status = await gitOf(path, ['status', '--porcelain', '--', file])
        if (status.startsWith('??')) {
          let text = ''
          try { text = readFileSync(path + '/' + file, 'utf8').slice(0, 1024 * 1024) } catch (e) { text = '' }
          sendJson(res, 200, { combined: '', staged: '', unstaged: '', untrackedText: text })
          return
        }
      } catch (e) {}   // status oddities fall through to the plain diffs
      const [combined, staged, unstaged, indexText] = await Promise.all([
        gitOf(path, ['diff', 'HEAD', '--', file]).catch(() => ''),
        gitOf(path, ['diff', '--cached', '--', file]).catch(() => ''),
        gitOf(path, ['diff', '--', file]).catch(() => ''),
        // the index blob itself: the client builds single-line UNSTAGE
        // patches against exact index content (reversed partial staged
        // patches fail when sibling staged deletions became its context)
        gitOf(path, ['show', ':' + file]).catch(() => ''),
      ])
      sendJson(res, 200, { combined, staged, unstaged, indexText: indexText.slice(0, 1024 * 1024) })
    }),
  }))

  /** Stage/unstage one whole file (checkbox in the list). Untracked files
   *  stage with `add`; tracked unstage with `restore --staged`. */
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending-stage',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' ? body.path : undefined
      const file = typeof body.file === 'string' && FILE_RE.test(body.file) ? body.file : undefined
      if (path === undefined || !PATH_RE.test(path)) throw Object.assign(new Error('path required'), { status: 400 })
      if (file === undefined) throw Object.assign(new Error('file required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      if (body.stage !== false) {
        await gitOf(path, ['add', '--', file])
      } else {
        await gitOf(path, ['restore', '--staged', '--', file])
      }
      sendJson(res, 200, await pendingOf(path))
    }),
  }))

  /** Stage/unstage ONE HUNK by applying its patch to the index, the same
   *  mechanism GitHub Desktop uses. `patch` is the client's excerpt of the
   *  diff text (file header + one hunk) the browser received from
   *  pending-diff; `reverse` unstages. */
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending-stage-hunk',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' && PATH_RE.test(body.path) ? body.path : undefined
      const patch = typeof body.patch === 'string' ? body.patch : undefined
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (patch === undefined || !patch.startsWith('diff --git ')) throw Object.assign(new Error('patch required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const args = ['apply', '--cached', '--recount', '--unidiff-zero', '-']
      if (body.reverse === true) args.push('-R')
      await gitApply(path, args, patch)
      sendJson(res, 200, await pendingOf(path))
    }),
  }))

  /** Commit the index: `git commit -m summary [-m description]`. Never
   *  amends, never pushes, never touches the branch. */
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/pending-commit',
    handler: handler(async (req, res) => {
      requirePost(req)
      const body = await readBody(req)
      const path = typeof body.path === 'string' && PATH_RE.test(body.path) ? body.path : undefined
      const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (path === undefined) throw Object.assign(new Error('path required'), { status: 400 })
      if (summary === '') throw Object.assign(new Error('summary required'), { status: 400 })
      if (!(await gitIsRepo(path))) throw Object.assign(new Error('not a git repo'), { status: 400 })
      const args = ['commit', '-m', summary]
      if (description !== '') args.push('-m', description)
      await gitOf(path, args)
      sendJson(res, 200, { committed: true })
    }),
  }))

  return () => { for (const d of disposers) { try { d() } catch (e) {} } }
}
