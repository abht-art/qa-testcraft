---
description: Draft test cases for a Jira ticket using the test-craft agent
argument-hint: <ticket-id>[,<ticket-id>...] [smoke|critical|full] [--prd path] [--spec path] [--figma link-or-path]
---

# Test Craft

Gather the inputs with the `ticket-brief` agent, settle any questions, then launch the `test-craft` agent to draft test cases.

Input: $ARGUMENTS

## Parse the arguments

- **Ticket ID**: required. Ask for it if missing. Several IDs, comma or space separated, draft each ticket in its own agent, in parallel (see "Several tickets" below).
- **Coverage tier**: `smoke`, `critical`, or `full`. Defaults to `testCases.defaultTier` in `qa.config.json` (`critical` unless the team changed it). Say which tier you used.
- **`--prd <path or link>`**: the PRD document, optional.
- **`--spec <path or link>`**: the Tech Spec document, optional.
- **`--figma <link or path>`**: a Figma design link, or a local PDF or image exported from Figma, optional. Only needed when the ticket doesn't already link the design, or the link can't be opened. Giving it also makes the design be read on a ticket that isn't a frontend ticket.

Use the flags rather than guessing from position, so a single document reference isn't ambiguous between the PRD, the Tech Spec, and the design.

## Gather the inputs before launching the agent

The `test-craft` agent runs autonomously and can't hold a back-and-forth, so anything needing a question is settled here first. The reading itself is done by the `ticket-brief` agent, so the raw Jira issue, documents and Figma screenshots stay out of this conversation, which resends its whole context on every turn.

Keep the round trips down: issue independent calls in the same turn, and ask every question the run needs in one message instead of one at a time.

1. **Checks, in one turn.** Read `qa.config.json` for `jira.site`. Read `docs/test-cases/<ticket-id>-qmetry-push.json`: if it exists and its state isn't `"rolled_back"`, stop: the ticket's test cases are already in QMetry. Name the push log and don't launch anything. Read `docs/test-cases/<ticket-id>-test-cases.csv` and `<ticket-id>-rtm.csv` with `limit: 1` (just to see whether they exist, without loading them); if either exists, the user's consent to overwrite is one of the questions in step 3.
2. **Read the sources.** Launch `ticket-brief` (Agent tool, subagent_type `ticket-brief`) with the ticket key, `jira.site` as the cloud ID (or "unknown" if unset or still `your-site.atlassian.net`), any `--prd`, `--spec` and `--figma` values, and the brief path: `<scratchpad>/<ticket-id>-brief.md`, using the scratchpad directory from the system prompt, or the system temporary directory if there is none. It returns a short summary and a "Needs a decision" list; it doesn't paste the brief back, and you don't need to read it.
3. **Ask, once.** Put everything that needs the user into one message: overwrite consent, and each "Needs a decision" item (missing or unclear Acceptance Criteria, a document that couldn't be read, a design that is missing or couldn't be read). For a design, offer: fix access and retry, give an exported PDF path, or continue without it. If the Atlassian tools weren't available, ask the user to paste the ticket content, and write it to the brief path yourself.
4. **Follow up.** If the user gives a new design link or PDF, launch `ticket-brief` again with "design only", the design and the same brief path. If they continue without a design, tell the `test-craft` agent the design was skipped by the user. If they decline overwriting, or the Acceptance Criteria can't be turned into pass or fail checks and they have nothing more to give, stop.

## Launch the agent

Launch `test-craft` (Agent tool, subagent_type `test-craft`) with a short prompt: the brief path (it reads the ticket, documents and design notes from there), the numeric Jira issue ID, the coverage tier, whether it may overwrite existing CSVs, and the design status (as in the brief, or that the user skipped it). Don't copy the brief into the prompt; writing it out again only costs time. Never describe a design that was read as optional.

It loads the `test-case-design` skill for the standard, then runs five phases (builds a Requirement Traceability Matrix, selects test design techniques, drafts cases, verifies coverage, duplication, and regression impact, then runs the review checklist over the whole draft), and writes two CSV files into `docs/test-cases/`: the test cases (one row per case with numbered steps, mapped to QMetry fields) and the traceability matrix.

## Several tickets

Do step 1 for every ticket in one turn, then launch one `ticket-brief` agent per ticket in a single message, so they read in parallel. Ask the questions for all tickets in one message. Then launch one `test-craft` agent per ticket in a single message; each writes only its own ticket's files. Report each ticket's results as its agent returns. Every agent still runs the full workflow, so parallel runs cost more tokens, not quality.

## Report back

Pass on what it returns without rewriting or expanding it; the details are in the CSVs. It covers both file paths, the requirements and cases counts, the coverage tier used, the verification results (including any check it couldn't perform), the checklist result with any item it marked not applicable or could not check, automation candidates, and any flagged gaps.

End with the next step: once QA (and Developers, for technical accuracy) have reviewed the CSVs, run `/qmetry-push <ticket-id>`.
