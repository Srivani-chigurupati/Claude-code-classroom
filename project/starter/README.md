# Enterprise Multi-Agent Code Review Orchestrator

A multi-agent system that reviews GitHub pull requests using the Claude Agent
SDK. A main orchestrator fetches the PR through the GitHub MCP server, delegates
each changed file to three specialized subagents in parallel, and aggregates
their findings into one schema-validated report rendered as Markdown, HTML and
JSON.

## Architecture

```
main.ts  (CLI: arg + auth + model validation, report writing)
   |
   v
CodeReviewOrchestrator            rate limiter -> retry -> timeout
   |  query() with allowedTools ['Task', ...mcp tools, ...subagent tools]
   |  outputFormat: json_schema from ReviewReportSchema
   |
   +-- GitHub MCP ---- get_pull_request, get_pull_request_files
   |
   +-- Task --> code-quality-analyzer   security / perf / bug-risk (+ Skill)
   +-- Task --> test-coverage-analyzer  coverage gaps + concrete test cases
   +-- Task --> refactoring-suggester   before/after structural improvements
   |
   v
ReviewReport  -> Zod safeParse -> reports/<owner>_<repo>_<pr>.{json,md,html}
```

Each file's three subagents are invoked in a single message so they run
concurrently. The orchestrator never analyzes code itself.

## Layout

```
src/
  agents/      three AgentDefinitions + the registry handed to the SDK
  prompts/     one prompt per agent, plus the orchestrator prompt builder
  config/      MCP server configuration (GitHub, ESLint)
  types/       Zod schemas and their JSON Schema exports
  utils/       logger, report generator, error handler, rate limiter
  orchestrator.ts
  main.ts
tests/         schemas, utils, orchestrator (SDK mocked - no API key needed)
.claude/skills/  security-analysis, javascript-best-practices,
                 code-review-best-practices
```

## Setup

Requires Node.js 18+.

```bash
# from the repository root (npm workspaces)
npm install

cd project/starter
cp .env.example .env
```

Edit `.env`:

```bash
# Authentication - ONE of:
ANTHROPIC_API_KEY=sk-ant-...                     # Anthropic API
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION   # Bedrock
# (In the Vocareum workspace ANTHROPIC_API_KEY is already in your environment.)

# Required for both
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
# Bedrock form: us.anthropic.claude-sonnet-4-5-20250929-v1:0

# Required - must contain .claude/skills/
PROJECT_ROOT=/absolute/path/to/project/starter

# Recommended: raises GitHub rate limits and allows private repos
# GITHUB_TOKEN=ghp_...

LOG_LEVEL=info
```

No credential is read from source: the GitHub token is taken from the
environment and mapped to `GITHUB_PERSONAL_ACCESS_TOKEN`, the name the GitHub
MCP server expects.

## Usage

```bash
npm run dev -- <owner> <repo> <pr-number>
npm run dev -- octocat Hello-World 1

npm run build && npm start <owner> <repo> <pr-number>
```

Three files are written per run:

```
reports/<owner>_<repo>_<pr>.json
reports/<owner>_<repo>_<pr>.md
reports/<owner>_<repo>_<pr>.html
```

Structured logs go to `logs/combined.log` and `logs/error.log`.

## Testing

```bash
npm test          # 100 tests, no API key or network required
npm run lint      # tsc --noEmit
npm run build
```

The SDK is mocked in `tests/orchestrator.test.ts`, so aggregation, summary
recomputation, schema validation, retry, timeout and report writing are all
covered offline. The one live integration test is `it.skip`-ped by design.

## Implementation notes

- **Model is never hardcoded.** The orchestrator reads
  `process.env.ANTHROPIC_MODEL`; every subagent uses `model: 'inherit'`, so one
  value drives the whole run and the same build works against the Anthropic API
  and Bedrock.
- **`allowedTools` includes the subagents' tools.** It is a session-wide
  permission filter, so listing only `Task` would block the subagents' `Read` /
  `Grep` / `Skill` calls under any `permissionMode` stricter than
  `bypassPermissions`. The list is derived from the agent definitions, so it
  cannot drift.
- **Least privilege.** No subagent has `Write`, `Edit` or `Bash`. The
  refactoring agent proposes diffs as text; it cannot apply them.
- **The summary is recomputed, not trusted.** After `safeParse` succeeds, the
  five summary counters are recalculated from `fileReviews`, and `metadata`
  is replaced with measured timings, so headline numbers cannot contradict the
  findings beneath them.
- **Retries are selective.** `withRetry` takes a predicate; deterministic
  failures (schema validation, bad config, timeout) are rethrown immediately
  with their own error code rather than re-running a full multi-agent review.
- **The ESLint MCP tool is `lint-files`.** Verified by an `initialize` +
  `tools/list` handshake against the server; `mcp__eslint__lint` does not exist.

## Deliverable status

Phases 1-5 are complete and verified: `npm run lint`, `npm run build` and
`npm test` (100 passing) are clean, and both MCP servers complete a stdio
handshake.

Task 5.2 (live integration test) passes against a real PR:

```
npm run dev -- octocat Hello-World 1
-> 96.5s, score 79/100, 3 subagents invoked, 3 report files written
```

Phase 6 is **not** complete, and not for want of an API key. The test
repository is unreachable:

```
GET /repos/airaamane/simple-todo-app  -> 404 Not Found
GET /users/airaamane                  -> 200, public_repos: 0
```

The account exists but has no public repositories, so the repo is private and
an unauthenticated request cannot see it. Set a `GITHUB_TOKEN` with read access
to it in `.env`, then run the three commands in `reports/README.md` to produce
all nine files.

A failed PR fetch is reported as a `PR_NOT_FOUND` error and writes no report -
an empty, zero-score report is never presented as a successful review.
