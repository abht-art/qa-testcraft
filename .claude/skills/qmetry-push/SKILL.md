---
name: qmetry-push
description: The standard for pushing reviewed test cases from a test case CSV into QMetry Test Management for Jira (QTM4J) Cloud. Load this whenever creating QMetry folders, test cases, steps, requirement links, test cycles, or test plans from a `docs/test-cases/<ticket-id>-test-cases.csv` file, or when rolling a QMetry push back. Covers the CSV to QMetry field mapping, pre-push checks, what the script does and in which order, the push log, resuming, and rollback. The /qmetry-push command loads it before making any QMetry call.
---

# QMetry Push Standard

How a reviewed test case CSV becomes test cases, a test cycle, and a test plan entry in QMetry. The CSV format is defined by the `test-case-design` skill; this skill owns only how that file reaches QMetry.

Everything here runs through one script calling the QMetry REST API directly, so a 16 case push takes seconds. The conversation's job is to gather answers, run the dry run, get the user's yes, then run the script once and report.

## Tool

`scripts/qmetry-api.ts` (Node 22.18+, no dependencies). It reads `QTM_API_TOKEN` from `.env` and sends it as the `apiKey` header. Never read, print, or source `.env`.

Every QMetry call goes through `scripts/qmetry-endpoints.ts`: one typed function per Open API endpoint (`qtm.testCases.create`, `qtm.requirements.linkTestCases`, `qtm.testPlans.unlinkTestCycles`, ...), each naming its method and path from the specification, over one transport that handles auth, timeouts and retries. Reads retry on network errors, 429 and 5xx; writes retry only on 429, since any other failed write may have been applied and is left to the push log's resume. To use a new endpoint, add a function there with its spec path; never call `fetch` from the push script directly. `QTM_DEBUG=1` traces each call to stderr without the key.

## Team settings

`qa.config.json` holds this team's QMetry project key, API base URL, priority mapping, test case status, default main folder, whether labels are used, and whether cases are flagged AI-generated (`markAiGenerated`). `/qa-setup` creates it from live values. The script applies them, so a flag is only needed to override one. Read it before asking the user anything, and never hardcode a project key, priority or status: they differ per team, and `node scripts/qmetry-api.ts doctor` reports what the project actually has.

| Command | Changes QMetry | Used for |
|---|---|---|
| `doctor` | No | Setup check: config, token, and the project's real priorities, statuses and folder |
| `check` | No | Token and connection check. Exit code 2 means the token is missing or the config is unusable |
| `projects` | No | QMetry-enabled projects the key can see. Runs before `qa.config.json` exists |
| `project [--project <KEY>]` | No | QMetry project ID |
| `meta [--project <KEY>]` | No | Priorities, test case, cycle, and plan statuses, label count |
| `folders [--project <KEY>] [--type testcase\|testcycle\|testplan]` | No | Folder IDs and paths |
| `plans [--project <KEY>]` | No | Test plan keys and summaries |
| `search-testcases [--text <words>] [--label <name>] [--issue-id <id>] [--folder-id <id>] [--limit 50]` | No | Existing test cases, for duplicate and regression checks |
| `testcase --key <PROJ-TC-3>[,<PROJ-TC-7>,...] [--version <n>]` | No | Test cases with their steps; several keys are fetched in parallel |
| `validate --ticket <KEY-123>` | No | Both CSVs against the test-case-design standard, no API calls. Exit 3 lists `problems` |
| `push ...` without `--confirm` | No | Dry run: every pre-push check plus the plan of what would be created |
| `push ... --confirm` | **Yes** | The push. `--allow-existing` only when the user confirms adding to cases QMetry already links to the ticket |
| `verify --ticket <KEY-123>` | No | Re-checks a logged push against QMetry |
| `create-folder [--project <KEY>] --name <name> (--parent-id <id> \| --root)` | **Yes** | Creating a main folder, only when the user asks for one |
| `rollback --ticket <KEY-123>` without `--confirm` | No | Lists what a rollback would delete |
| `rollback --ticket <KEY-123> --confirm` | **Yes, deletes** | Only on the user's explicit request |

`--project` defaults to `qmetry.projectKey` in `qa.config.json`; pass it only to work on another project.

