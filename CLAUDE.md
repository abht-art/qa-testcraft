# CLAUDE.md

Guidance for Claude Code in this repository. Read it before changing anything here.

## What this is

A Claude Code workflow for QA teams on **QMetry Test Management for Jira (QTM4J) Cloud**: it drafts test cases from Jira tickets, gates them through human review, pushes them into QMetry, and records automated results against them. It is a configuration repository with a few dependency-free TypeScript scripts, not an application.

It is shared across teams and companies. Nothing committed may name a company, Jira site, or project. Team values live only in `qa.config.json`, which is gitignored and created per clone with `/qa-setup`. Use `PROJ-123`, `PROJ-TC-3` and `your-site.atlassian.net` in docs and examples.

## Commands

```bash
npm run doctor                                  # setup check: Node, config, token, the project's real priorities/statuses
npm run typecheck                               # run after any script change
node scripts/qmetry-api.ts validate --ticket PROJ-123    # lint drafted CSVs against the standard (no network)
node scripts/qmetry-api.ts search-testcases --text "login"   # existing QMetry cases (read-only)
```

Slash commands: `/qa-setup [sample ticket]` (builds `qa.config.json` from the Atlassian MCP and QMetry), `/test-craft <ticket> [smoke|critical|full] [--prd] [--spec] [--figma]`, `/qmetry-push <ticket> [rollback]`.

Node 22.18+ runs the `.ts` scripts directly. `npm install` only adds type definitions for `tsc`.

## Architecture

Each concern has one owner. Change a thing where it is owned, and don't copy its details elsewhere.

| Concern | Owner |
|---|---|
| Gathering inputs that need a conversation (Jira, PRD, Figma, overwrite consent) | `.claude/commands/test-craft.md` |
| Drafting workflow (RTM, techniques, draft, verify, checklist) | `.claude/agents/test-craft.md` |
| The test case standard: tiers, CSV headers, prefixes, fields, rules | `.claude/skills/test-case-design/SKILL.md` |
| Review checklist (agent and humans) | `.claude/skills/test-case-design/checklist.md` |
| Push conversation: questions, dry run, confirmation | `.claude/commands/qmetry-push.md` |
| CSV to QMetry mapping, pre-push checks, push log, resume, rollback | `.claude/skills/qmetry-push/SKILL.md` |
| QMetry Open API calls: one typed function per endpoint, auth, retries | `scripts/qmetry-endpoints.ts` |
| CLI: doctor, lookups, search, validate/lint, push, verify, rollback | `scripts/qmetry-api.ts` |
| Per-team settings: template, definition, loader | `qa.config.example.json` (copied to `qa.config.json`), `qa.config.schema.json` (allowed keys, types, descriptions; the loader reads its key lists), `scripts/config.ts` |
| Creating those settings from live Jira and QMetry values | `.claude/commands/qa-setup.md` |
| Automated results into QMetry (CI) | `scripts/qmetry-import-results.ts` (guide in `README.md`) |
| Sprint QA plan (self-contained template) | `.claude/skills/sprint-qa-plan/SKILL.md` |

Flow: `/test-craft` gathers inputs, then the agent writes `docs/test-cases/<ticket>-test-cases.csv` and `<ticket>-rtm.csv` (ticket lowercased, written only after verification and a passing `validate`) → QA and Developers review the CSVs → `/qmetry-push` dry runs, gets a yes, pushes, and verifies → the push log `<ticket>-qmetry-push.json` records it.

`docs/` is gitignored: drafts and push logs stay on the machine that made them, so resume and rollback run from that machine. The push also asks QMetry whether the ticket already has linked cases, which is what stops a second push from another machine. All user-facing documentation lives in `README.md`; don't add documents under `docs/`.

## Hard rules

- **Secrets.** Never read, print, source or edit `.env`. The scripts load it themselves. `.claude/settings.json` denies it.
- **What Claude can't read is set in `.claude/settings.json`**, not a `.claudeignore` (Claude Code doesn't read one). Add `Read(./path/**)` to `permissions.deny` to hide a path. Never deny `docs/test-cases/`: the agent writes there and the push reads it.
- **The agent is read-only against QMetry.** Only `/qmetry-push` creates or deletes anything there, and only after a dry run and the user's explicit yes. Push, rollback and create-folder are under `ask` in `.claude/settings.json`, so they always need the user's approval.
- **Every Open API call goes through `scripts/qmetry-endpoints.ts`.** Never call `fetch` for QMetry anywhere else in `scripts/qmetry-api.ts`. Writes are never retried except on 429. The one exception is `scripts/qmetry-import-results.ts`: it uses the separate Automation API and must stay a single dependency-free file that teams copy into their application repository.
- **Nothing is Approved in a CSV.** Drafts are `Draft`; the push is the approval, under the reviewer's name.
- **Push logs are never deleted or hand-edited.** They block a double push, and resume and rollback read them. Undo a push with `rollback` (state becomes `rolled_back`).
- **Never assume QMetry values.** Priorities and statuses differ per project: read them (`doctor`, `meta`) and map through `qmetry.priorityMap`. Many projects have no `Approved` status and no `Normal` priority.
- **Requirement links use the numeric Jira issue ID** (`13227`), not the key. Resolve it with `getJiraIssue`.
- **Ask before overwriting** a ticket's existing CSVs.

## Change checklists

- **CSV columns change:** update the header in `test-case-design/SKILL.md`, the mapping in `qmetry-push/SKILL.md`, `CSV_HEADER` and `lintDraft` in `scripts/qmetry-api.ts`, and the checklist's F items, in one change.
- **New QMetry endpoint:** add a function to `scripts/qmetry-endpoints.ts` with its method and path from the [specification](https://app.swaggerhub.com/apis-docs/qmetry-ada/qtm4j_cloud/restapi).
- **New setting:** `qa.config.schema.json`, `scripts/config.ts` (type, default, validation), `qa.config.example.json`, the proposal table in `.claude/commands/qa-setup.md`, and the settings table in `README.md`.
- **Push log fields:** keep them optional, so older logs still resume and roll back.
- **Any script change:** run `npm run typecheck` before committing; it must pass.

## Choosing the model

The `test-craft` agent is pinned to `claude-sonnet-5` at `effort: high`. Test design is reasoning-heavy (decision tables, boundaries, contradictions across sources, a long self-audit), so `high` is set explicitly. Sonnet 5 is half the cost of Opus 5.5; expect more checklist items to come back to the reviewer. The model is pinned rather than aliased, so every teammate's drafts come from the same model. Change it in the agent's frontmatter as a reviewed change:

- `claude-opus-5-5`: stronger reasoning for complex tickets, at twice the cost of Sonnet 5.
- `claude-fable-5-1`: the most capable model, for very large or ambiguous tickets. Costs 2.5 times as much per token as Opus 5.5 and takes longer.

## House style (all generated documents)

- No em-dashes or en-dashes as mid-sentence punctuation.
- No unexplained jargon or acronym codes.
- "Developers" as the role name, not "Development".
- No mention of Product or BA in QA or Developer-level documents.
