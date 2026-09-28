---
description: Push reviewed test cases for a Jira ticket into QMetry Test Management for Jira
argument-hint: <ticket-id> [rollback]
---

# QMetry Push

Push the reviewed test case CSV for a ticket into QMetry: a subfolder under the main folder the user picks, the test cases with their steps and labels, links to the Jira ticket, a test cycle holding every case, and optionally a test plan.

Input: $ARGUMENTS

This runs in the main conversation, not in an agent, because it asks questions and needs a confirmation before creating anything.

## Step 0: Load the push standard

Invoke the `qmetry-push` skill via the Skill tool first. It defines the mapping, checks, script commands, push log, resuming, and rollback. Follow it exactly. If it fails to load, stop.

## Step 1: Find the files

- **Ticket ID**: required. Ask for it if missing.
- **`rollback`**: if given, don't push. Follow the skill's Rollback section for this ticket instead: dry run, show what will be deleted, wait for an explicit yes, then run it with `--confirm`.
- The CSV is `docs/test-cases/<ticket-id>-test-cases.csv`, ticket ID lowercased. If it doesn't exist, stop and say to run `/test-craft <ticket-id>` first.
- Look for `docs/test-cases/<ticket-id>-qmetry-push.json`:
  - `"state": "complete"`: stop. Give the user the logged keys.
  - `"state": "in_progress"`: a resume. Say what the log shows as done, skip Step 3, and go to Step 4 with the same `push` command (the script takes the answers from the log).
  - `"state": "rolled_back"`: stop and ask the user whether to move that log aside and push again.
  - No log: a new push.

## Step 2: Check the connection and read the project

Read `qa.config.json` first: `qmetry.projectKey` is the project these commands work on, and `priorityMap`, `caseStatus`, `mainFolder` and `labels` are this team's defaults for Step 3. The script applies them on its own, so pass a flag only when the user chooses something else.

Then run, in parallel (the project comes from the config, so `--project` is only needed to override it):

- `node scripts/qmetry-api.ts check`. Exit code 2 means `QTM_API_TOKEN` is not in `.env` or `qa.config.json` is unusable; show the message and stop.
- `node scripts/qmetry-api.ts validate --ticket <ticket-id>`. It checks both CSVs against the test-case-design standard (format, fields, traceability, no real hosts or credentials). Exit code 3 lists `problems`; the push refuses the file until they are fixed, so send it back to the reviewer rather than working around it.
- `node scripts/qmetry-api.ts meta`
- `node scripts/qmetry-api.ts folders`
- `node scripts/qmetry-api.ts plans`
- `getJiraIssue` for the ticket's numeric issue ID and summary.

## Step 3: Ask the user

Ask these together, in one round, using what Step 2 returned so every option is real. Where the config already answers one, show that value as the default and ask only for a yes or a change, rather than asking from scratch:

1. **Reviewer**: the QA reviewer who approved the CSV. Don't accept a blank. Never defaulted.
2. **Main folder**: `qmetry.mainFolder` if set, otherwise pick from the listed test case folders. If there are none, offer to create one with `create-folder` (only after the user names it).
3. **Subfolder and cycle name**: default the ticket key.
4. **Test case status**: `qmetry.caseStatus` if set, otherwise which QMetry status means approved (for example `Done`), from `meta`.
5. **Priority mapping**: `qmetry.priorityMap` covers this for most teams. Ask only about a CSV priority the map doesn't resolve to a priority `meta` lists.
6. **Test plan**: an existing plan key from `plans`, a new plan to create (by name), or none. Never defaulted, since it changes every sprint.

If a value the user picks differs from the config, say so in one line and, after the push, offer to update `qa.config.json` so the next push doesn't ask again.

## Step 4: Dry run and confirm

Run `push` with every answer and **without** `--confirm`. Claude Code asks permission for this too, because the `ask` rule matches every `push`; say it is the dry run so the user knows nothing will be created. If it returns `problems`, show them and resolve them with the user; nothing has been created. One problem needs particular care: QMetry already has test cases linked to this ticket. That usually means someone else pushed it from another machine. Show the listed keys and pass `--allow-existing` only if the user confirms that adding to those cases is intended. Otherwise show the `plan` block as a short summary (ticket, reviewer, folder path, cycle name, cases and steps, priority and status mapping, labels to be created, whether cases are flagged AI-generated, test plan, and the CSV's SHA-256) and wait for an explicit yes.

## Step 5: Push

Run the same `push` command with `--confirm`. Claude Code asks for permission first (`.claude/settings.json` puts push, rollback and create-folder under `ask`); that prompt is the second confirmation, not a formality. It does the whole push, writes the log as it goes, and verifies at the end. If it exits with 1, report the error from its output and the log's `failures`, and say that re-running the same command resumes.

## Step 6: Report back

Report what the skill's "Report back" section lists. Mention that the push can be undone with `/qmetry-push <ticket-id> rollback` if needed.
