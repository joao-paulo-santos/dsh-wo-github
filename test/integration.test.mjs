/**
 * dsh-wo-github - cross-plugin integration test.
 *
 * Wires the REAL dsh-workspace-overview client half and the REAL
 * dsh-wo-github client half into one fake window and drives the branch
 * pill click end to end: strip tab clicked, overview page lands on the
 * GitHub subtab, the GitHub tab lands on Pending. Pins the cross-plugin
 * request chain a stale module mix once broke.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname as pathDirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = pathDirname(fileURLToPath(import.meta.url))
const WOG = pathResolve(HERE, '../lib/client.js')
const WOV = pathResolve(HERE, '../../dsh-workspace-overview/lib/client.js')

const PRIMITIVES_FAKE = {
  relativeTime: () => ({ unit: 'now', n: 0 }),
  Button: (props) => ({ type: 'button', props, children: [props.children].flat(Infinity) }),
  Checkbox: (props) => ({ type: 'label', props: {}, children: [] }),
  Input: (props) => ({ type: 'input', props, children: [] }),
  SegmentedControl: (props) => ({ type: 'div', props: {}, children: [] }),
  useSetting: () => [true],
}

const effects = []
let hookIdx = 0
let slots = []   // swapped per component: real React states are per-instance
const react = {
  createElement: (t, p, ...c) => ({ type: t, props: p, children: c.flat(Infinity) }),
  Fragment: 'F',
  useState: (initial) => {
    const i = hookIdx++
    const store = slots   // bind per component: async setters must not leak across stores
    if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
    return [store[i], (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v }]
  },
  useEffect: (fn) => { effects.push(fn) },
}
const mkTag = () => ({ dataset: {}, textContent: '', remove: () => {}, click() { this.clicked = true } })
let stripMounted = false
const chatBtn = { textContent: 'Chat', clicked: false, click() { this.clicked = true } }
const wsBtn = { textContent: 'Workspace Overview', clicked: false, click() { this.clicked = true; stripMounted = true } }
const strip = {
  querySelector: (sel) => sel === 'button[aria-selected="true"]' ? (stripMounted ? wsBtn : chatBtn) : null,
  querySelectorAll: () => [chatBtn, wsBtn],
  firstElementChild: chatBtn,
}
const document = {
  head: { children: [], appendChild() {} },
  createElement: mkTag,
  querySelector: (sel) => sel === '[data-conversation-tabs]' ? strip : null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

let wov, wog
globalThis.window = {
  __ModuleLoader__: { load: (h) => {
    const mod = h.factory((spec) => {
      if (spec === 'react') return react
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_FAKE
      throw new Error('unexpected require: ' + spec)
    })
    if (h.id === 'dsh-workspace-overview') wov = mod
    if (h.id === 'dsh-wo-github') wog = mod
  } },
  addEventListener: () => {}, removeEventListener: () => {},
}
globalThis.document = document
;(0, eval)(readFileSync(WOV, 'utf8'))
;(0, eval)(readFileSync(WOG, 'utf8'))

const provided = {}
const mkCtx = (extra) => ({
  inject: [], get: (n) => provided[n], provide: (n, api) => { provided[n] = api },
  slots: { inject: (seat, fn) => { fn(); return () => {} }, register: (o, c) => c },
  granularSettings: { useSetting: () => [true] },
  ...extra,
})
wov.apply(mkCtx())
const facade = provided.workspaceOverview
wog.apply(mkCtx({ workspaceOverview: facade }))

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
const resolve = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolve(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(resolve) }
}

globalThis.fetch = async (url) => {
  if (String(url).includes('/wo-github/branch')) return { ok: true, json: async () => ({ branch: 'main', sha: null, pending: 2 }) }
  if (String(url).includes('/wo-github/locate')) return { ok: true, json: async () => ({ git: true, slug: null }) }
  if (String(url).includes('/wo-github/pending')) return { ok: true, json: async () => ({ count: 1, files: [{ file: 'a.txt', staged: false, unstaged: true, untracked: false, status: ' M' }] }) }
  return { ok: true, json: async () => ({}) }
}

test('pill click opens Workspace Overview on GitHub/Pending end to end', async (t) => {
  t.after(() => {
    for (const fn of unmounts.splice(0)) { try { fn() } catch (e) {} }
    delete globalThis.window
    delete globalThis.document
  })
  const mkProps = (cwd) => ({
    sessionId: 's1',
    useSessions: (sel) => sel({ current: 's1', byId: { s1: { cwd } } }),
    useWorkspaces: (sel) => sel({ items: [{ path: cwd, sessionIds: ['s1'] }] }),
  })
  const pillSlots = []
  const ovSlots = []
  const renderPill = () => { hookIdx = 0; slots = pillSlots; return wog._internal.BranchPill(mkProps('/w/repo')) }
  const renderOverview = () => { hookIdx = 0; slots = ovSlots; return wov._internal.OverviewTab(mkProps('/w/repo')) }

  renderPill(); await flush()
  let pill = resolve(renderPill())
  const pillButton = flatten(pill).find((n) => n.type === 'button' && typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-branchpill'))
  assert.ok(pillButton !== undefined, 'dirty worktree: pill renders as button')

  // overview view closed: mount it only once the strip tab is clicked
  pillButton.props.onClick()
  assert.equal(wsBtn.clicked, true, 'the Workspace Overview strip tab was clicked')
  assert.equal(wog._internal.paneRequestOf(), 'pending', 'the pending pane was requested')

  resolve(renderOverview())   // mounts; consumption happens in mount effects
  await flush()               // the mount effect consumes requestTab('github')
  const overviewTree = resolve(renderOverview())
  const activeSub = flatten(overviewTree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wsov-subtab-active'))
  assert.equal(textOf(activeSub), 'GitHub', 'the overview page lands on the GitHub subtab')

  await flush()   // GithubTab mount effect consumes requestPane + locate fetch
  resolve(renderOverview())
  await flush()   // PendingPane fetch
  const githubTree = resolve(renderOverview())
  const activePane = flatten(githubTree).find((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('wog-subtab-active'))

  assert.equal(textOf(activePane), 'Pending', 'the GitHub tab lands on the Pending pane')
  assert.equal(wog._internal.paneRequestOf(), undefined, 'the pane request was consumed')
})
