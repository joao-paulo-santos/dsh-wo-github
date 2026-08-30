/**
 * dsh-wo-github - browser half.
 *
 * Contributes a GitHub subtab to the Workspace Overview tab (injected
 * face: 'workspaceOverview'). Three panes, laid out like the site:
 *
 *   Overview  repo About card (description, topics, stars/forks/issues,
 *             language, license, default branch, pushed at)
 *   README    the repository README, rendered through dsh-md-view
 *             (optional; without it the raw markdown shows as text)
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
 */
window.__ModuleLoader__.load({ id: 'dsh-wo-github', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  const { relativeTime } = require('@deepseek-ai/dsh-client-ui-primitives')

  let overviewService = undefined            // workspaceOverview (set in apply)
  let diffServiceResolver = () => undefined  // optional dsh-diff-view (set in apply)
  let mdServiceResolver = () => undefined    // optional dsh-md-view (set in apply)

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

  /** Render one hunk: GitHub-style unified rows; adjacent -/+ runs pair into
   *  replace rows with word highlights when dsh-diff-view is present. */
  const renderHunk = (hunk, hunkIndex) => {
    const cells = []
    let cellRow = 0
    const diffService = diffServiceResolver()
    const pushRow = (cls, sign, number, content) => {
      cellRow += 1
      const gridRow = String(cellRow)
      cells.push(React.createElement('div', { key: 'n' + cellRow, className: 'adf-num', style: { gridColumn: '1', gridRow } },
        number === undefined ? '' : String(number)))
      cells.push(React.createElement('div', { key: 's' + cellRow, className: 'adf-sign', style: { gridColumn: '2', gridRow } }, sign))
      cells.push(React.createElement('div', { key: 'c' + cellRow, className: 'adf-cell ' + cls, style: { gridColumn: '3', gridRow } }, content))
    }
    const spansOf = (before, after, side) => {
      if (diffService === undefined) return before !== undefined ? before : after
      const spans = diffService.engine.wordSpansOfLinePair(before !== undefined ? before : '', after !== undefined ? after : '')
      return diffService.engine.wordSpanElements(side === 'del' ? spans.removedSpans : spans.addedSpans, side === 'del' ? 'adf-w-del' : 'adf-w-add')
    }
    let delRun = []
    let addRun = []
    const flush = () => {
      const pairCount = Math.min(delRun.length, addRun.length)
      for (let i = 0; i < pairCount; i++) {
        const del = delRun[i]
        const add = addRun[i]
        pushRow('adf-del', '-', del.oldNo, diffService !== undefined ? spansOf(del.text, add.text, 'del') : del.text)
        pushRow('adf-add', '+', add.newNo, diffService !== undefined ? spansOf(del.text, add.text, 'add') : add.text)
      }
      for (let i = pairCount; i < delRun.length; i++) pushRow('adf-del', '-', delRun[i].oldNo, delRun[i].text)
      for (let i = pairCount; i < addRun.length; i++) pushRow('adf-add', '+', addRun[i].newNo, addRun[i].text)
      delRun = []
      addRun = []
    }
    for (const row of hunk.rows) {
      if (row.k === 'ctx') { flush(); pushRow('adf-ctx', '', row.newNo, row.text) }
      else if (row.k === 'del') delRun.push(row)
      else addRun.push(row)
    }
    flush()
    return React.createElement(React.Fragment, { key: 'h' + hunkIndex },
      React.createElement('div', { className: 'adf-hunkgap wog-hunkhead', style: { gridColumn: '1 / -1' } },
        '@@ -' + hunk.oldStart + ' +' + hunk.newStart + ' @@'),
      cells)
  }

  const FilePatch = ({ file }) => React.createElement('div', { className: 'wog-file' },
    React.createElement('div', { className: 'wog-file-head' },
      React.createElement('span', { className: 'wog-file-name' }, file.filename),
      React.createElement('span', { className: 'wog-file-status' }, file.status),
      React.createElement('span', { className: 'wog-count-add' }, '+' + (file.additions ?? 0)),
      React.createElement('span', { className: 'wog-count-del' }, '\u2212' + (file.deletions ?? 0))),
    file.patch === undefined
      ? React.createElement('p', { className: 'wog-file-nopatch' }, 'No patch available (binary or too large).')
      : React.createElement('div', { className: 'adf-grid adf-grid-unified wog-patch' },
          hunksOfPatch(file.patch).map(renderHunk)))

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
        React.createElement('span', { className: 'wog-dim' }, 'HEAD: '), d.local.subject) : null)
  }

  const ReadmePane = ({ loc }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '')
    const state = useRepoData('/wo-github/readme?' + query, [loc.path, loc.repo])
    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading README…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })
    if (state.data.absent) return React.createElement(PaneMessage, { text: 'This repository has no README.' })
    const mdView = mdServiceResolver()
    if (mdView === undefined) {
      return React.createElement('div', null,
        React.createElement('p', { className: 'wog-dim' }, 'dsh-md-view not installed — raw README:'),
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
    { id: 'readme', label: 'README' },
    { id: 'commits', label: 'Commits' },
  ]

  const GithubTab = (props) => {
    // Upstream dropped `recentWorkspaceId` from the workspace snapshot
    // (dsh 0.1.2): the current workspace is the open session's workspace,
    // falling back to the most recently active one.
    const sessionId = props.useSessions((st) => st.current)
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
      return React.createElement('p', { className: 'wog-dim' }, 'No repository here — this workspace has no git clone and no github.com remote.')
    }
    const active = PANES.some((p) => p.id === pane) ? pane : 'overview'
    const body = active === 'overview' ? React.createElement(OverviewPane, { loc })
      : active === 'readme' ? React.createElement(ReadmePane, { loc })
      : React.createElement(CommitsPane, { loc })
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

  module.exports = {
    name: 'wo-github-client',
    inject: ['workspaceOverview'],
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
        + '.wog-readme{max-width:820px}'
        + '.wog-rawpre{margin:0;padding:12px;font-size:12px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px;max-height:60vh;overflow:auto}'
        + '.wog-patch{padding:6px 0;font-size:12px}'
        + '.wog-hunkhead{font-style:normal;font-family:ui-monospace,monospace;font-size:11px}'
      document.head.appendChild(tag)

      const offTab = overviewService.registerTab({ id: 'github', label: 'GitHub', order: 10 }, GithubTab)

      return () => {
        try { offTab() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }

  // Test surface: pure helpers the client tests exercise without a DOM.
  module.exports._internal = { timeAgoOf, firstLineOf, hunksOfPatch, CommitsPane }

  return module.exports
} })
