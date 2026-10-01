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
 *   /wo-github/branch?path=          -> { branch, sha, pending }
 *   /wo-github/pending?path=         -> { files, count }   uncommitted work
 *   /wo-github/pending-diff?path=&file=  -> { staged, unstaged } patch text
 *   POST /wo-github/pending-stage        { path, file, stage }  whole file
 *   POST /wo-github/pending-stage-hunk   { path, patch, reverse } one hunk
 *   POST /wo-github/pending-commit       { path, summary, description }
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
import { readFileSync } from 'node:fs'

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
        sendJson(res, 200, { branch: detached ? null : branch, sha, pending })
      } catch (e) {
        sendJson(res, 200, { branch: null, sha: null, pending: 0 })   // not a repo
      }
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
        status: code.trim() === '' ? 'M' : code.trim(),
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

  /** One file's patches: staged (HEAD vs index) and unstaged (index vs
   *  worktree) as unified patch text the client parses into hunks. */
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
          sendJson(res, 200, { staged: '', unstaged: '', untrackedText: text })
          return
        }
      } catch (e) {}   // status oddities fall through to the plain diffs
      const [staged, unstaged] = await Promise.all([
        gitOf(path, ['diff', '--cached', '--', file]).catch(() => ''),
        gitOf(path, ['diff', '--', file]).catch(() => ''),
      ])
      sendJson(res, 200, { staged, unstaged })
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
