---
name: test-case-design
description: The team test case design standard, how a test case is actually built. Load this whenever drafting, reviewing, or reformatting test cases. Covers the Requirement Traceability Matrix structure, the formal test design techniques to apply, coverage tiers, category prefixes, required fields, and verification rules. The test-craft agent loads this at the start of every run.
---

# Test Case Design Standard

The single source of truth for how test cases are built. Everything about *what a test case must contain and how to derive it* lives here. The `test-craft` agent supplies the workflow phases and loads this for the detail.

## Coverage tiers

Scope how deep to go. Default to Critical and state that you did.

| Tier | What it covers | Typical size |
|---|---|---|
| Smoke | The golden path only, enough to prove the feature works at all | 1 to 3 cases |
| Critical | Golden path, main error paths, key boundaries, permission rules, roughly 80% of real risk | Most tickets land here |
| Full | Every equivalence class, every boundary, every rule combination, all applicable non-functional checks | Regression-suite depth |

## Output files

Two CSV files. The test case file is shaped around QMetry, so every column maps directly to a QMetry field (see "QMetry mapping" below) and nothing has to be reinterpreted when the cases are pushed with `/qmetry-push`. Markdown is not the deliverable.

| File | Contents |
|---|---|
| `<ticket-id>-test-cases.csv` | The test cases, one row per test case with its steps as numbered lines, ready to create in QMetry |
| `<ticket-id>-rtm.csv` | The Requirement Traceability Matrix |

**Write both files only after verification is complete**, never earlier. The RTM's "Covered By" column can't be filled in until the cases exist and coverage has been checked, so building it in memory first and writing once at the end is the only order that produces a correct file.

The overview, automation candidates, gaps flagged, and audit trail are reported back to the user in the response, not written into the CSVs, since junk rows break a tool import.

## CSV formatting rules

Both files must be valid CSV, because a malformed file fails an import silently or corrupts rows.

