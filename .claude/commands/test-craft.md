---
description: Draft test cases for a Jira ticket using the test-craft agent
argument-hint: <ticket-id> [smoke|critical|full] [--prd path] [--spec path] [--figma link-or-path]
---

# Test Craft

Gather the inputs, then launch the `test-craft` agent to draft test cases.

Input: $ARGUMENTS

## Parse the arguments

- **Ticket ID**: required. Ask for it if missing.
- **Coverage tier**: `smoke`, `critical`, or `full`. Defaults to `testCases.defaultTier` in `qa.config.json` (`critical` unless the team changed it). Say which tier you used.
- **`--prd <path or link>`**: the PRD document, optional.
- **`--spec <path or link>`**: the Tech Spec document, optional.
- **`--figma <link or path>`**: a Figma design link, or a local PDF or image exported from Figma, optional. Only needed when the ticket doesn't already link the design, or the link can't be opened.

Use the flags rather than guessing from position, so a single document reference isn't ambiguous between the PRD, the Tech Spec, and the design.

## Gather the ticket content before launching the agent

Do this here, in the main conversation, not inside the agent. The agent runs autonomously and can't hold a back-and-forth, so anything needing a question has to be settled first.

1. If `docs/test-cases/<ticket-id>-qmetry-push.json` exists and its state isn't `"rolled_back"`, stop: the ticket's test cases are already in QMetry. Name the push log and don't launch the agent.
2. If `docs/test-cases/<ticket-id>-test-cases.csv` or `<ticket-id>-rtm.csv` already exists, ask the user before continuing, since it may have been reviewed or edited. If they agree, tell the agent it may overwrite them.
3. Pull the ticket's title, description, and Acceptance Criteria through the Atlassian MCP: `getAccessibleAtlassianResources` once for the cloud ID, then `getJiraIssue` with `view: "evidence"` so custom fields come back, including the `Figma` field. Note the numeric issue ID too; the agent uses it to find cases QMetry already links to the ticket.
4. If the Atlassian MCP isn't available, ask the user to paste the ticket content, and wait for it. Do not launch the agent without it, an agent launched with only a ticket ID and no way to read it will come straight back asking for the content, wasting the round trip.
5. If a PRD or Tech Spec was given, read the relevant content so you can hand the agent the actual text rather than a path it may not be able to reach. Read a local path with the file tools, and a Confluence link with `getConfluenceContent`.
6. Read the Figma design, if there is one. See "Read the design" below.

## Read the design

Collect every Figma design link: the ticket's `Figma` field, any `figma.com/design/` link in the description, and the `--figma` flag. If `--figma` is a local PDF or image export, read it with Read and go straight to step 3. Read each one here rather than leaving it to the agent, because a design that can't be opened needs a question to the user.

1. Take the file key and node ID from the link (`node-id=1549-211880` is node `1549:211880`).
2. Call `get_metadata` on the node for the frames and layers, then `get_screenshot` on the node and on any frame that shows a state the ticket describes (dialogs, loading, error, success, empty). Download each screenshot with the curl command it returns into the scratchpad and view it with Read. Don't call `get_design_context`; it is meant for turning a design into code.
3. Write down, as text for the agent:
   - Each relevant frame by name, and what state it shows.
   - All on-screen text, word for word: titles, body text, button labels, field labels, badges, toasts, and error messages.
   - Controls and states the ticket doesn't mention (a close icon, a disabled or loading button, an inline error area).
   - Where the design disagrees with the ticket, quoting both.
4. If a design can't be read (no access, Figma MCP not connected, link without a node ID), tell the user the exact reason and ask whether to fix access and retry, export the frames from Figma as a PDF and give its path, or continue without the design. If `whoami` shows the connected account isn't a member of any team beyond its own, access is the likely cause: Figma only lets connected tools read files owned by a team the account belongs to. Don't continue silently. If they continue, tell the agent the design exists but wasn't read, so it lands in Gaps Flagged.

## Launch the agent

Launch `test-craft` (via the Agent tool, subagent_type `test-craft`), passing the ticket content, the numeric Jira issue ID, coverage tier, any PRD or Tech Spec content, and the design notes (or that a linked design couldn't be read) you gathered, as text in the prompt. Never describe a linked design to the agent as optional.

It loads the `test-case-design` skill for the standard, then runs five phases (builds a Requirement Traceability Matrix, selects test design techniques, drafts cases, verifies coverage, duplication, and regression impact, then runs the review checklist over the whole draft), and writes two CSV files into `docs/test-cases/`: the test cases (one row per case with numbered steps, mapped to QMetry fields) and the traceability matrix.

## Report back

Present what it returns: both file paths, the requirements and cases counts, the coverage tier used, the verification results (including any check it couldn't perform), the checklist result with any item it marked not applicable or could not check, automation candidates, and any flagged gaps.

End with the next step: once QA (and Developers, for technical accuracy) have reviewed the CSVs, run `/qmetry-push <ticket-id>`.
