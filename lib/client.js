/**
 * dsh-wo-github - browser half.
 *
 * Contributes a GitHub subtab to the Workspace Overview tab (injected
 * face: 'workspaceOverview'). Two panes, laid out like the site:
 *
 *   Overview  repo About card (description, topics, stars/forks/issues,
 *             language, license, default branch, pushed at) with the
 *             README rendered beneath it (through dsh-md-view when
 *             installed; raw text otherwise; silent when absent)
 *   Commits   the default-branch history; picking a commit shows its
 *             message, stats, and per-file unified patches with true line
 *             numbers and (when dsh-diff-view is installed) word highlights
 *
 * Local first: the host reads the workspace's own clone (git log / git
 * show / the committed README) and only queries api.github.com for what
 * git cannot know (stars, issues, topics) or when the clone fails. A
 * workspace with a git repo but no github.com remote still gets README +
 * Commits with local About facts; only a workspace with no repository at
 * all shows the empty state.
 *
 * Also contributes a BRANCH PILL to the composer's left row (beside the
 * persona picker): the GitHub mark plus the workspace's checked-out branch,
 * polled live so agent checkouts update it. Hidden when the workspace is
 * not a git repo; a detached HEAD shows the short sha. With a github.com
 * remote the pill links to the branch's tree.
 */
