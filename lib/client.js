/**
 * dsh-wo-github - browser half.
 *
 * Contributes a GitHub subtab to the Workspace Overview tab (injected
 * face: 'workspaceOverview'). Three panes:
 *
 *   Overview  repo About card (description, topics, stars/forks/issues,
 *             language, license, default branch, pushed at) with the
 *             README rendered beneath it. The structure paints
 *             instantly from fetch-free facts (repo name from the git
 *             remote slug, branch from the pill's live cache); only
 *             genuinely fetched fields show skeletons (through dsh-md-view when
 *             installed; raw text otherwise; silent when absent)
 *   Stash     the checked-out branch's stashed changes: one row per
 *             entry with Pop (restore + remove) and Drop (discard);
 *             other branches' entries are noted, not listed. The pill
 *             routes here when the worktree is clean but stashes exist.
 *   Pending   the GitHub Desktop surface: ONE flat file list with
 *             three-state checkboxes (check = staged, dash = partially
 *             staged, empty = unstaged), staged line counts (+N in
 *             green, -M in red) and the commit box on the left, the
 *             selected file's diff on the right. The diff is ONE
 *             combined whole-file
 *             view (HEAD vs worktree; distant regions collapse into gap
 *             rows) where every changed line carries a stage checkmark
 *             (filled = staged; click to toggle) and every hunk header
 *             a checkmark that fills when all its lines are staged
 *             (click toggles the whole section). Split/Unified toggles;
 *             the commit box commits exactly what is staged
 *   History    the checked-out branch's history GitHub Desktop style:
 *             commit list on the left, the selected commit's changed
 *             files beside it, and the selected file's diff in the main
 *             area, all visible at once
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
  const { relativeTime, Button, Checkbox, Input, SegmentedControl } = require('@deepseek-ai/dsh-client-ui-primitives')

  let overviewService = undefined            // workspaceOverview (set in apply)
  let diffServiceResolver = () => undefined  // optional dsh-diff-view (set in apply)
  let mdServiceResolver = () => undefined    // optional dsh-md-view (set in apply)

  // Standard GitHub mark, currentColor so themes apply.
  const GithubIcon = () => React.createElement('svg', {
    width: '13', height: '13', viewBox: '0 0 16 16', 'aria-hidden': 'true',
    fill: 'currentColor',
  }, React.createElement('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }))

  /** A small amber travel-bag glyph for stashed changes (filled body,
   *  lighter handle) — count lives in the tooltip, not beside it. */
  const StashIcon = () => React.createElement('svg', {
    width: '13', height: '13', viewBox: '0 0 16 16', 'aria-hidden': 'true',
  },
  React.createElement('path', {
    d: 'M3 5.5h10l-.75 8.02a1.5 1.5 0 0 1-1.49 1.35H5.24a1.5 1.5 0 0 1-1.49-1.35L3 5.5Z',
    fill: '#d29922',
  }),
  React.createElement('path', {
    d: 'M5.6 5.5V4.2a2.4 2.4 0 0 1 4.8 0v1.3',
    fill: 'none', stroke: '#e3b341', 'stroke-width': '1.5', 'stroke-linecap': 'round',
  }),
  React.createElement('path', {
    d: 'M3 5.5h10',
    stroke: '#b0831d', 'stroke-width': '1.2', 'stroke-linecap': 'round',
  }))

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

  /** hunksOfPatch rows -> the native WorkspaceDiffHunk shape the shared
   *  diff component consumes ({oldStart, oldLines, newStart, newLines, lines}). */
  const diffHunksOfPatch = (patch) => hunksOfPatch(patch).map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.rows.filter((row) => row.k !== 'add').length,
    newStart: hunk.newStart,
    newLines: hunk.rows.filter((row) => row.k !== 'del').length,
    lines: hunk.rows.map((row) => (row.k === 'del' ? '-' : row.k === 'add' ? '+' : ' ') + row.text),
  }))

  /** Render a file patch: the shared FileDiff-style component when
   *  dsh-diff-view is present, the raw patch text otherwise. */
  const renderPatch = (patch, path) => {
    const diffService = diffServiceResolver()
    if (diffService === undefined) {
      return React.createElement('pre', { className: 'wog-patch-plain' }, patch)
    }
    const diffHunks = diffHunksOfPatch(patch)
    const Patch = diffService.diffFileComponent({ path, initialMode: 'unified', showToggle: false })
    // Element boundary, not a direct call: the diff component owns hooks and
    // renders once per file; calling it inline would tie its hook count to
    // the file count (React #310 on navigation).
    return React.createElement(Patch, { hunks: diffHunks })
  }

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
    // Structure renders IMMEDIATELY: the repo name comes from the git
    // remote slug (no fetch) and the branch from the pill's live cache;
    // only genuinely fetched fields (description, avatar, stars, ...)
    // show loading skeletons. No whole-page loading blank.
    const loading = state.phase === 'loading'
    const d = loading ? undefined : state.data
    const g = d !== undefined ? d.github : undefined
    const stat = (value, label) => React.createElement('div', { className: 'wog-stat' },
      React.createElement('span', { className: 'wog-stat-value' }, value === undefined ? '\u2013' : String(value)),
      React.createElement('span', { className: 'wog-stat-label' }, label))
    const skeleton = (width, extra) => React.createElement('span', {
      className: 'wog-skeleton' + (extra !== undefined ? ' ' + extra : ''),
      style: { width },
    }, '\u200b')
    // instant, fetch-free facts
    const slug = loc.repo
    const pillBranch = typeof branchCache.get(loc.path) === 'object' && branchCache.get(loc.path) !== null
      ? branchCache.get(loc.path).branch : undefined
    const name = g !== undefined ? g.fullName : slug
    const branch = (d !== undefined && d.local !== undefined ? d.local.branch : undefined) ?? pillBranch
    return React.createElement('div', { className: 'wog-overview' },
      state.phase === 'error' ? React.createElement(PaneMessage, { text: state.message, error: true }) : null,
      name !== undefined ? React.createElement('div', { className: 'wog-repo-head' },
        loading || g !== undefined
          ? (g !== undefined && g.ownerAvatar
              ? React.createElement('img', { className: 'wog-avatar', src: g.ownerAvatar, alt: '' })
              : (loading ? skeleton('40px', 'wog-skeleton-circle') : null))
          : null,
        React.createElement('div', { className: 'wog-repo-title' },
          g !== undefined && g.htmlUrl !== undefined
            ? React.createElement('a', { className: 'wog-repo-name', href: g.htmlUrl, target: '_blank', rel: 'noreferrer' }, name)
            : React.createElement('span', { className: 'wog-repo-name' }, name),
          g !== undefined && g.isPrivate ? React.createElement('span', { className: 'wog-chip' }, 'private') : null)) : null,
      loading
        ? React.createElement('p', { className: 'wog-repo-desc' }, skeleton('70%'))
        : (g !== undefined && g.description ? React.createElement('p', { className: 'wog-repo-desc' }, g.description) : null),
      g !== undefined && g.topics.length > 0 ? React.createElement('div', { className: 'wog-topics' },
        g.topics.map((topic) => React.createElement('span', { key: topic, className: 'wog-chip' }, topic))) : null,
      loading
        // the slug promises a github.com side, so its stats will come
        ? (slug !== undefined ? React.createElement('div', { className: 'wog-stats' },
            stat('\u2013', 'stars'), stat('\u2013', 'watchers'), stat('\u2013', 'forks'), stat('\u2013', 'issues')) : null)
        : (g !== undefined ? React.createElement('div', { className: 'wog-stats' },
            stat(g.stars, 'stars'), stat(g.watchers, 'watchers'), stat(g.forks, 'forks'), stat(g.openIssues, 'issues')) : null),
      React.createElement('div', { className: 'wog-facts' },
        branch !== undefined ? React.createElement('span', { className: 'wog-fact' }, 'branch ' + branch) : null,
        d !== undefined && d.local !== undefined && d.local.shortSha ? React.createElement('span', { className: 'wog-fact' }, React.createElement('span', { className: 'wog-sha' }, d.local.shortSha)) : null,
        d !== undefined && d.local !== undefined && d.local.lastCommitAt ? React.createElement('span', { className: 'wog-fact' }, 'last commit ' + timeAgoOf(d.local.lastCommitAt)) : null,
        g !== undefined && g.language ? React.createElement('span', { className: 'wog-fact' }, g.language) : null,
        g !== undefined && g.license ? React.createElement('span', { className: 'wog-fact' }, g.license + ' license') : null,
        g !== undefined && g.homepage ? React.createElement('a', { className: 'wog-fact mdv-a', href: g.homepage, target: '_blank', rel: 'noreferrer' }, g.homepage) : null,
        g !== undefined && g.pushedAt ? React.createElement('span', { className: 'wog-fact' }, 'pushed ' + timeAgoOf(g.pushedAt)) : null),
      d !== undefined && d.local !== undefined && d.local.subject ? React.createElement('p', { className: 'wog-repo-desc' },
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
    // Element (not direct call): mdView may use hooks, so it must be its own
    // component boundary.
    return React.createElement(mdView.component({ text: state.data.text, links: loc.repo !== undefined ? { repo: loc.repo } : {}, className: 'wog-readme' }))
  }

  // ---- pending changes (GitHub Desktop surface) ---------------------------

  /** Split one file's unified diff into its file header and raw hunks; the
   *  excerpts recombine as single-hunk patches for `git apply --cached`.
   *  `lines` are the hunk body lines (no @@ head), indexed the same way the
   *  rendered rows' `src` indexes them. */
  const patchPartsOf = (text) => {
    if (typeof text !== 'string' || text === '') return { header: '', hunks: [] }
    const lines = text.split('\n')
    let header = ''
    const hunks = []
    let current = null
    for (const line of lines) {
      if (line.startsWith('@@')) {
        current = { head: line, body: [] }
        hunks.push(current)
      } else if (current === null) {
        if (line !== '') header += line + '\n'
      } else {
        current.body.push(line)
      }
    }
    return {
      header,
      hunks: hunks.map((h) => {
        while (h.body.length > 0 && h.body[h.body.length - 1] === '') h.body.pop()
        return { head: h.head, lines: h.body, raw: h.head + '\n' + h.body.join('\n') + '\n' }
      }),
    }
  }

  /** A single-line partial patch: stage/unstage exactly one + or - line of a
   *  hunk. Unselected deletions become context (they stay in the index),
   *  unselected additions are omitted (they never reach the index). Counts
   *  are recomputed by git apply --recount; the starts carry over. */
  const partialHunkPatch = (hunk, srcIndex) => {
    const out = []
    for (let i = 0; i < hunk.lines.length; i += 1) {
      const line = hunk.lines[i]
      const sign = line[0]
      const text = line.slice(1)
      if (sign === ' ') out.push(' ' + text)
      else if (sign === '-') out.push(i === srcIndex ? '-' + text : ' ' + text)
      else if (sign === '+') { if (i === srcIndex) out.push('+' + text) }
      else out.push(line)   // "\ No newline..." passthrough
    }
    return hunk.head + '\n' + out.join('\n') + '\n'
  }

  /** Parse one @@ head into the native WorkspaceDiffHunk shape over the
   *  hunk's own body lines (true starts/counts straight from git). */
  const HUNK_HEAD_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  const diffHunkOfParts = (hunk) => {
    const m = HUNK_HEAD_RE.exec(hunk.head)
    if (m === null) throw new Error('bad hunk header: ' + hunk.head)
    return {
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      lines: hunk.lines,
    }
  }

  // ---- staging model: per-line staged state over three patches -----------
  //
  // The combined patch (HEAD vs worktree) renders as the ONE diff; the
  // staged (HEAD vs index) and unstaged (index vs worktree) patches decide
  // per changed line whether it is already in the index:
  //   a deleted line (numbered in HEAD space) is staged iff the staged
  //     patch deletes that same HEAD line;
  //   an added line (numbered in worktree space) is staged iff the
  //     unstaged patch does NOT add it (then it came from the index).
  // Toggling maps a combined line back onto a single-line partial patch of
  // the staged or unstaged side; line numbers walk between HEAD, index and
  // worktree space through the other patch's context lines.

  /** Number a hunk's body lines on both sides ({sign, src, old?, new?}). */
  const numberedEntries = (hunk) => {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    return hunk.lines.map((line, src) => {
      const sign = line[0]
      const entry = { sign, src, text: line.slice(1) }
      if (sign !== '+') entry.old = oldNo++
      if (sign !== '-') entry.new = newNo++
      return entry
    })
  }

  /** Patch text -> { header, hunks:[{head, lines, raw, entries, starts}],
   *  delOldNos, addNewNos } ready for staging math. */
  const stagingPatchOf = (text) => {
    const parts = patchPartsOf(text)
    const hunks = parts.hunks.map((h) => {
      const base = diffHunkOfParts(h)
      return { ...base, head: h.head, raw: h.raw, entries: numberedEntries(base) }
    })
    const delOldNos = new Set()
    const addNewNos = new Set()
    for (const h of hunks) {
      for (const e of h.entries) {
        if (e.sign === '-' && e.old !== undefined) delOldNos.add(e.old)
        if (e.sign === '+' && e.new !== undefined) addNewNos.add(e.new)
      }
    }
    return { header: parts.header, hunks, delOldNos, addNewNos }
  }

  /** The entry (and its hunk) carrying number `no` on the given side. */
  const findEntryByNo = (patch, side, no) => {
    for (const h of patch.hunks) {
      for (const e of h.entries) {
        if (e[side] === no && (side === 'old' ? e.sign !== '+' : e.sign !== '-')) return { hunk: h, entry: e }
      }
    }
    return undefined
  }

  /** A line kept on both sides of a patch: its new-side number from its
   *  old-side number (hunk deltas + context walk). undefined if the line
   *  does not survive the patch. */
  const mapOldToNew = (hunks, oldNo) => {
    let delta = 0
    for (const h of hunks) {
      if (oldNo < h.oldStart) return oldNo + delta
      if (oldNo < h.oldStart + h.oldLines) {
        for (const e of h.entries) if (e.sign === ' ' && e.old === oldNo) return e.new
        return undefined
      }
      delta += h.newLines - h.oldLines
    }
    return oldNo + delta
  }

  /** Inverse: a kept line's old-side number from its new-side number. */
  const mapNewToOld = (hunks, newNo) => {
    let delta = 0
    for (const h of hunks) {
      if (newNo < h.newStart) return newNo - delta
      if (newNo < h.newStart + h.newLines) {
        for (const e of h.entries) if (e.sign === ' ' && e.new === newNo) return e.old
        return undefined
      }
      delta += h.newLines - h.oldLines
    }
    return newNo - delta
  }

  /** Where a head-deleted line (removed by the staged patch) re-inserts in
   *  the index: the index number of the first kept line after it, or one
   *  past the end when everything after was deleted. */
  const insertPosOf = (hunks, headNo, indexLength) => {
    let delta = 0
    for (const h of hunks) {
      for (const e of h.entries) {
        if (e.sign === ' ' && e.old > headNo) return e.new
      }
      if (headNo + 1 < h.oldStart) return headNo + 1 + delta
      delta += h.newLines - h.oldLines
    }
    return indexLength + 1
  }

  // Unstaging a single line must patch the INDEX against its own current
  // content: a reversed partial staged patch breaks when sibling staged
  // deletions turn into context the index no longer has. These builders
  // use the index blob the host sends with the diff.

  const indexLinesOf = (indexText) => {
    const lines = String(indexText ?? '').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  /** A forward patch removing exactly index line `at` (1-based). */
  const linePatchRemove = (header, indexLines, at) => {
    const from = Math.max(1, at - 3)
    const to = Math.min(indexLines.length, at + 3)
    const body = []
    for (let n = from; n <= to; n += 1) body.push((n === at ? '-' : ' ') + indexLines[n - 1])
    return header + '@@ -' + from + ',' + (to - from + 1) + ' +' + from + ',' + (to - from) + ' @@\n'
      + body.join('\n') + '\n'
  }

  /** A forward patch inserting `text` before index line `at` (1-based;
   *  indexLength + 1 appends at the end). */
  const linePatchInsert = (header, indexLines, at, text) => {
    const from = Math.max(1, at - 3)
    const to = Math.min(indexLines.length, at + 2)
    const body = []
    for (let n = from; n <= to; n += 1) body.push(' ' + indexLines[n - 1])
    const atPos = body.length - Math.max(0, to - at + 1)
    body.splice(atPos, 0, '+' + text)
    return header + '@@ -' + from + ',' + (to - from + 1) + ' +' + from + ',' + (to - from + 2) + ' @@\n'
      + body.join('\n') + '\n'
  }

  /** A whole untracked file as one all-additions patch. */
  const untrackedPatchOf = (file, text) => {
    const lines = String(text ?? '').split('\n')
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return '--- /dev/null\n+++ b/' + file + '\n@@ -0,0 +1,' + lines.length + ' @@\n'
      + lines.map((l) => '+' + l).join('\n')
  }

  let pendingViewMode = 'split'   // module memory: split/unified for pending hunks
  const pendingSelected = new Map()   // workspace path -> selected file in the pending list

  const postJson = (path, body) => fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : r.json().then((b) => { throw new Error(b && b.error ? b.error : 'request failed') })))

  /** Pure staging math over the three patches of one file:
   *  { combined, staged, unstaged, indexText } (as /pending-diff returns).
   *  Exposes the render-ready hunks, per-line/per-section staged state, and
   *  for every toggle the exact { patch, reverse } to POST. Pure so the
   *  tests can drive it against real git end to end. */
  const stagingController = ({ combined, staged, unstaged, indexText }) => {
    const combinedParts = patchPartsOf(combined)
    const stagedPatch = stagingPatchOf(staged)
    const unstagedPatch = stagingPatchOf(unstaged)
    const indexLines = indexLinesOf(indexText)
    const hunks = combinedParts.hunks.map(diffHunkOfParts)
    const entriesByHunk = hunks.map(numberedEntries)

    const isStaged = (entry) => entry === undefined || entry.sign === ' ' ? undefined
      : entry.sign === '-' ? stagedPatch.delOldNos.has(entry.old)
      : !unstagedPatch.addNewNos.has(entry.new)

    const hunkState = (hunkIndex) => {
      let total = 0
      let staged = 0
      for (const e of entriesByHunk[hunkIndex] ?? []) {
        if (e.sign === ' ') continue
        total += 1
        if (isStaged(e) === true) staged += 1
      }
      return { total, staged }
    }

    const toggleLinePatch = (hunkIndex, src) => {
      const entry = (entriesByHunk[hunkIndex] ?? [])[src]
      if (entry === undefined || entry.sign === ' ') return undefined
      if (entry.sign === '-') {
        if (stagedPatch.delOldNos.has(entry.old)) {
          // unstage a staged deletion: re-insert the head line into the
          // index, patched against exact index content
          const pos = insertPosOf(stagedPatch.hunks, entry.old, indexLines.length)
          return { patch: linePatchInsert(stagedPatch.header, indexLines, pos, entry.text), reverse: false }
        }
        const indexNo = mapOldToNew(stagedPatch.hunks, entry.old)
        const hit = indexNo !== undefined ? findEntryByNo(unstagedPatch, 'old', indexNo) : undefined
        return hit === undefined ? undefined
          : { patch: unstagedPatch.header + partialHunkPatch(hit.hunk, hit.entry.src), reverse: false }
      }
      if (!unstagedPatch.addNewNos.has(entry.new)) {
        // unstage a staged addition: remove that exact index line
        const indexNo = mapNewToOld(unstagedPatch.hunks, entry.new)
        return indexNo === undefined || indexNo < 1 || indexNo > indexLines.length ? undefined
          : { patch: linePatchRemove(stagedPatch.header, indexLines, indexNo), reverse: false }
      }
      const hit = findEntryByNo(unstagedPatch, 'new', entry.new)
      return hit === undefined ? undefined
        : { patch: unstagedPatch.header + partialHunkPatch(hit.hunk, hit.entry.src), reverse: false }
    }

    /** Discard ONE changed line: a forward patch that reverts the line to
     *  its pre-change state, applied to the index AND worktree. The
     *  patch comes from the same single-line machinery as staging. */
    const discardLinePatch = (hunkIndex, src) => {
      const entry = (entriesByHunk[hunkIndex] ?? [])[src]
      if (entry === undefined || entry.sign === ' ') return undefined
      // Build the reverse: for an ADD, remove the line; for a DEL,
      // restore it. This is the inverse of toggleLinePatch's direction.
      const hunk = hunks[hunkIndex]
      const lines = []
      let oldNo = hunk.oldStart
      let newNo = hunk.newStart
      for (let i = 0; i < hunk.lines.length; i += 1) {
        const line = hunk.lines[i]
        const sign = line[0]
        const text = line.slice(1)
        if (i === src) {
          // the discarded line reverts: + becomes nothing, - becomes context
          if (sign === '+') continue   // additions just drop
          lines.push(' ' + text)        // deletions become context (restored)
        } else if (sign === '+') {
          lines.push('+' + text)
        } else if (sign === '-') {
          lines.push('-' + text)
        } else {
          lines.push(' ' + text)
        }
      }
      // count the result
      const oldCount = lines.filter((l) => l[0] !== '+').length
      const newCount = lines.filter((l) => l[0] !== '-').length
      return { patch: patchPartsOf(combined).header + '@@ -' + hunk.oldStart + ',' + oldCount + ' +' + hunk.newStart + ',' + newCount + ' @@\n' + lines.join('\n') + '\n', reverse: false }
    }

    const toggleHunkPatch = (hunkIndex) => {
      const hunk = hunks[hunkIndex]
      const { total, staged } = hunkState(hunkIndex)
      if (hunk === undefined || total === 0) return undefined
      if (staged === total) {
        // unstage: reverse the staged hunks overlapping this section
        const sel = stagedPatch.hunks.filter((s) => s.oldStart < hunk.oldStart + hunk.oldLines
          && s.oldStart + s.oldLines > hunk.oldStart)
        return sel.length === 0 ? undefined
          : { patch: stagedPatch.header + sel.map((s) => s.raw).join(''), reverse: true }
      }
      // stage the rest: forward the unstaged hunks overlapping this section
      const sel = unstagedPatch.hunks.filter((u) => u.newStart < hunk.newStart + hunk.newLines
        && u.newStart + u.newLines > hunk.newStart)
      return sel.length === 0 ? undefined
        : { patch: unstagedPatch.header + sel.map((u) => u.raw).join(''), reverse: false }
    }

    return {
      hunks, entriesByHunk, isStaged, hunkState,
      lineMark: (hunkIndex, src) => isStaged((entriesByHunk[hunkIndex] ?? [])[src]),
      toggleLinePatch, toggleHunkPatch, discardLinePatch,
    }
  }

  /** The selected file's diff: ONE whole-file view of ALL its changes (HEAD
   *  vs worktree) with GitHub Desktop stage marks: a checkmark per changed
   *  line (filled = already staged; click to stage/unstage just it) and a
   *  checkmark per hunk header that fills when every changed line of the
   *  section is staged (click to stage/unstage them all at once). */
  const PendingFile = ({ loc, file, untracked, refresh, onChanged }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + '&file=' + encodeURIComponent(file)
    const [version, setVersion] = React.useState(0)
    const [state, setState] = React.useState({ phase: 'loading' })
    const [mode, setModeState] = React.useState(pendingViewMode)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    // Fetch freshness guard: a poll response that STARTED before an apply
    // can still land after the post-apply refresh; without a sequence
    // number it would resurrect pre-apply patches, and the next click
    // would build a patch the index rejects.
    const [seqRef] = React.useState({ seq: 0 })
    // Synchronous busy guard: the `busy` state only reaches the DOM after
    // a render commit, so stale click handlers can still fire while an
    // action is in flight; a second patch built from pre-action state
    // would not apply. The mutable flag closes that window immediately.
    const [busyRef] = React.useState({ busy: false })
    const setMode = (m) => { pendingViewMode = m; setModeState(m) }
    React.useEffect(() => {
      let live = true
      const load = () => {
        const mySeq = (seqRef.seq += 1)
        return fetchJson('/wo-github/pending-diff?' + query)
          .then((data) => { if (live && mySeq === seqRef.seq) setState({ phase: 'ready', data }) },
            (e) => { if (live && mySeq === seqRef.seq) setState({ phase: 'error', message: e.message }) })
      }
      load()
      const timer = setInterval(load, 5000)
      return () => { live = false; clearInterval(timer) }
    }, [loc.path, file, version, refresh])

    // The header row renders in EVERY phase (also while loading), so
    // switching files or staging does not shift the layout around.
    const head = (chip) => React.createElement('div', { className: 'wog-pendingfile-head' },
      React.createElement('div', { className: 'wog-file-head' },
        React.createElement('span', { className: 'wog-file-name' }, file),
        React.createElement('span', {
          className: 'wog-file-status',
          title: 'every change of this file in one view; checkmarks mark what the index already has',
        }, chip)),
      React.createElement(SegmentedControl, {
        id: 'wog-pending-mode',
        value: mode,
        options: [
          { value: 'split', label: 'Split' },
          { value: 'unified', label: 'Unified' },
        ],
        label: 'Diff view mode',
        onChange: (next) => { setMode(next) },
      }))

    if (state.phase === 'loading') return React.createElement('div', { className: 'wog-pendingfile' },
      head('\u2026'),
      React.createElement(PaneMessage, { text: 'Loading diff…' }))
    if (state.phase === 'error') return React.createElement('div', { className: 'wog-pendingfile' },
      head('\u2026'),
      React.createElement(PaneMessage, { text: state.message, error: true }))

    const applyPatch = (patch, reverse) => {
      if (busyRef.busy) return
      busyRef.busy = true
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-stage-hunk', { path: loc.path, patch, reverse })
        // Stay busy until the refreshed diff lands: clicks built from stale
        // patches would not apply.
        .then(() => fetchJson('/wo-github/pending-diff?' + query))
        .then((data) => {
          seqRef.seq += 1   // drop any in-flight poll response (pre-apply)
          setState({ phase: 'ready', data })
          onChanged()
        }, (e) => { setError(e.message); setVersion((n) => n + 1) })
        .then(() => { busyRef.busy = false; setBusy(false) })
    }

    const diffService = diffServiceResolver()
    let body
    if (untracked) {
      body = React.createElement('div', { className: 'wog-pendingfile' },
        React.createElement(PaneMessage, { text: 'Check the file in the list to stage all of it.' }),
        diffService !== undefined && state.data.untrackedText !== undefined
          ? React.createElement(diffService.diffFileComponent({ showToggle: false, wrap: true, scroll: false }), {
            hunks: diffHunksOfPatch(untrackedPatchOf(file, state.data.untrackedText)), mode })
          : React.createElement('pre', { className: 'wog-rawpre' }, state.data.untrackedText ?? ''))
      return React.createElement('div', { className: 'wog-pendingfile' },
        head('untracked'),
        error !== undefined ? React.createElement('p', { className: 'wog-error' }, error) : null,
        body)
    }

    // ---- staging math over the three patches (see stagingController) ----
    const controller = stagingController(state.data)
    const { hunks, hunkState } = controller

    const toggleLine = (hunkIndex, src) => {
      const action = controller.toggleLinePatch(hunkIndex, src)
      if (action === undefined) setError('could not map this line onto the index; refresh and retry')
      else applyPatch(action.patch, action.reverse)
    }

    const toggleHunk = (hunkIndex) => {
      const action = controller.toggleHunkPatch(hunkIndex)
      if (action !== undefined) applyPatch(action.patch, action.reverse)
    }

    const discardLine = (hunkIndex, src) => {
      const action = controller.discardLinePatch(hunkIndex, src)
      if (action === undefined) setError('could not map this line; refresh and retry')
      else {
        setBusy(true); setError(undefined)
        postJson('/wo-github/pending-discard-line', { path: loc.path, patch: action.patch })
          .then(() => fetchJson('/wo-github/pending-diff?' + query))
          .then((data) => {
            seqRef.seq += 1
            setState({ phase: 'ready', data })
            onChanged()
          }, (e) => { setError(e.message); setVersion((n) => n + 1) })
          .then(() => { busyRef.busy = false; setBusy(false) })
      }
    }

    let changedTotal = 0
    let stagedTotal = 0
    for (const entries of controller.entriesByHunk) {
      for (const e of entries) {
        if (e.sign === ' ') continue
        changedTotal += 1
        if (controller.isStaged(e) === true) stagedTotal += 1
      }
    }

    body = hunks.length === 0
      ? React.createElement(PaneMessage, { text: 'No changes left in this file.' })
      : diffService !== undefined
        ? React.createElement(diffService.diffFileComponent({ showToggle: false, wrap: true, scroll: false }), {
          hunks, mode,
          // The mark COLUMNS always render (dropping them mid-action made
          // the whole view jump sideways); only the click handlers pause
          // while an apply is in flight.
          hunkMark: (hunkIndex) => {
            const { total, staged } = hunkState(hunkIndex)
            return total > 0 && staged === total
          },
          onHunkToggle: busy ? undefined : toggleHunk,
          lineMark: controller.lineMark,
          onLineToggle: busy ? undefined : toggleLine,
          onLineDiscard: busy ? undefined : discardLine,
        })
        : React.createElement('pre', { className: 'wog-rawpre' }, state.data.combined)

    return React.createElement('div', { className: 'wog-pendingfile' },
      head(changedTotal === 0 || stagedTotal === 0 ? 'changes'
        : stagedTotal === changedTotal ? 'staged'
        : stagedTotal + '/' + changedTotal + ' staged'),
      error !== undefined ? React.createElement('p', { className: 'wog-error' }, error) : null,
      body)
  }

  /** The three-state file checkbox (GitHub Desktop): checked = fully
   *  staged, dash = partially staged, empty = nothing staged. Clicking a
   *  checked or dashed box unstages everything; clicking an empty box
   *  stages all of the file. */
  const TriStateCheck = ({ state, disabled, title, onToggle }) => React.createElement('span', {
    role: 'checkbox',
    'aria-checked': state === 'partial' ? 'mixed' : state === 'all' ? 'true' : 'false',
    tabIndex: disabled ? undefined : 0,
    className: 'wog-tri wog-tri-' + state + (disabled ? ' wog-tri-disabled' : ''),
    title,
    onClick: disabled ? undefined : onToggle,
    onKeyDown: disabled ? undefined : (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggle() } },
  }, state === 'all' ? '\u2713' : state === 'partial' ? '\u2013' : '\u00a0')

  /** GitHub Desktop's status dot: orange = modified, green = new, red =
   *  deleted; the tooltip carries the full word. */
  const statusDotOf = (row) => {
    if (row.untracked === true) return { kind: 'new', word: 'New' }
    const code = String(row.status ?? '')
    if (code.includes('D')) return { kind: 'deleted', word: 'Deleted' }
    return { kind: 'modified', word: 'Modified' }
  }

  /** The index is the source of truth: a row's three-state box stages or
   *  unstages the whole file immediately; the commit box commits exactly
   *  what is staged. */
  /** GitHub Desktop layout: ONE flat file list + commit box on the left,
   *  the selected file's combined diff on the right, both visible at
   *  once; staged per line via checkmarks. */
  const PendingPane = ({ loc }) => {
    const query = 'path=' + encodeURIComponent(loc.path)
    const [version, setVersion] = React.useState(0)
    const [state, setState] = React.useState({ phase: 'loading' })
    const [selected, setSelectedState] = React.useState(pendingSelected.get(loc.path))
    const [summary, setSummary] = React.useState('')
    const [description, setDescription] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    // stash-staged / discard-staged flow state
    const [stashOpen, setStashOpen] = React.useState(false)
    const [stashName, setStashName] = React.useState('')
    const [discardArmed, setDiscardArmed] = React.useState(false)
    // Bumped whenever an action (file stage/unstage, commit) changes the
    // index or HEAD, so the diff refetches immediately instead of waiting
    // for its next poll tick.
    const [refresh, setRefresh] = React.useState(0)
    const bump = () => { setVersion((n) => n + 1) }
    const setSelected = (file) => { pendingSelected.set(loc.path, file); setSelectedState(file) }
    React.useEffect(() => {
      let live = true
      const load = () => fetchJson('/wo-github/pending?' + query)
        .then((data) => { if (live) setState({ phase: 'ready', data }) },
          (e) => { if (live) setState({ phase: 'error', message: e.message }) })
      load()
      const timer = setInterval(load, 5000)
      return () => { live = false; clearInterval(timer) }
    }, [loc.path, version])

    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading pending changes…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })

    const files = state.data.files
    // ONE flat list, no staged/unstaged split: every file row carries a
    // THREE-STATE checkbox (checked = fully staged, dash = partially
    // staged, empty = nothing staged). The selection is just the file;
    // kept while it still has any changes, first row by default, cleared
    // when the tree goes clean.
    const effectiveSelected = selected !== undefined && selected !== null && files.some((f) => f.file === selected)
      ? selected
      : files.length > 0 ? files[0].file : undefined
    if ((effectiveSelected === undefined) !== (selected === undefined || selected === null)
      || (effectiveSelected !== undefined && selected !== undefined && selected !== null && effectiveSelected !== selected)) {
      setSelected(effectiveSelected)
    }
    const selectedRow = effectiveSelected !== undefined ? files.find((f) => f.file === effectiveSelected) : undefined
    const stagedCount = files.filter((f) => f.staged).length

    const postStage = (file, stage) => {
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-stage', { path: loc.path, file, stage })
        .then((data) => {
          setState({ phase: 'ready', data })
          setRefresh((n) => n + 1)   // the diff must reflect this immediately
        }, (e) => { setError(e.message); bump() })
        .then(() => { setBusy(false) })
    }
    const commit = () => {
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-commit', { path: loc.path, summary, description })
        .then(() => { setSummary(''); setDescription(''); bump(); setRefresh((n) => n + 1) }, (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }
    // Stash the STAGED changes (partial files included) under a name.
    const stashStaged = () => {
      if (busy || stagedCount === 0) return
      setBusy(true); setError(undefined)
      const message = stashName.trim()
      postJson('/wo-github/stash-staged', { path: loc.path, message: message === '' ? undefined : message })
        .then(() => { setStashOpen(false); setStashName(''); bump(); setRefresh((n) => n + 1) },
          (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }
    // Discard the staged changes for good (unstaged edits stay).
    const discardStaged = () => {
      if (busy || stagedCount === 0) return
      setBusy(true); setError(undefined)
      postJson('/wo-github/discard-staged', { path: loc.path })
        .then(() => { setDiscardArmed(false); bump(); setRefresh((n) => n + 1) },
          (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }

    const listSide = React.createElement('div', { className: 'wog-pending-side' },
      React.createElement('div', { className: 'wog-pending-list' },
        files.length === 0 ? React.createElement(PaneMessage, { text: 'Nothing to commit. Working tree clean.' }) : null,
        files.length > 0 ? React.createElement('div', { className: 'wog-pendinggroup' },
          React.createElement('div', { className: 'wog-pendinggroup-title' }, 'Changes \u00b7 ' + files.length),
          files.map((row) => React.createElement('div', {
            key: row.file,
            className: 'wog-pendingrow' + (row.file === effectiveSelected ? ' wog-pendingrow-active' : ''),
            onClick: () => { setSelected(row.file) },
          },
          // Only the tri-state box swallows the click (toggling it must not
          // reselect the row); the filename sits directly in the row so
          // clicking it selects the file.
          React.createElement('span', {
            className: 'wog-pendingrow-check',
            onClick: (e) => { e.stopPropagation() },
          },
          React.createElement(TriStateCheck, {
            state: row.staged && row.unstaged ? 'partial' : row.staged ? 'all' : 'none',
            disabled: busy,
            title: row.staged ? 'Unstage all changes of this file' : 'Stage all changes of this file',
            onToggle: () => { postStage(row.file, !row.staged) },
          })),
          React.createElement('span', { className: 'wog-pendingrow-label' },
            row.renamedFrom !== undefined ? row.renamedFrom + ' \u2192 ' + row.file : row.file),
          row.stagedCounts !== undefined && row.stagedCounts.additions !== null && row.stagedCounts.deletions !== null
            && (row.stagedCounts.additions > 0 || row.stagedCounts.deletions > 0)
            ? React.createElement('span', {
              className: 'wog-pendingrow-counts',
              title: 'staged lines: +' + row.stagedCounts.additions + ' / −' + row.stagedCounts.deletions,
            },
            row.stagedCounts.additions > 0
              ? React.createElement('span', { className: 'wog-count-add' }, '+' + row.stagedCounts.additions) : null,
            row.stagedCounts.deletions > 0
              ? React.createElement('span', { className: 'wog-count-del' }, '−' + row.stagedCounts.deletions) : null) : null,
          statusDotOf(row) !== undefined ? React.createElement('span', {
            className: 'wog-dot wog-dot-' + statusDotOf(row).kind,
            title: statusDotOf(row).word,
          }) : null))) : null,
      React.createElement('div', { className: 'wog-commitbox' },
        React.createElement(Input, {
          type: 'text', className: 'wog-commit-input', placeholder: 'Summary',
          value: summary, onChange: (e) => { setSummary(e.target.value) },
        }),
        React.createElement('textarea', {
          className: 'wog-commit-desc', placeholder: 'Description (optional)',
          value: description, onChange: (e) => { setDescription(e.target.value) },
        }),
        React.createElement(Button, {
          variant: 'primary', size: 'sm', className: 'wog-commit-btn',
          disabled: busy || stagedCount === 0 || summary.trim() === '',
          title: stagedCount === 0 ? 'Stage files to commit them' : 'Commit ' + stagedCount + ' staged file(s) to the current branch',
          onClick: commit,
        }, 'Commit' + (stagedCount > 0 ? ' (' + stagedCount + ')' : '')),
        stashOpen === true ? React.createElement('div', { className: 'wog-stashnew' },
          React.createElement('input', {
            className: 'wog-stash-input', type: 'text',
            placeholder: 'stash name (e.g. wip: auth refactor)',
            value: stashName, onChange: (e) => { setStashName(e.target.value) },
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); stashStaged() } },
          }),
          React.createElement(Button, {
            variant: 'primary', size: 'sm', disabled: busy,
            title: 'stash the staged changes under this name (partial files included)',
            onClick: stashStaged,
          }, 'Stash'),
          React.createElement(Button, {
            variant: 'ghost', size: 'sm', disabled: busy,
            onClick: () => { setStashOpen(false); setStashName('') },
          }, 'Cancel')) : null,
        React.createElement('div', { className: 'wog-commit-actions' },
          React.createElement(Button, {
            variant: 'ghost', size: 'sm', disabled: busy || stagedCount === 0,
            title: stagedCount === 0 ? 'nothing is staged' : 'stash the staged changes under a name you pick',
            onClick: () => { setStashOpen(stashOpen !== true); setDiscardArmed(false) },
          }, 'Stash staged\u2026'),
          discardArmed !== true
            ? React.createElement(Button, {
              variant: 'ghost', size: 'sm', className: 'wog-discard-btn', disabled: busy || stagedCount === 0,
              title: stagedCount === 0 ? 'nothing is staged' : 'permanently discard the staged changes (unstaged edits are kept)',
              onClick: () => { setDiscardArmed(true); setStashOpen(false) },
            }, 'Discard selected')
            : React.createElement('span', { className: 'wog-discard-confirm' },
              React.createElement(Button, {
                variant: 'ghost', size: 'sm', className: 'wog-discard-btn', disabled: busy,
                title: 'yes, throw the staged changes away for good',
                onClick: discardStaged,
              }, 'Really discard?'),
              React.createElement(Button, {
                variant: 'ghost', size: 'sm', disabled: busy,
                onClick: () => { setDiscardArmed(false) },
              }, 'Cancel'))))))

    const diffSide = effectiveSelected !== undefined
      ? React.createElement(PendingFile, {
        key: effectiveSelected,
        loc, file: effectiveSelected,
        untracked: selectedRow !== undefined ? selectedRow.untracked === true : false,
        refresh,
        onChanged: bump,
      })
      : React.createElement(PaneMessage, { text: 'Select a file to see its changes.' })

    // The pane-level error line renders ABOVE the layout so failed
    // actions (commit, stage, stash, discard) are always visible.
    return React.createElement('div', { className: 'wog-pending-outer' },
      error !== undefined ? React.createElement('p', { className: 'wog-error' }, error) : null,
      React.createElement('div', { className: 'wog-pending-layout' },
        listSide,
        React.createElement('div', { className: 'wog-pending-main' }, diffSide)))
  }

  /** Stashed changes of the checked-out branch: one row per stash entry
   *  with Pop (restore + remove) and Drop (discard). Entries made on other
   *  branches are noted, not listed. */
  const StashPane = ({ loc }) => {
    const [version, setVersion] = React.useState(0)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    const query = 'path=' + encodeURIComponent(loc.path)
    const state = useRepoData('/wo-github/stashes?' + query, [loc.path, version])

    if (state.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading stashes…' })
    if (state.phase === 'error') return React.createElement(PaneMessage, { text: state.message, error: true })

    const branch = state.data.branch
    const mine = state.data.entries.filter((e) => e.branch === branch)
    const others = state.data.entries.length - mine.length

    const act = (route, index) => {
      if (busy) return
      setBusy(true); setError(undefined)
      postJson(route, { path: loc.path, index })
        .then(() => { setVersion((n) => n + 1) }, (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }

    return React.createElement('div', { className: 'wog-stash' },
      error !== undefined ? React.createElement('p', { className: 'wog-error' }, error) : null,
      mine.length === 0
        ? React.createElement(PaneMessage, { text: 'No stashed changes on ' + (branch ?? 'this branch') + '.' })
        : mine.map((entry) => {
          const at = Number((/^stash@\{(\d+)\}/.exec(entry.ref) ?? [])[1])
          const label = entry.subject.replace(/^(?:On|WIP on) \S+: /, '')
          return React.createElement('div', { key: entry.ref, className: 'wog-stashrow' },
            React.createElement('div', { className: 'wog-stashinfo' },
              React.createElement('span', { className: 'wog-stashmsg', title: entry.subject }, label === '' ? entry.ref : label),
              React.createElement('span', { className: 'wog-stashsub' },
                entry.ref, ' \u00b7 ', timeAgoOf(entry.date))),
            React.createElement('div', { className: 'wog-stashactions' },
              React.createElement(Button, {
                variant: 'outline', size: 'sm', disabled: busy,
                title: 'restore these changes in the worktree and remove the stash entry',
                onClick: () => { act('/wo-github/stash-pop', Number.isInteger(at) ? at : 0) },
              }, 'Pop'),
              React.createElement(Button, {
                variant: 'ghost', size: 'sm', disabled: busy,
                title: 'discard this stash entry for good',
                onClick: () => { act('/wo-github/stash-drop', Number.isInteger(at) ? at : 0) },
              }, 'Drop')))
        }),
      others > 0 ? React.createElement(PaneMessage, {
        text: others + ' stash entr' + (others === 1 ? 'y' : 'ies') + ' from other branches are not listed.' }) : null)
  }

  /** History, GitHub Desktop style: commit list on the left, the selected
   *  commit's changed files beside it, and the selected file's diff in the
   *  main area — all three visible at once, no drill-in navigation. */
  const CommitsPane = ({ loc }) => {
    const [page, setPage] = React.useState(1)
    const [pick, setPick] = React.useState(undefined)   // { sha, file? }
    // ALL hooks run before any conditional rendering (React error #300):
    // the detail fetch is a sibling hook, never an early return.
    const base = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '')
    const commitsState = useRepoData('/wo-github/commits?' + base + '&page=' + page, [loc.path, loc.repo, page])
    const commits = commitsState.phase === 'ready' && Array.isArray(commitsState.data.commits) ? commitsState.data.commits : []
    const effectiveSha = pick !== undefined && commits.some((c) => c.sha === pick.sha)
      ? pick.sha
      : commits.length > 0 ? commits[0].sha : undefined
    if (pick !== undefined && pick.sha !== effectiveSha) setPick(undefined)
    const detailState = useRepoData('/wo-github/commit?' + base + '&sha=' + encodeURIComponent(effectiveSha ?? ''), [loc.path, loc.repo, effectiveSha])
    const commit = detailState.phase === 'ready' ? detailState.data : undefined
    const files = commit !== undefined && Array.isArray(commit.files) ? commit.files : []
    const effectiveFile = pick !== undefined && pick.sha === effectiveSha && pick.file !== undefined
      && files.some((f) => f.filename === pick.file)
      ? pick.file
      : files.length > 0 ? files[0].filename : undefined
    const selectedFile = effectiveFile !== undefined ? files.find((f) => f.filename === effectiveFile) : undefined

    if (commitsState.phase === 'loading') return React.createElement(PaneMessage, { text: 'Loading history…' })
    if (commitsState.phase === 'error') return React.createElement(PaneMessage, { text: commitsState.message, error: true })
    if (commits.length === 0) return React.createElement(PaneMessage, { text: 'No commits on this branch.' })

    const commitSide = React.createElement('div', { className: 'wog-history-commits' },
      commits.map((row) => React.createElement('button', {
        key: row.sha, type: 'button',
        className: 'wog-commit-row' + (row.sha === effectiveSha ? ' wog-commit-row-active' : ''),
        onClick: () => { setPick({ sha: row.sha }) },
      },
      React.createElement('span', { className: 'wog-commit-line' }, firstLineOf(row.message)),
      React.createElement('span', { className: 'wog-commit-sub' },
        React.createElement('span', { className: 'wog-sha' }, row.sha.slice(0, 7)),
        ' ', row.author || 'unknown',
        row.login ? ' (' + row.login + ')' : '',
        ' \u00b7 ' + timeAgoOf(row.date)))),
      React.createElement('div', { className: 'wog-pager' },
        page > 1 ? React.createElement('button', { type: 'button', className: 'wog-pager-btn', onClick: () => { setPage(page - 1) } }, '\u2190 Newer') : null,
        commitsState.data.hasMore ? React.createElement('button', { type: 'button', className: 'wog-pager-btn', onClick: () => { setPage(page + 1) } }, 'Older \u2192') : null))

    const fileRows = commit === undefined ? null : (files.length === 0
      ? React.createElement(PaneMessage, { text: 'No file changes in this commit.' })
      : files.map((f) => React.createElement('div', {
        key: f.filename,
        className: 'wog-history-filerow' + (f.filename === effectiveFile ? ' wog-history-filerow-active' : ''),
        onClick: () => { setPick({ sha: effectiveSha, file: f.filename }) },
        title: f.status,
      },
      React.createElement('span', { className: 'wog-history-filename' }, f.filename),
      (f.additions ?? 0) > 0 || (f.deletions ?? 0) > 0 ? React.createElement('span', { className: 'wog-pendingrow-counts' },
        (f.additions ?? 0) > 0 ? React.createElement('span', { className: 'wog-count-add' }, '+' + f.additions) : null,
        (f.additions ?? 0) > 0 && (f.deletions ?? 0) > 0 ? ' ' : null,
        (f.deletions ?? 0) > 0 ? React.createElement('span', { className: 'wog-count-del' }, '\u2212' + f.deletions) : null) : null)))

    const detailSide = React.createElement('div', { className: 'wog-history-detail' },
      commit === undefined
        ? React.createElement(PaneMessage, {
          text: detailState.phase === 'error' ? detailState.message : 'Loading commit…',
          error: detailState.phase === 'error' })
        : React.createElement('div', { className: 'wog-commit-head' },
          React.createElement('div', { className: 'wog-commit-message' }, commit.message),
          React.createElement('div', { className: 'wog-commit-meta' },
            commit.author || 'unknown', commit.login ? ' (' + commit.login + ')' : '',
            ' \u00b7 ' + timeAgoOf(commit.date),
            ' \u00b7 ', React.createElement('span', { className: 'wog-sha' }, commit.sha),
            ' \u00b7 ',
            React.createElement('span', { className: 'wog-count-add' }, '+' + (commit.additions ?? 0)),
            ' ',
            React.createElement('span', { className: 'wog-count-del' }, '\u2212' + (commit.deletions ?? 0)))),
      React.createElement('div', { className: 'wog-history-body' },
        React.createElement('div', { className: 'wog-history-files' }, fileRows),
        React.createElement('div', { className: 'wog-history-diff' },
          selectedFile === undefined ? null
            : selectedFile.patch === undefined
              ? React.createElement(PaneMessage, { text: 'No patch available (binary or too large).' })
              : renderPatch(selectedFile.patch, selectedFile.filename))))

    return React.createElement('div', { className: 'wog-history-layout' },
      commitSide,
      detailSide)
  }

  // ---- the tab ------------------------------------------------------------

  // Cross-seat bridge: the composer's branch pill asks the GitHub tab to
  // open on a specific pane. The pill lives in conversation.input.left and
  // cannot reach the conversation view's openView; it records the request
  // here (and clicks the Workspace Overview view tab in the DOM), and the
  // GithubTab consumes it on mount or via the listener when already open.
  let requestedPane = undefined
  const paneListeners = new Set()
  const requestPane = (pane) => {
    requestedPane = pane
    for (const fn of paneListeners) { try { fn() } catch (e) {} }
  }
  const paneRequestOf = () => requestedPane

  const locCache = new Map()    // workspace path -> { path, repo? } | null | undefined(unknown)

  const PANES = [
    { id: 'overview', label: 'Overview' },
    { id: 'pending', label: 'Pending' },
    { id: 'stash', label: 'Stash' },
    { id: 'commits', label: 'History' },
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
    // Consume a pane request recorded while we were unmounted in a MOUNT
    // EFFECT: React 18 concurrent rendering may run useState initializers
    // in thrown-away passes, and a side effect there would eat the request
    // while the committed pass still renders 'overview'. Effects run once
    // per committed mount.
    const [pane, setPane] = React.useState('overview')
    React.useEffect(() => {
      const fn = () => {
        const requested = requestedPane
        requestedPane = undefined
        if (requested !== undefined) setPane(requested)
      }
      fn()   // request recorded before this mount
      paneListeners.add(fn)
      return () => { paneListeners.delete(fn) }
    }, [])
    // Branch context: every pane below the header is branch-scoped, so the
    // tab tracks the checkout itself (seeded from the pill's cache, polled
    // live) and keys the pane body by branch to refetch on any switch.
    const [tabBranch, setTabBranch] = React.useState(
      typeof workspacePath === 'string' && branchCache.has(workspacePath) ? branchCache.get(workspacePath) : undefined)
    React.useEffect(() => {
      if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
      let live = true
      const same = (a, b) => a === b
        || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
          && a.branch === b.branch && a.sha === b.sha && a.pending === b.pending && a.stashes === b.stashes)
      const tick = () => {
        fetch('/wo-github/branch?path=' + encodeURIComponent(workspacePath))
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => {
            if (!live) return
            const value = body !== null && typeof body === 'object'
              ? { branch: typeof body.branch === 'string' ? body.branch : null,
                  sha: typeof body.sha === 'string' ? body.sha : null,
                  pending: Number.isFinite(body.pending) ? body.pending : 0,
                  stashes: Number.isFinite(body.stashes) ? body.stashes : 0 }
              : null
            branchCache.set(workspacePath, value)
            setTabBranch((prev) => same(prev, value) ? prev : value)
          }, () => {})
      }
      tick()
      const interval = setInterval(tick, BRANCH_POLL_MS)
      return () => { live = false; clearInterval(interval) }
    }, [workspacePath])
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
      : active === 'pending' ? React.createElement(PendingPane, { loc })
      : active === 'stash' ? React.createElement(StashPane, { loc })
      : React.createElement(OverviewPane, { loc })
    const branchKey = tabBranch !== undefined && tabBranch !== null
      ? (tabBranch.branch ?? tabBranch.sha ?? 'detached') : 'nobranch'
    // The branch header scopes EVERY pane below it; the pane body is keyed
    // by branch so a switch remounts all of them against the new checkout.
    const branchHeader = tabBranch !== undefined && tabBranch !== null
      && (tabBranch.branch !== null || tabBranch.sha !== null)
      ? React.createElement('div', { className: 'wog-tabbranch' },
        React.createElement('span', { className: 'wog-tabbranch-label' }, 'Current branch:'),
        // same bordered combo as the composer pill: name + badges + chevron
        // read as ONE control
        React.createElement('span', { className: 'wog-branchwrap wog-tabbranch-box' },
          React.createElement('span', {
            className: 'wog-tabbranch-name',
            title: 'checked-out branch \u00b7 every pane below is scoped to it',
          }, tabBranch.branch ?? tabBranch.sha),
          tabBranch.pending > 0 ? React.createElement('span', {
            className: 'wog-branchpill-badge',
            title: tabBranch.pending + ' file(s) with uncommitted changes',
          }, String(tabBranch.pending)) : null,
          tabBranch.stashes > 0 ? React.createElement('span', {
            className: 'wog-branchstash',
            title: 'this branch has stashed changes',
          }, React.createElement(StashIcon, { key: 'i' })) : null,
          React.createElement(BranchSwitcher, {
            cwd: workspacePath, branchState: tabBranch,
            onCheckout: (value) => { setTabBranch(value) },
            drop: 'down',
          })))
      : null
    return React.createElement('div', { className: 'wog-page' },
      branchHeader,
      React.createElement('div', { className: 'wog-subtabs' },
        PANES.map((p) => React.createElement('button', {
          key: p.id, type: 'button',
          className: 'wog-subtab' + (active === p.id ? ' wog-subtab-active' : ''),
          onClick: () => { setPane(p.id) },
        }, p.label))),
      React.createElement('div', { className: 'wog-pane', key: branchKey }, body))
  }

  // ---- plugin -------------------------------------------------------------

  // ---- the composer branch pill ---------------------------------------------

  const BRANCH_POLL_MS = 2500
  const branchCache = new Map()   // workspace path -> { branch, sha } | null
  const slugCache = new Map()     // workspace path -> 'owner/repo' | null

  /** The branch switcher (chevron + popover): local branch list with the
   *  GitHub Desktop dirty-choice (leave stashed / bring along) and a
   *  new-branch field. Shared by the composer pill and the GitHub tab's
   *  branch header; checkouts update the shared branchCache and call
   *  onCheckout(value) with the fresh { branch, sha, pending, stashes }. */
  const BranchSwitcher = ({ cwd, branchState, onCheckout, drop }) => {
    const [menuOpen, setMenuOpen] = React.useState(false)
    const [branches, setBranches] = React.useState(undefined)   // { current, branches } | { error }
    const [newName, setNewName] = React.useState('')
    const [menuBusy, setMenuBusy] = React.useState(false)
    const [menuError, setMenuError] = React.useState(undefined)
    const [choiceBranch, setChoiceBranch] = React.useState(undefined)   // branch name while the leave/bring choice is open

    React.useEffect(() => {
      if (menuOpen !== true || typeof cwd !== 'string' || cwd === '') return undefined
      let live = true
      setBranches(undefined)
      fetchJson('/wo-github/branches?path=' + encodeURIComponent(cwd))
        .then((data) => { if (live) setBranches(data) },
          (e) => { if (live) setBranches({ error: e.message }) })
      return () => { live = false }
    }, [menuOpen, cwd])

    // Outside click and Escape close the menu.
    React.useEffect(() => {
      if (menuOpen !== true) return undefined
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
      const onDocClick = (e) => {
        // A click inside the switcher (menu included) must not close it.
        // e.target can be DETACHED from the DOM by the time this runs
        // (React may swap the menu's content mid-click when a choice
        // starts), which makes closest() miss; composedPath() still sees
        // the original ancestors.
        const inside = (node) => node !== undefined && node !== null
          && typeof node.closest === 'function'
          && node.closest('.wog-branchswitch, .wog-branchmenu, .wog-branchwrap') !== null
        if (inside(e.target)) return
        if (typeof e.composedPath === 'function') {
          const path = e.composedPath()
          for (const node of path) {
            if (typeof node === 'object' && inside(node)) return
          }
        }
        setMenuOpen(false)
      }
      const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
      document.addEventListener('click', onDocClick)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('click', onDocClick)
        document.removeEventListener('keydown', onKey)
      }
    }, [menuOpen])

    const pending = Number.isFinite(branchState.pending) && branchState.pending > 0 ? branchState.pending : 0

    const applyCheckout = (branch, pendingAfter) => {
      // stashes stay as-is: the count is branch-scoped and the poll
      // refreshes it for the new checkout
      const value = { branch, sha: branchState.sha, pending: pendingAfter,
        stashes: branchState.stashes }
      if (typeof cwd === 'string') branchCache.set(cwd, value)
      if (typeof onCheckout === 'function') onCheckout(value)
      setNewName('')
      setChoiceBranch(undefined)
      setMenuOpen(false)
    }
    const switchBranch = (name, mode) => {
      if (menuBusy) return
      setMenuBusy(true); setMenuError(undefined)
      postJson('/wo-github/checkout', { path: cwd, branch: name, mode })
        .then((data) => { applyCheckout(data.branch, Number.isFinite(data.pending) ? data.pending : branchState.pending) },
          (e) => { setMenuError(e.message) })
        .then(() => { setMenuBusy(false) })
    }
    const createBranch = () => {
      if (menuBusy || newName.trim() === '') return
      setMenuBusy(true); setMenuError(undefined)
      postJson('/wo-github/create-branch', { path: cwd, name: newName.trim() })
        .then((data) => { applyCheckout(data.branch, branchState.pending) },
          (e) => { setMenuError(e.message) })
        .then(() => { setMenuBusy(false) })
    }
    const list = Array.isArray(branches?.branches) ? branches.branches : []
    const branchMenu = () => menuOpen !== true ? null : React.createElement('div', {
      className: 'wog-branchmenu' + (drop === 'down' ? ' wog-branchmenu-down' : ''),
      role: 'menu',
    },
      choiceBranch !== undefined
        // GitHub Desktop's dirty-switch choice: stash here, or try to
        // carry the changes to the target (git refuses conflicting
        // carries atomically, so nothing half-applies).
        ? [React.createElement('div', { key: 't', className: 'wog-branchmenu-title' }, 'Switch to ' + choiceBranch),
          React.createElement('button', {
            key: 'leave', type: 'button', className: 'wog-branchchoice', disabled: menuBusy,
            title: 'stash all changes on this branch and switch',
            onClick: () => { switchBranch(choiceBranch, 'stash') },
          },
          React.createElement('span', { className: 'wog-branchchoice-label' }, 'Leave my changes on ' + (branchState.branch ?? 'this branch')),
          React.createElement('span', { className: 'wog-branchhint' }, 'stash all changes (recover with git stash)')),
          React.createElement('button', {
            key: 'bring', type: 'button', className: 'wog-branchchoice', disabled: menuBusy,
            title: 'checkout and keep the pending changes in the worktree',
            onClick: () => { switchBranch(choiceBranch, 'carry') },
          },
          React.createElement('span', { className: 'wog-branchchoice-label' }, 'Bring my changes to ' + choiceBranch),
          React.createElement('span', { className: 'wog-branchhint' }, 'only possible when they do not conflict there')),
          React.createElement('button', {
            key: 'back', type: 'button', className: 'wog-branchback', disabled: menuBusy,
            onClick: () => { setChoiceBranch(undefined); setMenuError(undefined) },
          }, '\u2190 back'),
          menuError !== undefined ? React.createElement('div', { key: 'e', className: 'wog-branchmenu-error' }, menuError) : null]
        : [React.createElement('div', { key: 't', className: 'wog-branchmenu-title' }, 'Switch branch'),
          branches === undefined
            ? React.createElement('div', { key: 'l', className: 'wog-branchhint' }, 'loading branches\u2026')
            : branches.error !== undefined
              ? React.createElement('div', { key: 'e', className: 'wog-branchmenu-error' }, branches.error)
              : list.map((name) => {
                const current = name === branches.current
                return React.createElement('button', {
                  key: name, type: 'button',
                  className: 'wog-branchitem' + (current ? ' wog-branchitem-current' : ''),
                  disabled: current || menuBusy,
                  title: current ? 'current branch'
                    : pending > 0 ? 'switch to ' + name + ' (choose what happens to your ' + pending + ' pending file(s))'
                    : 'checkout ' + name,
                  onClick: () => {
                    if (current) return
                    if (pending > 0) { setChoiceBranch(name); setMenuError(undefined); setMenuOpen(true) }
                    else switchBranch(name)
                  },
                },
                React.createElement('span', { className: 'wog-branchmark' }, current ? '\u2713' : ''),
                React.createElement('span', { className: 'wog-branchname' }, name))
              }),
              React.createElement('div', { key: 'new', className: 'wog-branchnew' },
                React.createElement('input', {
                  className: 'wog-branchinput', type: 'text', placeholder: 'new branch name',
                  value: newName, onChange: (e) => { setNewName(e.target.value) },
                  onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); createBranch() } },
                }),
                React.createElement(Button, {
                  variant: 'primary', size: 'sm', disabled: menuBusy || newName.trim() === '',
                  title: pending > 0
                    ? 'create a new branch and take your ' + pending + ' pending file(s) with you'
                    : 'create and switch to this branch',
                  onClick: createBranch,
                }, 'Create')),
              menuError !== undefined ? React.createElement('div', { key: 'e', className: 'wog-branchmenu-error' }, menuError) : null])
    const branchChevron = () => React.createElement('button', {
      type: 'button', className: 'wog-branchchev',
      'aria-haspopup': 'menu', 'aria-expanded': menuOpen === true ? 'true' : 'false',
      title: 'switch or create branch',
      onClick: () => { setMenuOpen(menuOpen !== true) },
    }, '\u25be')
    return React.createElement('span', { className: 'wog-branchswitch' }, branchChevron(), branchMenu())
  }

  /** The composer's live checkout pill: GitHub mark + branch (or short sha
   *  for detached HEAD), refetched on an interval so agent checkouts update
   *  it. Renders nothing outside a git repo. With uncommitted changes the
   *  badge counts dirty files and the click opens the GitHub tab's Pending
   *  pane (clicking again closes it); clean, the click still opens the
   *  panel (Stash pane when stashes exist, Pending otherwise). */
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

    React.useEffect(() => {
      if (typeof cwd !== 'string' || cwd === '') return undefined
      let live = true
      const same = (a, b) => a === b
        || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
          && a.branch === b.branch && a.sha === b.sha && a.pending === b.pending && a.stashes === b.stashes)
      const tick = () => {
        fetch('/wo-github/branch?path=' + encodeURIComponent(cwd))
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => {
            if (!live) return
            const value = body !== null && typeof body === 'object'
              ? { branch: typeof body.branch === 'string' ? body.branch : null,
                  sha: typeof body.sha === 'string' ? body.sha : null,
                  pending: Number.isFinite(body.pending) ? body.pending : 0,
                  stashes: Number.isFinite(body.stashes) ? body.stashes : 0 }
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

    if (branchState === undefined) return null
    if (branchState === null || (branchState.branch === null && branchState.sha === null)) return null
    const detached = branchState.branch === null
    const label = detached ? branchState.sha : branchState.branch
    const pending = Number.isFinite(branchState.pending) && branchState.pending > 0 ? branchState.pending : 0
    const stashCount = Number.isFinite(branchState.stashes) && branchState.stashes > 0 ? branchState.stashes : 0
    const className = 'wog-branchpill'
    const children = [React.createElement(GithubIcon, { key: 'icon' }),
      React.createElement('span', { key: 'label', className: 'wog-branchpill-label' }, label)]
    if (pending > 0) {
      children.push(React.createElement('span', {
        key: 'pending', className: 'wog-branchpill-badge',
        title: pending + ' file(s) with uncommitted changes',
      }, String(pending)))
    }

    const openGithubPane = (paneName, allowToggle) => {
      // Toggle: when the overview view is ALREADY open on the GitHub
      // subtab, the pill closes it (back to the conversation's first
      // view, the chat). Otherwise: 1) the Workspace Overview page must
      // land on the GitHub subtab (its facade owns the subtab state),
      // 2) the GitHub tab must land on the requested pane, 3) the view
      // must open.
      const strip = typeof document !== 'undefined' && typeof document.querySelector === 'function'
        ? document.querySelector('[data-conversation-tabs]') : undefined
      const activeTabButton = strip !== undefined && typeof strip.querySelector === 'function'
        ? strip.querySelector('button[aria-selected="true"]') : undefined
      const activeOnGithub = activeTabButton !== undefined && activeTabButton !== null
        && (activeTabButton.textContent ?? '').trim() === 'Workspace Overview'
        && overviewService !== undefined && typeof overviewService.activeTab === 'function'
        && (() => { try { return overviewService.activeTab() === 'github' } catch (e) { return false } })()
      if (allowToggle === true && activeOnGithub) {
        const chatTab = strip !== undefined ? strip.firstElementChild : undefined
        if (chatTab !== undefined && chatTab !== null && typeof chatTab.click === 'function') chatTab.click()
        return
      }
      const facadeCanRequestTab = overviewService !== undefined && typeof overviewService.requestTab === 'function'
      if (facadeCanRequestTab) {
        try { overviewService.requestTab('github') } catch (e) {}
      }
      requestPane(paneName)
      if (strip !== undefined && typeof strip.querySelectorAll === 'function') {
        for (const button of strip.querySelectorAll('button')) {
          if ((button.textContent ?? '').trim() === 'Workspace Overview') { button.click(); break }
        }
      }
      if (!facadeCanRequestTab) {
        // Older workspace-overview without requestTab: click the GitHub
        // subtab directly once the view renders it (a few frames at
        // most), so the pill still lands where it should.
        const tryGithubSubtab = (attempts) => {
          if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
          for (const button of document.querySelectorAll('button')) {
            if ((button.textContent ?? '').trim() === 'GitHub') { button.click(); return }
          }
          if (attempts > 0 && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { tryGithubSubtab(attempts - 1) })
          }
        }
        tryGithubSubtab(10)
      }
    }

    let pendingPill = undefined
    if (pending > 0) {
      // With uncommitted changes the pill jumps straight to the Pending
      // pane (toggling closed when the GitHub tab is already showing).
      pendingPill = () => React.createElement('button', {
        type: 'button', className,
        onClick: () => { openGithubPane('pending', true) },
        title: 'branch ' + (detached ? branchState.sha : branchState.branch)
          + ' \u00b7 ' + pending + ' file(s) with uncommitted changes \u00b7 open Pending',
      }, children)
    }
    const pillElement = pendingPill !== undefined ? pendingPill()
      : React.createElement('button', {
        type: 'button', className,
        onClick: () => { openGithubPane(pending > 0 ? 'pending' : stashCount > 0 ? 'stash' : 'pending', true) },
        title: 'branch ' + (detached ? branchState.sha : branchState.branch)
          + (stashCount > 0 ? ' \u00b7 stashed changes' : '') + ' \u00b7 open GitHub panel',
      }, children)

    // Pure indicator: the pill click itself routes to the Stash pane when
    // the worktree is clean but stashes exist.
    const stashIndicator = stashCount === 0 ? null : React.createElement('span', {
      className: 'wog-branchstash',
      title: 'this branch has stashed changes',
    }, React.createElement(StashIcon, { key: 'i' }))
    return React.createElement('span', { className: 'wog-branchwrap' }, pillElement, stashIndicator,
      React.createElement(BranchSwitcher, {
        cwd, branchState,
        onCheckout: (value) => { setBranchState(value) },
      }))
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
        + '.wog-tabbranch{flex:none;display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}'
        + '.wog-tabbranch-box{height:28px;padding:0 2px 0 8px;gap:2px}'
        + '.wog-tabbranch-label{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}'
        + '.wog-tabbranch-name{font-family:ui-monospace,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary)}'
        + '.wog-branchswitch{position:relative;display:inline-flex;align-items:center}'
        + '.wog-subtabs{flex:none;display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--dsw-alias-label-tertiary)}'
        + '.wog-subtab{font:inherit;font-size:12.5px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-bottom:2px solid transparent;opacity:.65;margin-bottom:-1px}'
        + '.wog-subtab:hover{opacity:1}'
        + '.wog-subtab-active{opacity:1;border-bottom-color:#3b82f6;font-weight:600}'
        + '.wog-pane{flex:1;min-height:0;overflow-y:auto;padding-right:4px}'
        + '.wog-dim{margin:0;font-size:13px;opacity:.65}'
        + '.wog-error{margin:0;font-size:12.5px;color:#ef4444}'
        // overview
        + '.wog-overview{display:flex;flex-direction:column;gap:14px}'
        + '.wog-skeleton{display:inline-block;height:12px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2) 25%,var(--dsw-alias-interactive-bg-hover) 50%,var(--dsw-alias-bg-layer-2) 75%);background-size:200% 100%;animation:wog-shimmer 1.4s linear infinite;vertical-align:middle}'
        + '.wog-skeleton-circle{height:40px;border-radius:50%}'
        + '@keyframes wog-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}'
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
        + '.wog-commit-row{font:inherit;text-align:left;cursor:pointer;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:inherit;display:flex;flex-direction:column;gap:2px}'
        + '.wog-commit-row:hover{background:var(--dsw-alias-bg-layer-2)}'
        + '.wog-commit-line{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.wog-commit-sub{font-size:11.5px;opacity:.6}'
        + '.wog-sha{font-family:ui-monospace,monospace;font-size:.95em;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}'
        + '.wog-pager{display:flex;gap:8px;padding:10px 0 4px}'
        + '.wog-pager-btn{font:inherit;font-size:12px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px}'
        + '.wog-pager-btn:hover{border-color:var(--dsw-alias-label-primary)}'
        // stash pane
        + '.wog-stash{display:flex;flex-direction:column;gap:8px}'
        + '.wog-stashrow{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px}'
        + '.wog-stashinfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}'
        + '.wog-stashmsg{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.wog-stashsub{font-size:11.5px;opacity:.6}'
        + '.wog-stashactions{display:flex;gap:6px;flex:none}'
        // history (GitHub Desktop: commit list | files | diff)
        + '.wog-history-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px}'
        + '.wog-history-commits{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-right:4px}'
        + '.wog-commit-row-active{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-history-detail{min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px}'
        + '.wog-history-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:12px}'
        + '.wog-history-files{min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px}'
        + '.wog-history-filerow{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:8px;cursor:pointer}'
        + '.wog-history-filerow:hover{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-history-filerow-active{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-history-filename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}'
        + '.wog-history-diff{min-height:0;min-width:0;overflow-y:auto;padding-right:4px}'
        + '.wog-commit-message{font-size:14px;font-weight:650;white-space:pre-wrap;word-break:break-word}'
        + '.wog-commit-meta{font-size:12px;opacity:.7;margin-top:2px}'
        // files + patches (diff-row classes come from dsh-diff-view)
        + '.wog-file-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-label-tertiary);font-size:12px}'
        + '.wog-file-name{font-family:ui-monospace,monospace;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.wog-file-status{font-size:10.5px;line-height:1;padding:3px 7px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);text-transform:uppercase;letter-spacing:.03em}'
        + '.wog-count-add{color:#3fb950;font-weight:600}'
        + '.wog-count-del{color:#f85149;font-weight:600}'
        + '.wog-readme{max-width:820px;margin-top:22px;padding-top:18px;border-top:1px solid var(--dsw-alias-border-l3)}'
        + '.wog-rawpre{margin:0;padding:12px;font-size:12px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px;max-height:60vh;overflow:auto}'
        + '.wog-patch-plain{margin:0;padding:10px 12px;font:var(--dsw-font-markdown-code-block);font-size:12px;overflow:auto;max-height:340px}'
        // Composer-row convention (matches the persona combo's ghost button):
        // 28px tall, 13px text, quiet background, hover fill, no border.
        + '.wog-branchpill{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:500;height:28px;padding:0 8px;max-width:min(280px,40cqw);text-decoration:none;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:24px;outline:none}'
        + 'a.wog-branchpill,button.wog-branchpill{cursor:pointer}'
        + 'a.wog-branchpill:hover,a.wog-branchpill:focus-visible,button.wog-branchpill:hover,button.wog-branchpill:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}'
        + 'span.wog-branchpill{cursor:default}'
        + '.wog-branchpill-label{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}'
        // branch switcher (chevron + popover menu beside the pill)
        + '.wog-branchwrap{position:relative;display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-label-tertiary);border-radius:24px;padding-right:2px}'
        + '.wog-branchwrap:hover{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-branchstash{display:inline-flex;align-items:center;padding:0 3px;white-space:nowrap}'
        + '.wog-branchchev{display:inline-flex;align-items:center;justify-content:center;height:28px;width:24px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;font-size:16px;line-height:1;padding:0 0 2px}'
        + '.wog-branchchev:hover,.wog-branchchev:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}'
        + '.wog-branchmenu{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;min-width:270px;max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12.5px;color:var(--dsw-alias-label-primary)}'
        + '.wog-branchmenu-down{top:calc(100% + 8px);bottom:auto}'
        + '.wog-branchmenu-title{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);padding:4px 8px 2px}'
        + '.wog-branchitem{display:flex;align-items:center;gap:8px;padding:5px 8px;border:none;background:transparent;color:inherit;font:inherit;text-align:left;border-radius:6px;cursor:pointer}'
        + '.wog-branchitem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-branchitem:disabled{cursor:default}'
        + '.wog-branchitem-current{color:var(--dsw-alias-label-secondary)}'
        + '.wog-branchitem-disabled{opacity:.45;cursor:not-allowed}'
        + '.wog-branchname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}'
        + '.wog-branchmark{width:14px;text-align:center;color:#3fb950;font-weight:700;flex:none}'
        + '.wog-branchnew{display:flex;gap:6px;padding:6px 8px 2px;border-top:1px solid var(--dsw-alias-border-l3);margin-top:4px;align-items:center}'
        + '.wog-branchinput{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;outline:none}'
        + '.wog-branchinput:focus-visible{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-branchmenu-error{margin:2px 8px 4px;font-size:11px;color:#ef4444}'
        + '.wog-branchhint{margin:2px 8px 4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}'
        + '.wog-branchchoice{display:flex;flex-direction:column;gap:2px;padding:8px;border:none;background:transparent;color:inherit;font:inherit;text-align:left;border-radius:8px;cursor:pointer}'
        + '.wog-branchchoice:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-branchchoice:disabled{opacity:.5;cursor:default}'
        + '.wog-branchchoice-label{font-weight:600;font-size:12.5px}'
        + '.wog-branchchoice .wog-branchhint{margin:0}'
        + '.wog-branchback{font:inherit;font-size:11.5px;padding:4px 8px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;text-align:left;border-radius:6px}'
        + '.wog-branchback:hover{color:var(--dsw-alias-label-primary)}'
        + '.wog-branchpill-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:rgba(210,153,34,.22);color:#d29922;font-size:10.5px;font-weight:700;line-height:16px;text-align:center;font-family:inherit}'
        // pending changes (GitHub Desktop layout: list + commit left, diff right)
        + '.wog-pending-outer{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}'
        + '.wog-pending-outer .wog-error{margin:0;flex:none}'
        + '.wog-pending-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px}'
        + '.wog-pending-side{display:flex;flex-direction:column;min-height:0;gap:10px}'
        + '.wog-pending-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}'
        + '.wog-pending-main{min-height:0;min-width:0;overflow-y:auto;padding-right:4px}'
        + '.wog-pendingrow-active{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-pendinggroup{display:flex;flex-direction:column;gap:2px}'
        + '.wog-pendinggroup-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);padding:4px 2px}'
        + '.wog-pendingrow{display:flex;align-items:center;gap:10px;padding:4px 8px;border-radius:8px;cursor:pointer}'
        + '.wog-pendingrow:hover{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-pendingrow-check{display:inline-flex;align-items:center;flex:none}'
        + '.wog-dot{flex:none;width:8px;height:8px;border-radius:50%}'
        + '.wog-dot-modified{background:#d29922}'
        + '.wog-dot-new{background:#3fb950}'
        + '.wog-dot-deleted{background:#f85149}'
        + '.wog-pendingrow-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12.5px}'
        + '.wog-tri{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:3px;font-size:11px;line-height:1;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary)}'
        + '.wog-tri:hover{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-tri-all,.wog-tri-partial{border-color:var(--dsw-alias-label-primary);font-weight:700}'
        + '.wog-tri-disabled{opacity:.5;cursor:default}'
        + '.wog-pendingrow-counts{flex:none;display:inline-flex;gap:6px;font-size:11px;font-family:ui-monospace,monospace}'
        + '.wog-commitbox{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}'
        + '.wog-commit-input{width:100%;box-sizing:border-box}'
        + '.wog-commit-desc{font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;min-height:56px;resize:vertical;padding:8px 10px;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;outline:none}'
        + '.wog-commit-desc:focus-visible{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-commit-btn{align-self:flex-end}'
        + '.wog-commit-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}'
        + '.wog-stashnew{display:flex;gap:8px;align-items:center}'
        + '.wog-stash-input{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;outline:none}'
        + '.wog-stash-input:focus-visible{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-discard-btn{color:#f85149}'
        + '.wog-discard-confirm{display:inline-flex;gap:6px;align-items:center}'
        + '.wog-pendingfile{display:flex;flex-direction:column;gap:10px}'
        + '.wog-pendingfile-head{display:flex;align-items:center;justify-content:space-between;gap:10px}'
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
  module.exports._internal = { timeAgoOf, firstLineOf, hunksOfPatch, diffHunkOfParts, stagingPatchOf, stagingController, mapOldToNew, mapNewToOld, insertPosOf, linePatchRemove, linePatchInsert, indexLinesOf, CommitsPane, BranchPill, PendingPane, StashPane, OverviewPane, GithubTab, branchCache, patchPartsOf, partialHunkPatch, requestPane, paneRequestOf }

  return module.exports
} })
