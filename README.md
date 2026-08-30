# dsh-wo-github

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: a GitHub subtab in the Workspace Overview tab, presenting the
current workspace's repository as if you were on the site. Local first:
commits, diffs, and the README come from the workspace's own clone.

Three panes:

- **Overview**: the About card: description, topics, stars/watchers/
  forks/issues, language, license, default branch, homepage, last push.
- **README**: the repository README rendered as markdown (through
  [dsh-md-view](https://github.com/joao-paulo-santos/dsh-md-view)), with
  relative links and images resolved against the repo.
- **Commits**: the checked-out branch's history, newest first, paginated.
  Picking a commit shows its full message, +/− stats, and every changed
  file as a unified patch with true line numbers; word-level highlights
  come from [dsh-diff-view](https://github.com/joao-paulo-santos/dsh-diff-view)
  when installed.

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
