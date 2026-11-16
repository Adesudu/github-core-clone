# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Adesudu/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Adesudu/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/reward?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process. No UI, no outside service, no proxy, no git binary — it speaks the protocols itself:

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (capability advertisement, ls-refs, fetch with shallow/deepen, sideband packfile) and receive-pack v0 (fast-forward-only updates, per-ref `ok`/`ng` report-status).
- **REST v3** under `/api/v3`: repositories, branches, commits, contents, labels, issues, comments and pull requests with squash merge.
- **GraphQL v4** at `/api/graphql`: viewer, repository, node, `__type`, issues/pullRequests connections with cursor pagination, and the createIssue, closeIssue, createPullRequest, mergePullRequest and addComment mutations.
- **MCP** at `/mcp`: `server/discover` plus the legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) over the same store as REST and GraphQL.

Git objects (blob, tree, commit, tag), packfile read/write (plain and delta), and the smart-HTTP protocol are implemented from scratch in `src/`. State is in-memory and deterministic: dates come from `MAKEFUN_TRIAL_NOW` plus a monotonic per-call second counter, so a replay leaves byte-identical state.

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and exits 0 when the env reports `{"done": true}`. Authentication is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `src/main.ts` — the entry/env lifecycle (unchanged from the starter).
- `src/app.ts` — the HTTP server and routing.
- `src/store.ts` — the in-memory forge: repos, refs, objects, issues, pull requests.
- `src/gitcore.ts` — git objects, packs, reachability and fetch plans.
- `src/githttp.ts` — smart HTTP: info/refs, upload-pack, receive-pack.
- `src/rest.ts` — REST v3. `src/graphql.ts` — GraphQL v4 (hand-written parser and executor). `src/mcp.ts` — MCP.
- `src/util.ts` — SHA-1 hashing, pkt-lines, base64, the deterministic clock.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qq4pkark&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