window.__ModuleLoader__.load({ id: 'dsh-wo-github', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  const { relativeTime } = require('@deepseek-ai/dsh-client-ui-primitives')

  let overviewService = undefined            // workspaceOverview (set in apply)
  let diffServiceResolver = () => undefined  // optional dsh-diff-view (set in apply)
  let mdServiceResolver = () => undefined    // optional dsh-md-view (set in apply)

  // Standard GitHub mark, currentColor so themes apply.
  const GithubIcon = () => React.createElement('svg', {
    width: '13', height: '13', viewBox: '0 0 16 16', 'aria-hidden': 'true',
    fill: 'currentColor',
  }, React.createElement('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }))

  // ---- small helpers ------------------------------------------------------

  // Bucketing comes from the harness primitive; only the English words live here.
  const TIME_UNITS = {
    minutes: (n) => n + (n === 1 ? ' minute ago' : ' minutes ago'),
    hours: (n) => n + (n === 1 ? ' hour ago' : ' hours ago'),
    days: (n) => n + (n === 1 ? ' day ago' : ' days ago'),
    months: (n) => n + (n === 1 ? ' month ago' : ' months ago'),
    years: (n) => n + (n === 1 ? ' year ago' : ' years ago'),
  }
  const timeAgoOf = (iso) => {
    const then = new Date(iso).getTime()
    if (!Number.isFinite(then)) return ''
    const { unit, n } = relativeTime(then, Date.now())
    return unit === 'now' ? 'just now' : TIME_UNITS[unit](n)
  }

  const firstLineOf = (message) => {
    const cut = String(message || '').indexOf('\n')
    return cut === -1 ? String(message || '') : String(message).slice(0, cut)
  }

  // ---- commit patch: hunks ------------------------------------------------

  /** Parse one GitHub file patch into hunks with true line bases:
   *  [{ oldStart, newStart, rows: [{ k: 'ctx'|'del'|'add', text, oldNo, newNo }] }] */
  const hunksOfPatch = (patch) => {
    const hunks = []
    const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    let current = undefined
    for (const line of String(patch).split('\n')) {
      const h = HUNK_RE.exec(line)
      if (h !== null) {
        current = { oldStart: Number(h[1]), newStart: Number(h[3]), rows: [] }
        hunks.push(current)
        continue
      }
      if (current === undefined || line.startsWith('\\')) continue   // "\ No newline at end of file"
      if (line.startsWith('+')) current.rows.push({ k: 'add', text: line.slice(1) })
      else if (line.startsWith('-')) current.rows.push({ k: 'del', text: line.slice(1) })
      else current.rows.push({ k: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
    }
    let hunk = hunks[0]
    let oldNo = hunk !== undefined ? hunk.oldStart : 0
    let newNo = hunk !== undefined ? hunk.newStart : 0
    for (const hk of hunks) {
      oldNo = hk.oldStart
      newNo = hk.newStart
      for (const row of hk.rows) {
        row.oldNo = row.k === 'add' ? undefined : oldNo
        row.newNo = row.k === 'del' ? undefined : newNo
        if (row.k !== 'add') oldNo += 1
        if (row.k !== 'del') newNo += 1
      }
    }
    return hunks
  }

  /** Render a file patch: the shared FileDiff-style component when
   *  dsh-diff-view is present, the raw patch text otherwise. */
  const renderPatch = (patch) => {
    const diffService = diffServiceResolver()
    if (diffService === undefined) {
      return React.createElement('pre', { className: 'wog-patch-plain' }, patch)
    }
    const hunks = hunksOfPatch(patch)
    const diffHunks = hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.rows.filter((row) => row.k !== 'add').length,
      newStart: hunk.newStart,
      newLines: hunk.rows.filter((row) => row.k !== 'del').length,
      lines: hunk.rows.map((row) => (row.k === 'del' ? '-' : row.k === 'add' ? '+' : ' ') + row.text),
    }))
    const Patch = diffService.diffFileComponent({ initialMode: 'unified', showToggle: false })
    return Patch({ hunks: diffHunks })
  }

  const FilePatch = ({ file }) => React.createElement('div', { className: 'wog-file' },
    React.createElement('div', { className: 'wog-file-head' },
      React.createElement('span', { className: 'wog-file-name' }, file.filename),
      React.createElement('span', { className: 'wog-file-status' }, file.status),
      React.createElement('span', { className: 'wog-count-add' }, '+' + (file.additions ?? 0)),
      React.createElement('span', { className: 'wog-count-del' }, '\u2212' + (file.deletions ?? 0))),
    file.patch === undefined
      ? React.createElement('p', { className: 'wog-file-nopatch' }, 'No patch available (binary or too large).')
      : renderPatch(file.patch))

  // ---- panes --------------------------------------------------------------

  const fetchJson = async (path, ok) => {
    const res = await fetch(path)
    if (!res.ok) {
      let message = 'request failed'
      try { const body = await res.json(); if (body && body.error) message = body.error } catch (e) {}
      throw new Error(message)
    }
    return res.json()
  }

  const useRepoData = (path, deps) => {
    const [state, setState] = React.useState({ phase: 'loading' })
    React.useEffect(() => {
      let live = true
      setState({ phase: 'loading' })
      fetchJson(path)
        .then((data) => { if (live) setState({ phase: 'ready', data }) },
          (error) => { if (live) setState({ phase: 'error', message: error.message }) })
      return () => { live = false }
    }, deps)
    return state
  }

  const PaneMessage = ({ text, error }) => React.createElement('p', { className: error ? 'wog-error' : 'wog-dim' }, text)

  const OverviewPane = ({ loc }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '')
    const state = useRepoData('/wo-github/meta?' + query, [loc.path, loc.repo])
    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading repository…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })
    const d = state.data
    const g = d.github
    const stat = (value, label) => React.createElement('div', { className: 'wog-stat' },
      React.createElement('span', { className: 'wog-stat-value' }, value === undefined ? '\u2013' : String(value)),
      React.createElement('span', { className: 'wog-stat-label' }, label))
    return React.createElement('div', { className: 'wog-overview' },
      g !== undefined ? React.createElement('div', { className: 'wog-repo-head' },
        g.ownerAvatar ? React.createElement('img', { className: 'wog-avatar', src: g.ownerAvatar, alt: '' }) : null,
        React.createElement('div', { className: 'wog-repo-title' },
          React.createElement('a', { className: 'wog-repo-name', href: g.htmlUrl, target: '_blank', rel: 'noreferrer' }, g.fullName),
          g.isPrivate ? React.createElement('span', { className: 'wog-chip' }, 'private') : null)) : null,
      g !== undefined && g.description ? React.createElement('p', { className: 'wog-repo-desc' }, g.description) : null,
      g !== undefined && g.topics.length > 0 ? React.createElement('div', { className: 'wog-topics' },
        g.topics.map((topic) => React.createElement('span', { key: topic, className: 'wog-chip' }, topic))) : null,
      g !== undefined ? React.createElement('div', { className: 'wog-stats' },
        stat(g.stars, 'stars'), stat(g.watchers, 'watchers'), stat(g.forks, 'forks'), stat(g.openIssues, 'issues')) : null,
      React.createElement('div', { className: 'wog-facts' },
        d.local !== undefined && d.local.branch ? React.createElement('span', { className: 'wog-fact' }, 'branch ' + d.local.branch) : null,
        d.local !== undefined && d.local.shortSha ? React.createElement('span', { className: 'wog-fact' }, React.createElement('span', { className: 'wog-sha' }, d.local.shortSha)) : null,
        d.local !== undefined && d.local.lastCommitAt ? React.createElement('span', { className: 'wog-fact' }, 'last commit ' + timeAgoOf(d.local.lastCommitAt)) : null,
        g !== undefined && g.language ? React.createElement('span', { className: 'wog-fact' }, g.language) : null,
        g !== undefined && g.license ? React.createElement('span', { className: 'wog-fact' }, g.license + ' license') : null,
        g !== undefined && g.homepage ? React.createElement('a', { className: 'wog-fact mdv-a', href: g.homepage, target: '_blank', rel: 'noreferrer' }, g.homepage) : null,
        g !== undefined && g.pushedAt ? React.createElement('span', { className: 'wog-fact' }, 'pushed ' + timeAgoOf(g.pushedAt)) : null),
      d.local !== undefined && d.local.subject ? React.createElement('p', { className: 'wog-repo-desc' },
        React.createElement('span', { className: 'wog-dim' }, 'HEAD: '), d.local.subject) : null,
      React.createElement(ReadmeSection, { loc }))
  }

  /** README section at the bottom of the Overview pane: silent while
   *  loading, nothing when the repo has none, raw text without dsh-md-view. */
  const ReadmeSection = ({ loc }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '')
    const state = useRepoData('/wo-github/readme?' + query, [loc.path, loc.repo])
    if (state.phase === 'loading') return null
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })
    if (state.data.absent) return null
    const mdView = mdServiceResolver()
    if (mdView === undefined) {
      return React.createElement('div', { className: 'wog-readme' },
        React.createElement('p', { className: 'wog-dim' }, 'dsh-md-view not installed. raw README:'),
        React.createElement('pre', { className: 'wog-rawpre' }, state.data.text))
    }
    return React.createElement(mdView.component({ text: state.data.text, links: loc.repo !== undefined ? { repo: loc.repo } : {}, className: 'wog-readme' }), {})
  }

  const CommitDetail = ({ loc, sha, onBack }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '') + '&sha=' + encodeURIComponent(sha)
    const state = useRepoData('/wo-github/commit?' + query, [loc.path, loc.repo, sha])
    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading commit…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })
    const c = state.data
    return React.createElement('div', { className: 'wog-commit-detail' },
      React.createElement('button', { type: 'button', className: 'wog-back', onClick: onBack }, '\u2190 All commits'),
      React.createElement('div', { className: 'wog-commit-head' },
        React.createElement('div', { className: 'wog-commit-message' }, c.message),
        React.createElement('div', { className: 'wog-commit-meta' },
          c.author || 'unknown', c.login ? ' (' + c.login + ')' : '',
          ' \u00b7 ' + timeAgoOf(c.date),
          ' \u00b7 ', React.createElement('span', { className: 'wog-sha' }, c.sha),
          ' \u00b7 ',
          React.createElement('span', { className: 'wog-count-add' }, '+' + (c.additions ?? 0)),
          ' ',
          React.createElement('span', { className: 'wog-count-del' }, '\u2212' + (c.deletions ?? 0)))),
      c.files.length === 0
        ? React.createElement(PaneMessage, { text: 'No file changes in this commit.' })
        : c.files.map((file, i) => React.createElement(FilePatch, { key: file.filename + '-' + i, file })))
  }

  const CommitsPane = ({ loc }) => {
    const [page, setPage] = React.useState(1)
    const [selected, setSelected] = React.useState(undefined)
    // ALL hooks run before any early return: opening the detail view must
    // not change this component's hook count (React error #300).
    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '') + '&page=' + page
    const state = useRepoData('/wo-github/commits?' + query, [loc.path, loc.repo, page])
    if (selected !== undefined) {
      return React.createElement(CommitDetail, { loc, sha: selected, onBack: () => { setSelected(undefined) } })
    }
    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading commits…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })
    const commits = Array.isArray(state.data.commits) ? state.data.commits : []
    if (commits.length === 0) return React.createElement(PaneMessage, { text: 'No commits on this branch.' })
    return React.createElement('div', { className: 'wog-commits' },
      commits.map((c) => React.createElement('button', {
        key: c.sha, type: 'button', className: 'wog-commit-row',
        onClick: () => { setSelected(c.sha) },
      },
      React.createElement('span', { className: 'wog-commit-line' }, firstLineOf(c.message)),
      React.createElement('span', { className: 'wog-commit-sub' },
        React.createElement('span', { className: 'wog-sha' }, c.sha.slice(0, 7)),
        ' ', c.author || 'unknown',
        c.login ? ' (' + c.login + ')' : '',
        ' \u00b7 ' + timeAgoOf(c.date)))),
      React.createElement('div', { className: 'wog-pager' },
        page > 1 ? React.createElement('button', { type: 'button', className: 'wog-pager-btn', onClick: () => { setPage(page - 1) } }, '\u2190 Newer') : null,
        state.data.hasMore ? React.createElement('button', { type: 'button', className: 'wog-pager-btn', onClick: () => { setPage(page + 1) } }, 'Older \u2192') : null))
  }

  // ---- the tab ------------------------------------------------------------

  const locCache = new Map()    // workspace path -> { path, repo? } | null | undefined(unknown)

  const PANES = [
    { id: 'overview', label: 'Overview' },
    { id: 'commits', label: 'Commits' },
  ]

  const GithubTab = (props) => {
    // The current workspace is the open session's workspace, falling back
    // to the most recently active one.
    const sessionId = props.sessionId ?? props.useSessions((st) => st.current)
    const sessionsById = props.useSessions((st) => st.byId)
    const workspacePath = props.useWorkspaces((st) => {
      if (sessionId !== undefined) {
        const hit = st.items.find((item) => item.sessionIds.includes(sessionId))
        if (hit !== undefined) return hit.path
      }
      let bestPath, bestTime = Number.NEGATIVE_INFINITY
      for (const item of st.items) {
        let latest = Number.NEGATIVE_INFINITY
        for (const sid of item.sessionIds) {
          const session = sessionsById[sid]
          if (session !== undefined) latest = Math.max(latest, session.updatedAt)
        }
        if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(item.createdAt)
        if (latest > bestTime) { bestTime = latest; bestPath = item.path }
      }
      return bestPath
    })
    // loc: what the panes render against — the workspace path plus the
    // github.com slug when one exists (host: local git first, API second).
    const [loc, setLoc] = React.useState(locCache.has(workspacePath) ? locCache.get(workspacePath) : undefined)
    const [pane, setPane] = React.useState('overview')
    React.useEffect(() => {
      if (typeof workspacePath !== 'string' || workspacePath === '') return
      if (locCache.has(workspacePath)) { setLoc(locCache.get(workspacePath)); return }
      let live = true
      // slug from dsh-workspace-overview's github-remote route, git-ness
      // from our own locate route
      const slugPromise = fetch('/workspace-overview/github?path=' + encodeURIComponent(workspacePath))
        .then((r) => (r.ok ? r.json() : { github: null }))
        .then((body) => (body !== null && typeof body === 'object' && typeof body.github === 'string' && body.github !== '' ? body.github : null),
          () => null)
      const gitPromise = fetch('/wo-github/locate?path=' + encodeURIComponent(workspacePath))
        .then((r) => (r.ok ? r.json() : { git: false }))
        .then((body) => (body !== null && typeof body === 'object' && body.git === true), () => false)
      Promise.all([slugPromise, gitPromise]).then(([slug, hasGit]) => {
        const next = hasGit || slug !== null ? { path: workspacePath, repo: slug ?? undefined } : null
        locCache.set(workspacePath, next)
        if (live) setLoc(next)
      })
      return () => { live = false }
    }, [workspacePath])

    if (typeof workspacePath !== 'string' || workspacePath === '') {
      return React.createElement('p', { className: 'wog-dim' }, 'No workspace context.')
    }
    if (loc === undefined) return React.createElement('p', { className: 'wog-dim' }, 'Looking for a repository…')
    if (loc === null) {
      return React.createElement('p', { className: 'wog-dim' }, 'No repository here. this workspace has no git clone and no github.com remote.')
    }
    const active = PANES.some((p) => p.id === pane) ? pane : 'overview'
    const body = active === 'commits' ? React.createElement(CommitsPane, { loc })
      : React.createElement(OverviewPane, { loc })
    return React.createElement('div', { className: 'wog-page' },
      React.createElement('div', { className: 'wog-subtabs' },
        PANES.map((p) => React.createElement('button', {
          key: p.id, type: 'button',
          className: 'wog-subtab' + (active === p.id ? ' wog-subtab-active' : ''),
          onClick: () => { setPane(p.id) },
        }, p.label))),
      React.createElement('div', { className: 'wog-pane' }, body))
  }

  // ---- plugin -------------------------------------------------------------

  // ---- the composer branch pill ---------------------------------------------

  const BRANCH_POLL_MS = 2500
  const branchCache = new Map()   // workspace path -> { branch, sha } | null
  const slugCache = new Map()     // workspace path -> 'owner/repo' | null

  /** The composer's live checkout pill: GitHub mark + branch (or short sha
   *  for detached HEAD), refetched on an interval so agent checkouts update
   *  it. Renders nothing outside a git repo. */
  const BranchPill = (props) => {
    const sessionId = props.sessionId !== undefined && props.sessionId !== null
      ? props.sessionId
      : (props.useSessions !== undefined ? props.useSessions((s) => s.current) : undefined)
    const cwd = props.useSessions !== undefined
      ? props.useSessions((st) => {
        const summary = sessionId !== undefined && st.byId !== undefined && st.byId !== null
          ? st.byId[sessionId] : undefined
        return summary !== undefined && typeof summary.cwd === 'string' ? summary.cwd : undefined
      })
      : undefined
    const [branchState, setBranchState] = React.useState(
      typeof cwd === 'string' && branchCache.has(cwd) ? branchCache.get(cwd) : undefined)
    const [slug, setSlug] = React.useState(
      typeof cwd === 'string' && slugCache.has(cwd) ? slugCache.get(cwd) : undefined)

    React.useEffect(() => {
      if (typeof cwd !== 'string' || cwd === '') return undefined
      let live = true
      const same = (a, b) => a === b
        || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
          && a.branch === b.branch && a.sha === b.sha)
      const tick = () => {
        fetch('/wo-github/branch?path=' + encodeURIComponent(cwd))
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => {
            if (!live) return
            const value = body !== null && typeof body === 'object'
              ? { branch: typeof body.branch === 'string' ? body.branch : null,
                  sha: typeof body.sha === 'string' ? body.sha : null }
              : null
            branchCache.set(cwd, value)
            setBranchState((prev) => same(prev, value) ? prev : value)
          }, () => {})
      }
      tick()
      const interval = setInterval(tick, BRANCH_POLL_MS)
      const onFocus = () => { tick() }
      window.addEventListener('focus', onFocus)
      return () => {
        live = false
        clearInterval(interval)
        window.removeEventListener('focus', onFocus)
      }
    }, [cwd])

    React.useEffect(() => {
      if (typeof cwd !== 'string' || cwd === '' || slugCache.has(cwd)) return undefined
      let live = true
      fetch('/wo-github/locate?path=' + encodeURIComponent(cwd))
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (!live) return
          const value = body !== null && typeof body === 'object' && typeof body.slug === 'string'
            ? body.slug : null
          slugCache.set(cwd, value)
          setSlug(value)
        }, () => { slugCache.set(cwd, null) })
      return () => { live = false }
    }, [cwd])

    if (branchState === undefined) return null
    if (branchState === null || (branchState.branch === null && branchState.sha === null)) return null
    const detached = branchState.branch === null
    const label = detached ? branchState.sha : branchState.branch
    const href = !detached && typeof slug === 'string' && slug !== ''
      ? 'https://github.com/' + slug + '/tree/' + branchState.branch : undefined
    const className = 'wog-branchpill'
    const children = [React.createElement(GithubIcon, { key: 'icon' }),
      React.createElement('span', { key: 'label', className: 'wog-branchpill-label' }, label)]
    return href !== undefined
      ? React.createElement('a', { className, href, target: '_blank', rel: 'noreferrer',
          title: 'branch ' + branchState.branch + ' · open on GitHub' }, children)
      : React.createElement('span', { className,
          title: detached ? 'detached HEAD at ' + branchState.sha : 'branch ' + branchState.branch }, children)
  }

  module.exports = {
    name: 'wo-github-client',
    inject: ['workspaceOverview', 'slots'],
    apply(ctx) {
      overviewService = ctx.workspaceOverview
      diffServiceResolver = () => { try { return ctx.get('diffView') } catch (e) { return undefined } }
      mdServiceResolver = () => { try { return ctx.get('mdView') } catch (e) { return undefined } }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-wo-github'
      tag.textContent = '.wog-page{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary)}'
        + '.wog-subtabs{flex:none;display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--dsw-alias-label-tertiary)}'
        + '.wog-subtab{font:inherit;font-size:12.5px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-bottom:2px solid transparent;opacity:.65;margin-bottom:-1px}'
        + '.wog-subtab:hover{opacity:1}'
        + '.wog-subtab-active{opacity:1;border-bottom-color:#3b82f6;font-weight:600}'
        + '.wog-pane{flex:1;min-height:0;overflow-y:auto;padding-right:4px}'
        + '.wog-dim{margin:0;font-size:13px;opacity:.65}'
        + '.wog-error{margin:0;font-size:12.5px;color:#ef4444}'
        // overview
        + '.wog-overview{display:flex;flex-direction:column;gap:14px}'
        + '.wog-repo-head{display:flex;align-items:center;gap:12px}'
        + '.wog-avatar{width:40px;height:40px;border-radius:50%;background:var(--dsw-alias-bg-layer-2)}'
        + '.wog-repo-name{font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary);text-decoration:none}'
        + '.wog-repo-name:hover{text-decoration:underline}'
        + '.wog-repo-desc{margin:0;font-size:13px;line-height:1.55;opacity:.85}'
        + '.wog-topics{display:flex;flex-wrap:wrap;gap:6px}'
        + '.wog-chip{font-size:11px;line-height:1;padding:4px 9px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-label-tertiary)}'
        + '.wog-stats{display:flex;gap:10px;flex-wrap:wrap}'
        + '.wog-stat{display:flex;flex-direction:column;gap:2px;padding:10px 14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:10px;min-width:84px}'
        + '.wog-stat-value{font-size:16px;font-weight:650}'
        + '.wog-stat-label{font-size:11px;opacity:.6;text-transform:uppercase;letter-spacing:.04em}'
        + '.wog-facts{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;opacity:.75}'
        + '.wog-fact{color:inherit}'
        // commits
        + '.wog-commits{display:flex;flex-direction:column;gap:2px}'
        + '.wog-commit-row{font:inherit;text-align:left;cursor:pointer;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:inherit;display:flex;flex-direction:column;gap:2px}'
        + '.wog-commit-row:hover{background:var(--dsw-alias-bg-layer-2)}'
        + '.wog-commit-line{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.wog-commit-sub{font-size:11.5px;opacity:.6}'
        + '.wog-sha{font-family:ui-monospace,monospace;font-size:.95em;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}'
        + '.wog-pager{display:flex;gap:8px;padding:10px 0 4px}'
        + '.wog-pager-btn{font:inherit;font-size:12px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px}'
        + '.wog-pager-btn:hover{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-back{font:inherit;font-size:12px;padding:4px 0 10px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;text-align:left}'
        + '.wog-back:hover{color:var(--dsw-alias-label-primary)}'
        + '.wog-commit-detail{display:flex;flex-direction:column;gap:12px}'
        + '.wog-commit-message{font-size:14px;font-weight:650;white-space:pre-wrap;word-break:break-word}'
        + '.wog-commit-meta{font-size:12px;opacity:.7;margin-top:2px}'
        // files + patches (diff-row classes come from dsh-diff-view)
        + '.wog-file{border:1px solid var(--dsw-alias-label-tertiary);border-radius:10px;overflow:hidden}'
        + '.wog-file-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-label-tertiary);font-size:12px}'
        + '.wog-file-name{font-family:ui-monospace,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.wog-file-status{font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);text-transform:uppercase;letter-spacing:.03em}'
        + '.wog-count-add{color:#3fb950;font-weight:600}'
        + '.wog-count-del{color:#f85149;font-weight:600}'
        + '.wog-file-nopatch{margin:0;padding:10px 12px;font-size:12px;font-style:italic;opacity:.6}'
        + '.wog-readme{max-width:820px;margin-top:22px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l3)}'
        + '.wog-rawpre{margin:0;padding:12px;font-size:12px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px;max-height:60vh;overflow:auto}'
        + '.wog-patch-plain{margin:0;padding:10px 12px;font:var(--dsw-font-markdown-code-block);font-size:12px;overflow:auto;max-height:340px}'
        // Composer-row convention (matches the persona combo's ghost button):
        // 28px tall, 13px text, quiet background, hover fill, no border.
        + '.wog-branchpill{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:500;height:28px;padding:0 8px;max-width:min(280px,40cqw);text-decoration:none;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:24px;outline:none}'
        + 'a.wog-branchpill{cursor:pointer}'
        + 'a.wog-branchpill:hover,a.wog-branchpill:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}'
        + 'span.wog-branchpill{cursor:default}'
        + '.wog-branchpill-label{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}'
      document.head.appendChild(tag)

      const offTab = overviewService.registerTab({ id: 'github', label: 'GitHub', order: 10 }, GithubTab)

      // The composer's left row, beside the persona picker.
      const offPill = ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'branch-pill', order: 35, label: 'Branch' },
        BranchPill))

      return () => {
        try { offTab() } catch (e) {}
        try { offPill() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }

  // Test surface: pure helpers the client tests exercise without a DOM.
  module.exports._internal = { timeAgoOf, firstLineOf, hunksOfPatch, CommitsPane, BranchPill }

  return module.exports
} })
