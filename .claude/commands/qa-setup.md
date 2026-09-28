---
description: Create or update qa.config.json from your real Jira and QMetry settings
argument-hint: "[PROJ-123 sample ticket]"
---

# QA Setup

Create `qa.config.json` from `qa.config.example.json` (the template) and fill it in with live values, checked against `qa.config.schema.json` (the definition of every field): the Jira site and project from the Atlassian MCP, and the QMetry project, priorities, statuses and folders from `scripts/qmetry-api.ts`. Ask the user only where there is a real choice, then check the result with `doctor`.

Input: $ARGUMENTS (optional: a ticket key from the team's project, used to confirm the Jira project)

This runs in the main conversation, because it asks questions. Read `qa.config.schema.json` first: its descriptions say what each field means, and `scripts/config.ts` rejects any key the schema doesn't list.

## Step 0: What already exists

- If `qa.config.json` exists, read it and show its current values. This is an update: change only what the user agrees to, and keep everything else as it is.
- If it doesn't exist, this is a first setup: run `cp qa.config.example.json qa.config.json` now, so the file starts from the template with every field, its order, and the `$schema` line. The steps below only replace placeholder values in it.
- The QMetry lookups need `QTM_API_TOKEN` in `.env`. Never read `.env` to check; run `node scripts/qmetry-api.ts check`. Exit code 2 means the token is missing: tell the user to `cp .env.example .env`, `chmod 600 .env`, and add their QMetry Open API key (Jira, QMetry, Configuration, Open API, Generate) in their editor, then run `/qa-setup` again. Never ask them to paste the key into the conversation.

## Step 1: Jira, from the Atlassian MCP

1. `getAccessibleAtlassianResources`. Each result is a site: its `url` host (for example `your-site.atlassian.net`) is `jira.site`. With more than one site, ask which one this team uses.
2. The project key:
   - If a sample ticket was given, `getJiraIssue` it on that site and take the project key from the result. That also proves the account can read the project.
   - Otherwise list the projects the account can see (use `discover` to find the read operation that lists Jira projects, then `executeRead`), and ask which one. If listing isn't available, ask the user for one ticket key and use `getJiraIssue`.
3. If the Atlassian MCP isn't connected, say so (`/mcp` to log in) and ask the user for the site and project key instead. Say in the summary that the Jira values were typed in, not read.

## Step 2: QMetry, from the script

Run these (they work before `qa.config.json` exists):

1. `node scripts/qmetry-api.ts projects` lists the QMetry-enabled projects. `qmetry.projectKey` is usually the same key as Jira. If that key isn't in the list, QMetry isn't enabled for the project: stop and say an admin needs to enable it.
2. Region. If the QMetry calls fail with a connection or 401 error and the team is outside the US region, the base URL is likely wrong: ask whether their QMetry is `qtmcloud.qmetry.com` or `syd-qtmcloud.qmetry.com`, and set `qmetry.baseUrl` to `https://<host>/rest/api/latest`. Run the lookups with `QTM_API_BASE_URL=<that url>` until the file is written.
3. `node scripts/qmetry-api.ts meta --project <KEY>` returns the priorities and test case statuses.
4. `node scripts/qmetry-api.ts folders --project <KEY>` returns the test case folders.

## Step 3: Propose the values, then ask once

Work out a proposal from what Steps 1 and 2 returned, then ask everything in one round, showing the proposal as the default so the user only confirms or changes it.

| Setting | Where it comes from | Proposal |
|---|---|---|
| `team.name` | The user | Ask. Shown in generated documents |
| `team.documentRole` | Default | `Developers` |
| `jira.site` | Atlassian MCP | The chosen site's host |
| `jira.projectKey` | Atlassian MCP | The chosen project key |
| `qmetry.baseUrl` | Region | `https://qtmcloud.qmetry.com/rest/api/latest` unless Step 2 found another region |
| `qmetry.projectKey` | `projects` | The Jira key, if QMetry has it |
| `qmetry.priorityMap` | `meta` priorities | Map the CSV's `High`, `Normal`, `Low` to real, non-archived priority names. Match by name where one exists (`High` to `High`, `Low` to `Low`); `Normal` usually goes to `Medium`. Ask about any the project doesn't clearly have |
| `qmetry.caseStatus` | `meta` test case statuses | Ask which status means "reviewed and approved". Offer the real list; suggest `Approved` if it exists, otherwise `Done`. `null` leaves the project default |
| `qmetry.mainFolder` | `folders` | Ask for the folder pushes normally go under, from the real list, or `null` to be asked at every push |
| `qmetry.labels` | Default | `true` |
| `qmetry.markAiGenerated` | Default | `true` (keeps AI-drafted cases identifiable in QMetry) |
| `testCases.defaultTier` | The user | `critical` unless they prefer `smoke` or `full` |

Never put a value in the file that the lookups didn't return, other than `team.name`: a priority, status or folder QMetry doesn't have breaks every push.

## Step 4: Write and check

1. Edit the values in `qa.config.json` in place; don't add or remove keys, since the template already has every one the schema allows. Never put a token or any secret in it.
2. Run `node scripts/qmetry-api.ts doctor`. `"ok": true` means done. Anything under `problems` is fixed in the file and `doctor` is run again; `notes` are shown to the user as advisory.
3. Report the final values in a short table, marking each as read from Jira, read from QMetry, chosen by the user, or a default. Remind the user that `qa.config.json` is gitignored, so it stays on this machine: each teammate runs `/qa-setup` once after cloning (or copies the file), alongside their own `.env`.
