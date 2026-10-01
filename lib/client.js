/**
 * dsh-wo-github - browser half.
 *
 * Contributes a GitHub subtab to the Workspace Overview tab (injected
 * face: 'workspaceOverview'). Three panes:
 *
 *   Overview  repo About card (description, topics, stars/forks/issues,
 *             language, license, default branch, pushed at) with the
 *             README rendered beneath it (through dsh-md-view when
 *             installed; raw text otherwise; silent when absent)
 *   Pending   the GitHub Desktop surface: uncommitted work grouped
 *             Staged/Unstaged/Untracked, per-file checkboxes that stage
 *             and unstage immediately (the index is the source of truth),
 *             per-hunk checkboxes that apply single hunks to the index,
 *             a Split/Unified toggle (dsh-diff-view renders), and a
 *             commit box that commits exactly what is staged
 *   History    the checked-out branch's history; picking a commit shows
 *             its message, stats, and per-file unified patches with true
 *             line numbers and (when dsh-diff-view is installed) word highlights
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

  /** One file's staged/unstaged hunks with per-hunk checkboxes that apply
   *  to the index immediately (stage unstaged hunks, unstage staged ones). */
  const PendingFile = ({ loc, file, untracked, onChanged }) => {
    const query = 'path=' + encodeURIComponent(loc.path) + '&file=' + encodeURIComponent(file)
    const [version, setVersion] = React.useState(0)
    const [state, setState] = React.useState({ phase: 'loading' })
    const [mode, setModeState] = React.useState(pendingViewMode)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
    const setMode = (m) => { pendingViewMode = m; setModeState(m) }
    React.useEffect(() => {
      let live = true
      const load = () => fetchJson('/wo-github/pending-diff?' + query)
        .then((data) => { if (live) setState({ phase: 'ready', data }) },
          (e) => { if (live) setState({ phase: 'error', message: e.message }) })
      load()
      const timer = setInterval(load, 5000)
      return () => { live = false; clearInterval(timer) }
    }, [loc.path, file, version])

    if (state.phase === 'loading') return React.createElement('div', { className: 'wog-pendingfile' },
      React.createElement(PaneMessage, { text: 'Loading diff…' }))
    if (state.phase === 'error') return React.createElement('div', { className: 'wog-pendingfile' },
      React.createElement(PaneMessage, { text: state.message, error: true }))

    const applyPatch = (patch, reverse) => {
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-stage-hunk', { path: loc.path, patch, reverse })
        .then(() => { setVersion((n) => n + 1); onChanged() },
          (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }

    const diffService = diffServiceResolver()
    const renderHunks = (patchText, stagedSection) => {
      const parts = patchPartsOf(patchText)
      if (parts.hunks.length === 0) return null
      return React.createElement('div', { key: stagedSection ? 'staged' : 'unstaged', className: 'wog-hunksection' },
        React.createElement('div', { className: 'wog-hunksection-title' },
          stagedSection ? 'Staged changes' : 'Unstaged changes',
          ' \u00b7 ' + parts.hunks.length + (parts.hunks.length === 1 ? ' hunk' : ' hunks')),
        parts.hunks.map((hunk, i) => {
          const singlePatch = parts.header + hunk.raw
          const hunks = hunksOfPatch(singlePatch)
          const body = diffService !== undefined
            ? diffService.diffFileComponent({ showToggle: false, wrap: true, scroll: false })({
              hunks, mode,
              onLineToggle: busy ? undefined : (hunkIndex, src) => {
                applyPatch(parts.header + partialHunkPatch(hunk, src), stagedSection === true)
              },
            })
            : React.createElement('pre', { className: 'wog-rawpre' }, hunk.raw)
          return React.createElement('div', { key: 'h' + i, className: 'wog-hunk' },
            React.createElement('div', { className: 'wog-hunkhead' },
              React.createElement(Checkbox, {
                checked: stagedSection === true, disabled: busy,
                label: hunk.head,
                title: stagedSection ? 'Unstage this hunk' : 'Stage this hunk',
                className: 'wog-hunkcheck',
                onChange: () => { applyPatch(singlePatch, stagedSection === true) },
              }),
              stagedSection !== true
                ? React.createElement('span', { className: 'wog-hunkhint' }, 'click a line to stage just it') : null),
            body)
        }))
    }

    const stagedSection = renderHunks(state.data.staged, true)
    const unstagedSection = state.data.untrackedText !== undefined
      ? React.createElement('div', { className: 'wog-hunksection' },
          React.createElement('div', { className: 'wog-hunksection-title' }, 'Untracked file'),
          React.createElement(PaneMessage, { text: 'Check the file in the list to stage all of it.' }),
          (() => {
            if (diffService === undefined) return React.createElement('pre', { className: 'wog-rawpre' }, state.data.untrackedText)
            return diffService.diffFileComponent({ showToggle: false, wrap: true, scroll: false })({
              hunks: hunksOfPatch(untrackedPatchOf(file, state.data.untrackedText)), mode,
            })
          })())
      : renderHunks(state.data.unstaged, false)

    return React.createElement('div', { className: 'wog-pendingfile' },
      React.createElement('div', { className: 'wog-pendingfile-head' },
        React.createElement('div', { className: 'wog-file-head' },
          React.createElement('span', { className: 'wog-file-name' }, file),
          untracked ? React.createElement('span', { className: 'wog-file-status' }, 'untracked') : null),
        React.createElement(SegmentedControl, {
          id: 'wog-pending-mode',
          value: mode,
          options: [
            { value: 'split', label: 'Split' },
            { value: 'unified', label: 'Unified' },
          ],
          label: 'Diff view mode',
          onChange: (next) => { setMode(next) },
        })),
      error !== undefined ? React.createElement('p', { className: 'wog-error' }, error) : null,
      stagedSection, unstagedSection)
  }

  /** The index is the source of truth: a row's checkbox stages/unstages the
   *  whole file immediately; the commit box commits exactly what is staged. */
  /** GitHub Desktop layout: file list + commit box on the left, the
   *  selected file's diff on the right, both visible at once. */
  const PendingPane = ({ loc }) => {
    const query = 'path=' + encodeURIComponent(loc.path)
    const [version, setVersion] = React.useState(0)
    const [state, setState] = React.useState({ phase: 'loading' })
    const [selected, setSelectedState] = React.useState(pendingSelected.get(loc.path))
    const [summary, setSummary] = React.useState('')
    const [description, setDescription] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(undefined)
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
    // The selection follows the list: first file by default, kept while it
    // still exists, cleared when the tree goes clean.
    const effectiveSelected = selected !== undefined && files.some((f) => f.file === selected)
      ? selected
      : files.length > 0 ? files[0].file : undefined
    if (effectiveSelected !== selected) setSelected(effectiveSelected)
    const selectedRow = files.find((f) => f.file === effectiveSelected)
    const stagedCount = files.filter((f) => f.staged).length
    const groups = [
      { id: 'staged', label: 'Staged', rows: files.filter((f) => f.staged) },
      { id: 'unstaged', label: 'Unstaged', rows: files.filter((f) => !f.staged && !f.untracked) },
      { id: 'untracked', label: 'Untracked', rows: files.filter((f) => f.untracked) },
    ].filter((g) => g.rows.length > 0)

    const postStage = (file, stage) => {
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-stage', { path: loc.path, file, stage })
        .then((data) => { setState({ phase: 'ready', data }) }, (e) => { setError(e.message); bump() })
        .then(() => { setBusy(false) })
    }
    const commit = () => {
      setBusy(true); setError(undefined)
      postJson('/wo-github/pending-commit', { path: loc.path, summary, description })
        .then(() => { setSummary(''); setDescription(''); bump() }, (e) => { setError(e.message) })
        .then(() => { setBusy(false) })
    }

    const listSide = React.createElement('div', { className: 'wog-pending-side' },
      React.createElement('div', { className: 'wog-pending-list' },
        files.length === 0 ? React.createElement(PaneMessage, { text: 'Nothing to commit. Working tree clean.' }) : null,
        groups.map((group) => React.createElement('div', { key: group.id, className: 'wog-pendinggroup' },
          React.createElement('div', { className: 'wog-pendinggroup-title' },
            group.label, ' \u00b7 ' + group.rows.length),
          group.rows.map((row) => React.createElement('div', {
            key: row.file,
            className: 'wog-pendingrow' + (row.file === effectiveSelected ? ' wog-pendingrow-active' : ''),
            onClick: () => { setSelected(row.file) },
          },
          React.createElement('span', {
            className: 'wog-pendingrow-check',
            onClick: (e) => { e.stopPropagation() },
          },
          React.createElement(Checkbox, {
            checked: row.staged, disabled: busy,
            label: row.renamedFrom !== undefined ? row.renamedFrom + ' \u2192 ' + row.file : row.file,
            title: row.staged ? 'Unstage this file' : 'Stage this file',
            className: 'wog-pendingcheck',
            onChange: () => { postStage(row.file, !row.staged) },
          })),
          React.createElement('span', { className: 'wog-file-status' }, row.status))))),
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
        }, 'Commit' + (stagedCount > 0 ? ' (' + stagedCount + ')' : '')))))

    const diffSide = effectiveSelected !== undefined
      ? React.createElement(PendingFile, {
        loc, file: effectiveSelected, untracked: selectedRow !== undefined ? selectedRow.untracked : false,
        onChanged: bump,
      })
      : React.createElement(PaneMessage, { text: 'Select a file to see its changes.' })

    return React.createElement('div', { className: 'wog-pending-layout' },
      listSide,
      React.createElement('div', { className: 'wog-pending-main' }, diffSide))
  }

  const CommitDetail = ({ loc, sha, onBack }) => {    const query = 'path=' + encodeURIComponent(loc.path) + (loc.repo !== undefined ? '&repo=' + encodeURIComponent(loc.repo) : '') + '&sha=' + encodeURIComponent(sha)
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
    { id: 'pending', label: 'Pending' },
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
      : active === 'pending' ? React.createElement(PendingPane, { loc })
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
          && a.branch === b.branch && a.sha === b.sha && a.pending === b.pending)
      const tick = () => {
        fetch('/wo-github/branch?path=' + encodeURIComponent(cwd))
          .then((r) => (r.ok ? r.json() : null))
          .then((body) => {
            if (!live) return
            const value = body !== null && typeof body === 'object'
              ? { branch: typeof body.branch === 'string' ? body.branch : null,
                  sha: typeof body.sha === 'string' ? body.sha : null,
                  pending: Number.isFinite(body.pending) ? body.pending : 0 }
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
    const pending = Number.isFinite(branchState.pending) && branchState.pending > 0 ? branchState.pending : 0
    const href = !detached && typeof slug === 'string' && slug !== ''
      ? 'https://github.com/' + slug + '/tree/' + branchState.branch : undefined
    const className = 'wog-branchpill'
    const children = [React.createElement(GithubIcon, { key: 'icon' }),
      React.createElement('span', { key: 'label', className: 'wog-branchpill-label' }, label)]
    if (pending > 0) {
      children.push(React.createElement('span', {
        key: 'pending', className: 'wog-branchpill-badge',
        title: pending + ' file(s) with uncommitted changes',
      }, String(pending)))
    }
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
        + '.wog-branchpill-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:rgba(210,153,34,.22);color:#d29922;font-size:10.5px;font-weight:700;line-height:16px;text-align:center;font-family:inherit}'
        // pending changes (GitHub Desktop layout: list + commit left, diff right)
        + '.wog-pending-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:16px}'
        + '.wog-pending-side{display:flex;flex-direction:column;min-height:0;gap:10px}'
        + '.wog-pending-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}'
        + '.wog-pending-main{min-height:0;min-width:0;overflow-y:auto;padding-right:4px}'
        + '.wog-pendingrow-active{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-hunkhint{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-style:italic}'
        + '.wog-pendinggroup{display:flex;flex-direction:column;gap:2px}'
        + '.wog-pendinggroup-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);padding:4px 2px}'
        + '.wog-pendingrow{display:flex;align-items:center;gap:10px;padding:4px 8px;border-radius:8px;cursor:pointer}'
        + '.wog-pendingrow:hover{background:var(--dsw-alias-interactive-bg-hover)}'
        + '.wog-pendingrow-check{display:inline-flex;min-width:0;flex:1}'
        + '.wog-pendingrow-check span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12.5px}'
        + '.wog-pendingcounts{flex:none;font-size:11.5px;font-family:ui-monospace,monospace}'
        + '.wog-commitbox{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}'
        + '.wog-commit-input{width:100%;box-sizing:border-box}'
        + '.wog-commit-desc{font:inherit;font-size:12.5px;width:100%;box-sizing:border-box;min-height:56px;resize:vertical;padding:8px 10px;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;outline:none}'
        + '.wog-commit-desc:focus-visible{border-color:var(--dsw-alias-label-primary)}'
        + '.wog-commit-btn{align-self:flex-end}'
        + '.wog-pendingfile{display:flex;flex-direction:column;gap:10px}'
        + '.wog-pendingfile-head{display:flex;align-items:center;justify-content:space-between;gap:10px}'
        + '.wog-hunksection{display:flex;flex-direction:column;gap:8px}'
        + '.wog-hunksection-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}'
        + '.wog-hunk{border:1px solid var(--dsw-alias-border-l3);border-radius:10px;overflow:hidden}'
        + '.wog-hunkhead{display:flex;align-items:center;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l3)}'
        + '.wog-hunkcheck span{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}'
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
  module.exports._internal = { timeAgoOf, firstLineOf, hunksOfPatch, CommitsPane, BranchPill, PendingPane, patchPartsOf, partialHunkPatch }

  return module.exports
} })
