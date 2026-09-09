# Reports

## Present

- `octocat_Hello-World_1.{json,md,html}` — the Task 5.2 integration test. Live
  run, score 79/100, all three subagents invoked, Zod validation passed.

## Missing: the nine Phase 6 reports

`airaamane/simple-todo-app` could **not** be reached:

```
GET https://api.github.com/repos/airaamane/simple-todo-app   -> 404 Not Found
GET https://api.github.com/users/airaamane                   -> 200, public_repos: 0
```

The `airaamane` account exists but has zero public repositories, so the test
repository is private. An unauthenticated request to a private repo returns 404,
and no `GITHUB_TOKEN` was available. GitHub rate limits were **not** the cause
(37 of 60 requests remained).

To generate them, set a `GITHUB_TOKEN` in `.env` that can read that repository
(scopes: `repo`, `read:org`), then:

```bash
npm run dev -- airaamane simple-todo-app 1
npm run dev -- airaamane simple-todo-app 2
npm run dev -- airaamane simple-todo-app 3
```

Each run writes `airaamane_simple-todo-app_<pr>.json`, `.md` and `.html`,
giving all nine files.

If the repository is genuinely inaccessible, ask the course for the correct
owner/repo or for access — the system itself is verified working against a
public PR (see above).