Output is JSON on stdout, progress lines on stderr. Exit codes: 0 success, 1 failure, 2 token missing or config unusable, 3 a check failed.

## Names

| Thing | Name |
|---|---|
| Subfolder | `--name`, which defaults to the ticket key (`PROJ-123`) unless the user asks for another name |
| Test case summary | `<ID> <Name>` from the CSV, trimmed to 255 characters |
| Test cycle summary | Same as the subfolder |

A name must not contain `/` or `\`.

## Field mapping

One QMetry test case per CSV row, created in a single call with its steps.

| CSV column | QMetry field (`POST /testcases`) | Notes |
|---|---|---|
| ID + Name | `summary` | See Names |
| Objective + Covers | `description` | A final paragraph `Covers: R1, R3 (<ticket-id>-rtm.csv)` is appended, since QMetry has no requirement ID field |
| Precondition | `precondition` | As is |
| Priority | `priority` (ID) | Matched by name. QMetry projects often have `Blocker, High, Medium, Low`, so `Normal` needs `--priority-map Normal=Medium` |
| Status | `status` (ID) | The CSV always says `Draft`. The push is the approval, so the user picks the QMetry status that means approved (`--case-status`, for example `Done`). If the user doesn't pick one, the project default is used |
| (subfolder) | `folderId` | The subfolder this push created |
| Owner | not sent | Empty in the CSV |
| (every case) | `aiGenerated` | `true` when `qmetry.markAiGenerated` is on (the default), so AI-drafted cases can be filtered in QMetry |
| Coverage, ID prefix, Technique, Level | `labels` (IDs) | Label names (`PROJ-123`, `tc-pos`, `technique-decision-table`, `level-ui`). Missing labels are created first. `--no-labels` skips them |
| Steps, Step Test Data, Step Expected Results | `steps[].stepDetails`, `.testData`, `.expectedResult` | Split on the numbered lines; line N of each cell makes step N. `None` test data is left out |
| Coverage | Requirement link | The **numeric** Jira issue ID (`--issue-id`), from `getJiraIssue`. The Jira issue type must be enabled as a requirement in QMetry settings |

The reviewer has no QMetry field. It is recorded in the push log and in the test cycle description.

## Before the push

Every one of these must pass. The dry run (`push` without `--confirm`) runs checks 1 to 7 itself and prints `problems` if any fail, with exit code 3.

1. **CSV is valid.** Both files pass `validate`: the header matches `test-case-design`, every field follows the standard, the three step cells have matching numbered lines, no expected result is `None`, Covers and Covered By agree, and no case holds a real host or credential.
2. **Coverage matches the ticket.**
2a. **QMetry has no cases linked to the ticket yet.** The push log only guards the machine it is on, so the dry run also asks QMetry. Existing linked cases stop the push unless `--allow-existing` is passed on the user's say-so.
3. **Not already pushed.** A log with `"state": "complete"` stops the push. `"in_progress"` resumes it. `"rolled_back"` stops until the user decides.
4. **Priorities and status exist** in the QMetry project, after any `--priority-map`.
5. **Main folder exists**, matched by path or name, or given by ID. If several match, the dry run lists them; ask the user.
6. **Subfolder is free.** A folder with the subfolder name under the main folder that this push did not create stops the push.
7. **Test plan choice is settled.** `--plan <key>` (must exist), `--new-plan <summary>` (must not already exist), or `--no-plan`.
8. **User confirmed.** Show the dry run's `plan` block: ticket, reviewer, main folder and subfolder, cycle name, number of cases and steps, priority and status mapping, labels to be created, whether cases are flagged AI-generated, the test plan, and the CSV's SHA-256. Wait for an explicit yes.

## What `push --confirm` does

The script writes the push log after every successful create, and marks a `pending` entry just before each create so an interrupted call can be matched on resume instead of duplicated.

1. Create the subfolder under the main folder.
2. Create any missing labels.
3. Create each test case, in CSV order, with its steps, folder, priority, status, and labels in one call.
4. Link all test cases to the Jira issue in one call (`POST /requirements/{issueId}/testcases/link`).
5. Create the test cycle with all test cases linked in the same call, then confirm the cycle holds every case and link any that are missing.
6. Link the test cycle to the Jira issue.
7. Create the test plan if `--new-plan`, then add the cycle to the plan.
8. Verify: the subfolder holds exactly the logged cases, each case has the CSV's step count, the cycle holds every case, and every case is linked to the issue. Only then is the log marked `complete`.

About 33 calls for 16 cases with labels, most of them the test case creates.

## Push log

`docs/test-cases/<ticket-id>-qmetry-push.json`, ticket ID lowercased. Fields: `ticket`, `issueId`, `projectKey`, `projectId`, `csvFile`, `csvSha256`, `reviewer`, `pushedBy` (the operating system user who ran the push), `name`, `startedAt`, `completedAt`, `state`, `mainFolder`, `subfolder`, `mapping` (priority map, case status, labels on or off, AI-generated flag), `labels` (with `created` true for labels this push made), `testCases` (CSV ID to QMetry `id`, `key`, `versionNo`), `requirementLinked`, `testCycle`, `testPlan` (with `created`), `planRequest`, `planLinked`, `pending`, `failures`, `verification`, and `rollback` once one has run. It never holds the token.

**Never delete a push log.** It is what stops a ticket being pushed twice, what a resume and a rollback read, and what holds the QMetry IDs a rollback needs. To undo a push, roll it back, which leaves the log with `"state": "rolled_back"`. If a log is deleted anyway, resuming and rolling that push back are no longer possible.

## Resuming

If a push stops, the script records the failure and exits with 1. Re-run the **same** `push --confirm` command:

- The CSV's SHA-256 must match the log, or the script stops: the reviewed content changed mid-push, and the user decides.
- The reviewer, names, folder, mapping, and plan choice come from the log, not the new arguments.
- Everything the log records as done is skipped. A `pending` create is looked up by name first and only recreated if it isn't there.

Never loop on a failing push. If a resume fails on the same step, report the error from `failures` and stop.

## Rollback

QMetry can delete what a push created. Use it only when the user explicitly asks to undo a push.

1. Run `rollback --ticket <KEY-123>` without `--confirm` and show the user exactly what will be deleted: the test plan if this push created it (or only the plan link if the plan already existed), the test cycle, every test case, and the subfolder.
2. Wait for an explicit yes, then run it with `--confirm`.
3. Labels are never deleted, since other test cases may use them. Test case execution results in the cycle are lost with the cycle, so warn the user if the cycle has been executed.
4. The log is kept with `"state": "rolled_back"` and a `rollback` record. A new push for the ticket needs that log moved or deleted first, which is the user's call.

## Report back

- Ticket, reviewer, main folder path and subfolder name
- A table of CSV ID to QMetry test case key
- Test cycle key and how many cases it holds
- Test plan key and whether it was created or already existed, or that no plan was used
- Labels created
- The verification result, and anything in `failures`
- The push log path

## Verified behavior

Confirmed on a live push of 16 cases with 55 steps, which took about 44 seconds including verification:

- Creating a root folder with `parentId: -1` (`create-folder --root`) works.
- Bulk linking test cases to a requirement (`POST /requirements/{issueId}/testcases/link` with `testcases: [{id, versionNo}]`) links every case.
- Creating a test cycle with `testCasesToLink` puts every case in the cycle.
- Step counts from `teststeps/search` match what was sent.

Exercised on 2026-09-24 against a mock server built from the Open API specification, not against live QMetry: dry run, a push interrupted at the fifth test case and resumed with no duplicates (43 cases, 72 steps), verify, the already-linked check and `--allow-existing`, `search-testcases`, `testcase`, and `rollback --confirm` for both a created plan (deleted) and an existing plan (cycle unlinked, plan kept).

Not yet exercised against live QMetry: the resume, `rollback --confirm`, the `aiGenerated` flag, the already-linked check, and the search filters. The mock only proves the script's own logic and that it calls the specified endpoints; it can't show how QMetry itself responds. If any misbehaves live, record what QMetry returned here.

Corrected from the specification: unlinking a cycle from a plan is `DELETE /testplans/{id}/testcycles`. The earlier `POST .../testcycles/unlink` route does not exist, so a rollback of a push that linked an existing plan would have failed at that step.

## House style

No em-dashes or en-dashes as mid-sentence punctuation. No unexplained jargon or acronym codes. Use "Developers", not "Development", for the role name.
