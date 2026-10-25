# dsh-wo-github

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: a GitHub subtab in the Workspace Overview tab, presenting the
current workspace's repository as if you were on the site. Local first:
commits, diffs, and the README come from the workspace's own clone.

Also adds a BRANCH PILL to the composer's left row (beside the persona
picker): the GitHub mark plus the workspace's checked-out branch, polled
live so agent checkouts update it, with an amber badge counting files
with uncommitted changes. When the worktree is dirty, clicking the pill
opens the GitHub tab straight on the Pending pane (clicking again closes
it); clean, it links to the branch's tree. A bag icon with a count between the pill and the
chevron marks stashed change sets (git stash list / stash pop). A chevron
beside the pill opens the branch switcher: switch local branches or create a new one (which
takes the pending changes with you). Switching with a dirty worktree asks
the GitHub Desktop question: leave the changes here (stashed, recoverable
with git stash) or bring them along (refused atomically by git when they
would conflict on the target).
Hidden outside a git repo; a detached HEAD shows the short sha.

A branch header sits above the panes: the checked-out branch with
dirty/stash badges and the same switcher the composer pill has, and the
pane body is keyed by branch so switching branches remounts every pane
against the new checkout.

Four panes:

- **Overview**: the About card: description, topics, stars/watchers/
  forks/issues, language, license, default branch, homepage, last push
  (repo name and branch paint instantly from the git remote and the
  branch pill's cache; fetched fields show skeletons, never a page-wide
  loading blank);
  the README renders beneath it (through
  [dsh-md-view](https://github.com/joao-paulo-santos/dsh-md-view)), with
  relative links and images resolved against the repo, silent when absent.
- **Pending**: the GitHub Desktop surface, side by side: the file list and
  commit box on the left, the selected file's diff on the right, always
  visible together. One flat list where every file carries a three-state
  checkbox: check = fully staged, dash = partially staged (click unstages
  the file), empty = nothing staged (click stages all of it), a status dot
  (orange modified, green new, red deleted; tooltip carries the word), and
  the staged line counts (+N green, -M red, zeros hidden). The diff is ONE combined
  whole-file view (HEAD vs worktree) rendered through
  [dsh-diff-view](https://github.com/joao-paulo-santos/dsh-diff-view) with
  distant regions collapsed into gap rows: one column of checkmarks per
  changed line (filled = already in the index; click to toggle just that
  line) and a second column per section (a group of contiguous lines),
  left of the line marks, anchored at the section's first changed line and
  filled when all its lines are staged; click it to stage or unstage the
  whole section. A
  file's checkbox stages or unstages everything at once. Split/Unified
  toggles; the commit box commits exactly what is staged. Never amends,
  pushes, or touches history.
- **Stash**: the checked-out branch's stashed changes, one row per entry
  with Pop (restore into the worktree and remove the entry) and Drop
  (discard for good); entries from other branches are noted, not listed.
  Clicking the branch pill opens this pane when the worktree is clean but
  stashes exist (dirty always goes to Pending; clean without stashes also
  goes to Pending).
- **History**: the checked-out branch's history, newest first, paginated,
  laid out like Pending: commit list on the left, the selected commit's
  changed files (with +/− counts) beside it, and the selected file's
  unified diff with true line numbers in the main area; word-level
  highlights come from dsh-diff-view when installed.

No git clone and no github.com remote? The tab shows a quiet empty state.
A clone WITHOUT a github.com remote (gitlab, local-only git) still gets
README and Commits, with branch and last-commit facts on the About pane in
place of stars.

## How it fetches

Local first: the host half runs git in the workspace clone:

- Commits come from `git log`, commit diffs from `git show`, the README
  from the committed file (`git show HEAD:README.md`). No rate limits,
  works offline, works on any git host.
- api.github.com fills in what git cannot know (stars, watchers, issues,
  topics, license) on the About card, and serves as fallback when the
  clone cannot answer. The page itself cannot call the API, so the host
  proxies it: unauthenticated access works for public repos; set
  `GITHUB_TOKEN` in the harness environment to lift the
  60-requests-per-hour ceiling.
- API caching: About 5 minutes, commit lists 2 minutes, single commit
  diffs forever (a sha never changes). Local reads are uncached, since git is
  fast and the data is live by definition.
- Rate-limit exhaustion surfaces as a clear message in the tab instead of
  a broken pane.

## How to install

Requires a DeepSeek Harness checkout and a profile, here `web`. Clone the
dependencies and this plugin into a plugins folder:

```sh
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
git clone https://github.com/joao-paulo-santos/dsh-workspace-overview.git
git clone https://github.com/joao-paulo-santos/dsh-md-view.git
git clone https://github.com/joao-paulo-santos/dsh-diff-view.git
git clone https://github.com/joao-paulo-santos/dsh-wo-github.git

# from the harness checkout
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-workspace-overview
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-md-view
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-diff-view
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-wo-github

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Restart the harness; the GitHub tab appears in Workspace Overview.

## Dependencies

- [dsh-workspace-overview](https://github.com/joao-paulo-santos/dsh-workspace-overview) hosts the subtab and resolves the workspace's GitHub slug (required; without it the client half stays inactive)
- the `git` binary on PATH (local reads); api.github.com access is the fallback
- [dsh-md-view](https://github.com/joao-paulo-santos/dsh-md-view) renders the README pane (optional; without it the raw markdown shows as text)
- [dsh-diff-view](https://github.com/joao-paulo-santos/dsh-diff-view) provides word highlights and the diff grid stylesheet (optional; patches still render without it)

## Plugins dependent on this

*(none)*