Satisfy these rules by generating the file, not by hand-typing it: hold the rows as structured data and write them out with a real CSV writer (Python's `csv` module, or equivalent), so quoting and escaping happen by construction. A hand-composed quoted line is the most common way this file breaks, and the mistake usually isn't caught until the file is re-parsed afterward.

- First line is the exact header row given below, nothing above it, no title line, no blank line.
- Wrap a field in double quotes whenever it contains a comma, a double quote, or a line break.
- Escape a double quote inside a field by doubling it (`""`).
- Test case file: **one row per test case**, every column filled on that row (Owner aside). The steps go into three cells, `Steps`, `Step Test Data`, and `Step Expected Results`, as numbered lines (see "Step cells" below). RTM file: one row per requirement.
- Multi-line text inside a cell (Objective, Precondition, and the three step cells) stays in one quoted cell, one line per item.
- No blank rows, no trailing separator, no summary row at the bottom.
- UTF-8 encoding.

The field most often got wrong is `Covers`, because a case covering more than one requirement holds a comma. It must be quoted:

```
TC-POS-01,User logs in with valid credentials,...,"R1, R3",Equivalence Partitioning,UI,1,...
```

Single values need no quotes (`R1`), multiple values do (`"R1, R3"`).

## Requirement Traceability Matrix

Every distinct requirement or Acceptance Criteria point from the ticket, PRD section, and Tech Spec gets its own row. Written to `<ticket-id>-rtm.csv` with this exact header:

```
Requirement ID,Requirement,Type,Source,Covered By
```

- **Requirement ID**: `R1`, `R2`, `R3`, in the order encountered.
- **Requirement**: one line describing what it states.
- **Type**: Functional, Non-functional (performance, security, accessibility), or Technical (data model, integration contract).
- **Source**: where it came from, so a reviewer can trace it back (Ticket AC, PRD section name, Tech Spec section name, or Figma frame name).
- **Covered By**: the test case IDs validating it, filled in at verification. Comma-separated inside quotes when there's more than one.

A requirement is its own row if it describes a distinct behavior, rule, or condition, not just a restatement of another row. Don't split one requirement into several rows to inflate the count, and don't merge two distinct requirements into one row to save space.

## Test design techniques

Cases are derived systematically, never improvised. Work out which techniques apply to each requirement, and name the technique that produced each case.

| Technique | Use when | What to derive |
|---|---|---|
| Equivalence Partitioning | The requirement accepts a range or set of inputs | One case per valid class, one per invalid class, rather than many cases from the same class |
| Boundary Value Analysis | Numeric ranges, limits, dates, or sizes | The boundary itself, one below it, one above it, on both ends |
| Decision Table | Two or more conditions combine to determine the outcome | One case per meaningful condition combination, not just the obvious one |
| State Transition | Something moves between statuses or stages | Each valid transition, plus attempts at the invalid ones |
| Pairwise | Many parameters combine and full coverage would explode | Every pair of parameter values covered at least once, rather than every combination |
| Error Guessing | Experience says a specific failure is likely here | Targeted cases for the failure modes a seasoned tester would expect |

If a requirement is simple enough that only one technique applies, use it and move on. Don't manufacture cases just to show technique breadth.

## Category prefixes

Every test case ID is `TC-<PREFIX>-<sequence>`, sequence starting at 01 per prefix, per ticket.

| Prefix | Category | Applies When |
|---|---|---|
| TC-POS | Positive Behaviour | Always |
| TC-NEG | Negative / Error Behaviour | Accepts input, calls an external system, or has a failure mode |
| TC-BND | Boundary / Limits | Numeric ranges, limits, thresholds, dates, or pagination |
| TC-RULE | Business Rules / Conditions | A calculation, decision logic, or configurable rule |
| TC-ROLE | Roles / Permissions | Functionality gated by role, plan type, or user status |
| TC-DATA | Data Conditions | Behaviour changes by data state (empty, partial, bulk, stale) |
| TC-FAIL | Failure / Recovery | Multi-step process, integration, or async operation |
| TC-SEC | Security | Authentication, authorization, user input reaching a query, or sensitive data |
| TC-PERF | Performance | A stated response time, throughput, or concurrency expectation |
| TC-A11Y | Accessibility | Adds or changes user-facing UI |
| TC-COMPAT | Compatibility | Behaviour could differ across browsers, devices, screen sizes, or operating systems |

Use only the prefixes that genuinely apply. Don't force a category in to look thorough, and don't skip one that applies. TC-SEC, TC-PERF, TC-A11Y, and TC-COMPAT are the ones most often skipped in practice; include them whenever their trigger is met, even at Critical tier.

## Test case fields

Written to `<ticket-id>-test-cases.csv` with this exact header row:

```
ID,Name,Objective,Precondition,Priority,Status,Owner,Coverage,Covers,Technique,Level,Steps,Step Test Data,Step Expected Results
```

**Case columns:**

- **ID**: `TC-<PREFIX>-<sequence>`. QMetry assigns its own key (`PROJ-TC-12`), so the ID is carried into the QMetry summary to stay traceable.
- **Name**: short and specific, naming the scenario, not "test 1". QMetry's only mandatory field. `<ID> <Name>` together must fit in 255 characters.
- **Objective**: one or two sentences on what this case proves and why it matters. Required here even though QMetry treats it as optional, since it is the only place a reviewer in QMetry sees intent.
- **Precondition**: what must be true before step 1 can run, including environment, feature flag, and existing data state. "None" if genuinely none.
- **Priority**: `High`, `Normal`, or `Low`, case-sensitive. `/qmetry-push` maps them to QMetry's priorities using `qmetry.priorityMap` in `qa.config.json` (for example `Normal` to `Medium`). High means money, authentication, or data loss is at stake; Normal means core business logic; Low means UI or cosmetic.
- **Status**: `Draft`, always. The CSV is never marked `Approved`; the push into QMetry is the approval, made under the reviewer's name.
- **Owner**: left empty. QMetry needs an Atlassian account ID, and a placeholder name would fail the create call.
- **Coverage**: the Jira ticket key (`PROJ-123`). Becomes the QMetry requirement link.
- **Covers**: the RTM Requirement ID(s) this validates (`R1`, or `"R1, R3"`).
- **Technique**: which technique produced this case.
- **Level**: `UI`, `API`, `Integration`, `Database`, or `E2E`.

**Step columns:**

- **Steps**: the actions the tester performs, one numbered line per step, in execution order. One action per line, not several folded together.
- **Step Test Data**: for each step, the specific accounts, records, payloads, or values it uses, so a tester isn't left inventing them. `None` on the line of a step that needs none.
- **Step Expected Results**: for each step, its observable outcome. Every step has one, so a tester executing in QMetry can mark each step Pass or Fail. The last step's expected result is the one that settles the case.

### Step cells

QMetry stores each step as its own record, so `/qmetry-push` splits the three step cells back into steps by their line numbers. The three cells are only lined up by those numbers, which is why these rules are strict:

- Every line starts with its step number, a full stop, and a space: `1. `, `2. `, `3. `. Numbering starts at 1 and runs without gaps.
- One line per step. A step, its test data, and its expected result never contain a line break of their own; write a longer payload on one line.
- All three cells have the same number of lines for a case. Line 3 of `Step Test Data` and line 3 of `Step Expected Results` belong to line 3 of `Steps`.
- When a step needs no test data, its line still exists and reads `None` (`2. None`). An expected result line is never `None`.

```
TC-POS-01,...,UI,"1. Navigate to the Mapping Skor list screen.
2. Open the Pilih Aksi dropdown on an Aktif row.","1. None
2. Row config_id = CONFIG-1001","1. The list loads with Status badges.
2. The dropdown shows ""Nonaktifkan Skor""."
```

When a reviewer adds or removes a step, it has to be added to or removed from all three cells and the lines renumbered.

Keep test cases atomic: one test case checks one thing. Don't fold multiple requirements into a single case just because they're related.

**API-level cases**: never put a real hostname or a real credential in a test case. Use `{{baseUrl}}` for the host and `{{authToken}}` for auth, with paths only (`/v1/orders`). The request step states the method, path, and body (body in Step Test Data); its expected result states the status code and the response fields being asserted.

## QMetry mapping

How each column becomes a QMetry test case, the call order, and where the case lands (folder, test cycle, test plan) are owned by the `qmetry-push` skill, not this standard. The QMetry folder is chosen at push time, which is why the CSV has no folder column.

When adding or renaming a column here, update the mapping table in `.claude/skills/qmetry-push/SKILL.md` and the CSV parser in `scripts/qmetry-api.ts` in the same change.

## Verification rules

Three checks, all reported explicitly:

1. **Requirement coverage**: fill the RTM "Covered By" column with the test case IDs validating each requirement. Every row must have at least one. Any row without one is a gap.
2. **Duplication**: if existing test cases were accessible, name any drafted case resembling an existing one alongside the existing ID, so the reviewer merges instead of duplicating. If they weren't accessible, say so plainly rather than implying the check happened.
3. **Regression impact**: if this ticket changes behavior existing test cases already cover, name those cases as needing an update. If it couldn't be checked, say so.

## Reported in the response, not in the CSVs

- **Overview**: ticket, feature in one line, coverage tier used, sources actually read, date.
- **Automation candidates**: which drafted cases (by ID) are good automation candidates (stable, repeatable, high-value regression checks) versus better kept manual (exploratory, one-off, UI-judgment-heavy). A flag for the QA reviewer, not a decision made here.
- **Gaps flagged**: anything the sources didn't cover clearly enough to draft a confident case for, plus every uncovered RTM row. Ambiguities and contradictions between sources go here too, named specifically.
- **Audit trail**: coverage tier used, which sources were actually read, how many requirements and cases resulted, and the date.

## Review checklist

`checklist.md`, in this skill's folder, is the list drafted cases are checked against. Read it and run every item before writing output, recording each as Pass, Fail, Not applicable with a reason, or Could not check with a reason. Fix every Fail before writing the files, and put anything unfixable into Gaps Flagged rather than reporting it as passing.

The same checklist is what QA uses at the review gate, and what Developers use when checking technical accuracy, so a case that passes here is already in the shape a reviewer expects.

## House style

No em-dashes or en-dashes as mid-sentence punctuation. No unexplained jargon or acronym codes. Use "Developers", not "Development", for the role name.
