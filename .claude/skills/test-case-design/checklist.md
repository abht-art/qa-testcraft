# Test Case Review Checklist

The list a drafted set of test cases is checked against before anyone acts on it. Every item is verifiable by looking at the two output files, so a reviewer never has to work out what the cases should have contained before judging what they do contain.

## Who runs this and when

| Who | When | What they focus on |
|---|---|---|
| The `test-craft` agent | Before writing the output files, as the last step of every run | Every item. Fix what fails, then report the result item by item. |
| QA reviewer | At the review gate, before any case is marked Approved | Every item, with most attention on coverage, scenario categories, and whether a step is actually executable by someone who didn't write it. |
| Developer reviewer | On complex or high-risk features | Technical accuracy: sections D, F4 to F8, H3 to H5, and S3, where knowing the real system behavior is what makes the judgement possible. |

## How to record a result

Each item gets one of four outcomes, never a silent skip:

- **Pass**, verified against the files.
- **Fail**, with what's wrong. The agent fixes a Fail before writing output. A reviewer sends it back.
- **Not applicable**, with the reason it doesn't apply to this ticket.
- **Could not check**, with what was missing. Never report Pass on something that wasn't actually verified.

Anything that fails and can't be fixed from the available sources belongs in Gaps Flagged, not in a passing result.

## T. Traceability

- [ ] **T1** Every Acceptance Criteria point in the ticket, and every relevant PRD or Tech Spec statement, appears as its own RTM row. Nothing in the sources is missing from the matrix.
- [ ] **T2** No RTM row restates another, and no row merges two distinct behaviors to save space.
- [ ] **T3** Every RTM row has a Type of Functional, Non-functional, or Technical, and a Source specific enough to trace back to a named ticket AC item, PRD section, Tech Spec section, or Figma frame.
- [ ] **T4** Every RTM row's Covered By column names at least one test case ID. Any empty row is listed under Gaps Flagged.
- [ ] **T5** Every ID in Covered By exists in the test case file, and every value in a case's Covers column exists in the RTM. No orphan on either side.

## D. Derivation

- [ ] **D1** Every case names the technique that produced it, and it is one of the six in the standard.
- [ ] **D2** Every requirement accepting a range or set of inputs has at least one valid class case and one invalid class case.
- [ ] **D3** Every numeric range, limit, date, or size has cases at the boundary, one below, and one above, at both ends where both ends exist.
- [ ] **D4** Every requirement where two or more conditions combine has cases beyond the obvious combination.
- [ ] **D5** Every status or stage change has a case for each valid transition, plus at least one attempt at an invalid one.
- [ ] **D6** No case exists that no technique produced. Nothing was improvised in to pad the count.

## S. Scenario coverage

- [ ] **S1** Every functional requirement has a positive case for its golden path.
- [ ] **S2** Every input, external system call, and known failure mode has a negative case.
- [ ] **S3** Security considered: authentication, authorization, user input reaching a query, sensitive data. Covered by a TC-SEC case, or ruled out with a stated reason.
- [ ] **S4** Performance considered: any stated response time, throughput, or concurrency expectation. Covered or ruled out with a reason.
- [ ] **S5** Accessibility considered: any added or changed user-facing UI. Covered or ruled out with a reason.
- [ ] **S6** Compatibility considered: behavior that could differ across browsers, devices, screen sizes, or operating systems. Covered or ruled out with a reason.
- [ ] **S7** No prefix is used whose trigger isn't actually met by this ticket.
- [ ] **S8** Depth matches the tier requested. Smoke stops at the golden path. Critical adds main error paths, key boundaries, and permission rules. Full covers every class, every boundary, every rule combination, and all applicable non-functional checks.

## F. Fields, every case

