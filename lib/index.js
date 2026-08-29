/**
 * dsh-wo-github — host half.
 *
 * A read-only proxy over api.github.com for the GitHub subtab the browser
 * half adds to the Workspace Overview tab (dsh-workspace-overview). The
 * client cannot call api.github.com directly from the page; this half
 * fetches server-side, caches, and maps failures to honest HTTP errors.
 *
 * Routes (all GET, `repo` = "owner/name"):
 *   /wo-github/meta?repo=            -> repo About card fields
 *   /wo-github/readme?repo=          -> { name, text } | { absent: true }
 *   /wo-github/commits?repo=&page=   -> { commits: [...] }  (default branch)
 *   /wo-github/commit?repo=&sha=     -> { ...commit, files: [...] }
 *
 * Caching: meta/readme TTL 5 min, commit lists 2 min, single-commit detail
 * FOREVER (a sha's diff never changes; LRU-capped). Rate-limit exhaustion
 * surfaces as 503 with the reset epoch so the tab can say when it retries.
 * Set GITHUB_TOKEN in the harness environment to lift the 60 req/hour
 * anonymous ceiling; without it everything still works on public repos.
 */

export const name = 'wo-github'

export const inject = ['webServer']

const msg = (error) => (error && error.message ? error.message : String(error))

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA_RE = /^[0-9a-f]{7,40}$/

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

const repoOf = (url) => {
  const repo = new URL(url, 'http://localhost').searchParams.get('repo')
  if (repo === null || !REPO_RE.test(repo)) return undefined
  return repo
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

  // ---- About card ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/meta',
    handler: handler(async (req, res) => {
      const repo = repoOf(req.url)
      if (repo === undefined) throw Object.assign(new Error('repo must be "owner/name"'), { status: 400 })
      const cached = cacheGet(metaCache, repo, META_TTL_MS)
      if (cached !== undefined) return sendJson(res, 200, cached)
      const raw = await ghJson('/repos/' + repo)
      const data = {
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
      cachePut(metaCache, repo, data)
      sendJson(res, 200, data)
    }),
  }))

  // ---- README (name + decoded text; a repo may have none) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/readme',
    handler: handler(async (req, res) => {
      const repo = repoOf(req.url)
      if (repo === undefined) throw Object.assign(new Error('repo must be "owner/name"'), { status: 400 })
      const cached = cacheGet(readmeCache, repo, README_TTL_MS)
      if (cached !== undefined) return sendJson(res, 200, cached)
      let raw
      try {
        raw = await ghJson('/repos/' + repo + '/readme')
      } catch (error) {
        if (error && error.status === 404) {
          const data = { absent: true }
          cachePut(readmeCache, repo, data)
          return sendJson(res, 200, data)
        }
        throw error
      }
      const data = {
        name: raw.name,
        text: Buffer.from(raw.content, 'base64').toString('utf8'),
      }
      cachePut(readmeCache, repo, data)
      sendJson(res, 200, data)
    }),
  }))

  // ---- commit list (default branch, 25 per page) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/commits',
    handler: handler(async (req, res) => {
      const repo = repoOf(req.url)
      if (repo === undefined) throw Object.assign(new Error('repo must be "owner/name"'), { status: 400 })
      const pageRaw = new URL(req.url, 'http://localhost').searchParams.get('page')
      const page = Math.max(1, Math.min(100, Number.isFinite(Number(pageRaw)) && Number(pageRaw) > 0 ? Math.floor(Number(pageRaw)) : 1))
      const key = repo + '|' + page
      const cached = cacheGet(commitsCache, key, COMMITS_TTL_MS)
      if (cached !== undefined) return sendJson(res, 200, cached)
      const raw = await ghJson('/repos/' + repo + '/commits?per_page=25&page=' + page)
      const data = {
        page,
        count: raw.length,
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

  // ---- one commit: message, stats, per-file patches (immutable -> LRU) ----
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/wo-github/commit',
    handler: handler(async (req, res) => {
      const repo = repoOf(req.url)
      if (repo === undefined) throw Object.assign(new Error('repo must be "owner/name"'), { status: 400 })
      const url = new URL(req.url, 'http://localhost')
      const sha = url.searchParams.get('sha')
      if (sha === null || !SHA_RE.test(sha)) throw Object.assign(new Error('sha must be 7-40 hex chars'), { status: 400 })
      const key = repo + '|' + sha
      const cached = cacheGet(commitCache, key)
      if (cached !== undefined) return sendJson(res, 200, cached)
      const raw = await ghJson('/repos/' + repo + '/commits/' + sha)
      const data = {
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
      cachePut(commitCache, key, data, COMMIT_LRU_MAX)
      sendJson(res, 200, data)
    }),
  }))

  return () => { for (const d of disposers) { try { d() } catch (e) {} } }
}