- [ ] **F1** ID is unique and follows `TC-<PREFIX>-<sequence>`, sequence starting at 01 per prefix.
- [ ] **F2** Name names the specific scenario, not a number or a category, and `<ID> <Name>` fits in 255 characters.
- [ ] **F3** Covers names at least one valid requirement ID.
- [ ] **F4** Level is one of UI, API, Integration, Database, or E2E, and matches what the steps actually exercise.
- [ ] **F5** Objective states what the case proves in one or two sentences. Precondition states what must be true before step 1, including environment or feature flag state where it matters, or "None".
- [ ] **F6** Step Test Data names the specific accounts, records, payloads, or values each step uses, or `None` for a step that uses none. No step leaves a tester inventing data.
- [ ] **F7** Each case is one row. In `Steps`, `Step Test Data`, and `Step Expected Results`, every line starts with `1. `, `2. `, and so on without gaps, the three cells have the same number of lines, each step line is a single action, and the steps are executable by a tester who didn't write them.
- [ ] **F8** Every step has an expected result line that is an observable outcome, never `None`, and the last step's result settles pass or fail. Not "works correctly", not "no errors".
- [ ] **F9** Priority is exactly `High`, `Normal`, or `Low` and follows the risk definitions. High means money, authentication, or data loss. Normal means core business logic. Low means UI or cosmetic.
- [ ] **F10** Status is `Draft`, Coverage holds the Jira ticket key, Owner is empty, and there is no Folder column.
- [ ] **F11** No step line in the three step cells contains a line break of its own, and no case is split across more than one row.

## W. Writing quality

- [ ] **W1** One case checks one thing. No case folds several requirements together because they happen to be related.
- [ ] **W2** No case depends on another case having run first, unless its Preconditions say so explicitly.
- [ ] **W3** Steps describes what the tester does, Step Expected Results describes what the system does. The two are not mixed into one column.
- [ ] **W4** House style holds: no dashes used as mid-sentence punctuation, no unexplained jargon or acronym codes, "Developers" rather than "Development".

## X. Cross-checks

- [ ] **X1** Duplication was checked against the existing repository, with any resembling pair named by both IDs, or reported plainly as not performed because existing cases weren't accessible.
- [ ] **X2** Regression impact was checked, naming existing cases this ticket's behavior change makes wrong, or reported plainly as not performed.
- [ ] **X3** No two cases drafted in this run duplicate each other.

## H. Honesty and safety

- [ ] **H1** Nothing asserts behavior the sources didn't state. Anything inferred sits in Gaps Flagged rather than being written as fact.
- [ ] **H2** Contradictions and ambiguities between ticket, PRD, Tech Spec, and design are named specifically in Gaps Flagged, not silently resolved by picking one.
- [ ] **H3** No API case contains a real hostname or a real credential. Host is `{{baseUrl}}`, auth is `{{authToken}}`, paths only.
- [ ] **H4** Every API case has a request step stating the method and path (body in Step Test Data), with an expected result stating the status code and the response fields being asserted.
- [ ] **H5** No real customer data, personal data, or production identifier appears in Test Data.

## C. File format

- [ ] **C1** Both files exist at the expected paths, with the ticket ID lowercased.
- [ ] **C2** The header row is exactly the one in the standard, on the first line, with nothing above it.
- [ ] **C3** Every field containing a comma, double quote, or line break is wrapped in double quotes, with inner quotes doubled.
- [ ] **C4** The test case file has one row per case, its row count matches the number of cases drafted, and every ID appears once. The RTM row count matches the requirements. No blank rows, no summary row, no trailing separator.
- [ ] **C5** Both files were re-read after writing and `node scripts/qmetry-api.ts validate --ticket <ticket-id>` reports `"ok": true`.

## G. Handoff

- [ ] **G1** No case is marked Approved. Everything is `Draft` until a human reviews it.
- [ ] **G2** Automation candidates are named by ID, with the cases better kept manual identified too.
- [ ] **G3** Gaps Flagged lists every uncovered RTM row and every source point too unclear to draft a confident case from.
- [ ] **G4** The audit trail reports the coverage tier used, which sources were actually read, the requirement and case counts, and the date.
- [ ] **G5** Overview, automation candidates, gaps, and audit trail are in the response, not written into the CSV files.
