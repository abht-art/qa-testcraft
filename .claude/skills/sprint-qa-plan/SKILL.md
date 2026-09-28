---
name: sprint-qa-plan
description: Use this skill when the user asks to "create a sprint QA plan", "generate the QA planning doc", "start a new sprint QA planning document", "fill in the QA sign-off doc", or similar, to produce a new Sprint QA Planning & Sign-off document for the current or a named sprint.
---

# Sprint QA Plan

Generates a new Sprint QA Planning & Sign-off document: one document per sprint, covering every feature/story tested that sprint, instead of separate documents per feature.

## Steps

1. Ask the user for what's needed to fill Section 1 (Sprint Overview) and Section 2 (Features/Stories in Scope) if not already given: sprint name/number, dates, QA owners, environment, test management tool, and the list of features/stories in scope for the sprint (with Jira links, objective, and scope of testing for each). Don't invent feature details, ask, or use whatever the user pastes in from Jira.
2. Copy the structure below exactly, filling in what the user provided.
3. Leave the QA Checklist (Section 5) and QA Sign-off Checklist (Section 6) items unchecked by default, since this document is created at the start of a sprint, before testing has happened. Only check items off if the user explicitly says testing/sign-off is already complete for some of them.
4. Leave Section 4 (Execution & Reporting) and Section 7 (Final Sign-off) blank or with placeholder text, since those get filled in as the sprint progresses and at sign-off time, not at plan creation.
5. Save the result to `docs/qa-planning/sprint-<sprint-name-or-number>-qa-planning.md`, using a lowercase, hyphenated sprint identifier (e.g., `sprint-24-qa-planning.md`).
6. Follow house style: no em-dashes or en-dashes as mid-sentence punctuation, no unexplained jargon or acronym codes, "Developers" as the role name, and no mention of Product/BA in QA/Dev-level documents.
7. Tell the user the file is ready and remind them to publish it to Confluence once it's reviewed, and to link each story's QA subtask back to this document.

## When updating an existing sprint doc

If a sprint QA planning doc already exists for the sprint the user is asking about (in `docs/qa-planning/`), update that file in place rather than creating a new one, for example, when the user reports execution numbers, defect counts, or is ready to complete sign-off.

## Document structure to generate

```markdown
# Sprint QA Planning & Sign-off: [Sprint Name / Number]

## 1. Sprint Overview

| Field | Details |
|---|---|
| Sprint | [Sprint name/number] |
| Dates | [Start date] to [End date] |
| QA Owners | [Names] |
| Environment | [Staging / QA environment name] |
| Test Management Tool | [Tool name and link] |

## 2. Features / Stories in Scope

Repeat this block for each feature or story tested in the sprint.

### Feature: [Feature Name]

**Jira Story/Epic**: [Link]

**Objective**: [What this feature does and why.]

**Scope of Testing**: [What specifically will be validated, in a few bullet points.]

**Test Strategy** (check the types that apply):

- [ ] Functional Testing: [Key functional areas]
- [ ] Integration Testing: [Modules/systems this feature connects to]
- [ ] Regression Testing: [Existing functionality that could be affected]
- [ ] End-to-End Testing: [Full user journeys to validate]
- [ ] UI/UX Testing: [Visual/interaction elements to check]
- [ ] Edge Case & Negative Testing: [Invalid inputs, boundary conditions, error paths]
- [ ] Data Integrity Testing: [Data persistence, accuracy, consistency checks]
- [ ] Performance Testing: [Load times, response times, concurrency, if applicable]
- [ ] Security Testing: [Access control, data handling, if applicable]

**QA Owner**: [Name]

**QA Subtask**: [Link to the Jira subtask tracking this feature's QA lifecycle stage]

## 3. Test Environment

| Item | Details |
|---|---|
| Environment | [e.g. Staging] |
| Browsers | [e.g. Chrome, Firefox] |
| OS | [e.g. Linux, Windows] |
| Devices | [e.g. Desktop, Mobile] |
| Test Data | [Accounts, data sets, or setup required] |

## 4. Execution & Reporting

| Feature | Test Cases Planned | Executed | Passed | Failed | Blocked | Defects Raised |
|---|---|---|---|---|---|---|
| [Feature Name] | | | | | | |
| **Sprint Total** | | | | | | |

**Defect Summary**: [Total defects raised this sprint, broken down by severity if useful.]

**Execution Notes**: [Environment issues, scope changes mid-sprint, carried-over work, etc.]

## 5. QA Checklist (applied per feature)

- [ ] Test cases are derived from the Acceptance Criteria, and cover all applicable plans, roles, and product types for the story.
- [ ] Test cases are independent, cover both positive and negative scenarios, and are written in a clear, consistent format with preconditions, steps, and expected result.
- [ ] Boundary values and failure/recovery scenarios are included where applicable.
- [ ] Edge cases are covered, and test case coverage against the story's functional requirements is complete.
- [ ] Compatibility across devices, browsers, and platforms is tested where applicable.
- [ ] Test cases are reviewed for clarity, completeness, and correctness, and prioritized by business impact.
- [ ] The build is deployed correctly to the QA environment, passes smoke tests, and is properly integrated with the test environment.
- [ ] Automated tests relevant to the story run successfully and cover the major scenarios.
- [ ] Every failure has a linked defect, not just a comment.
- [ ] All planned test cases are executed and either passed or have a tracked, resolved defect.

## 6. QA Sign-off Checklist (applied once for the sprint, before release)

- [ ] A full regression suite has run, previously fixed bugs haven't reoccurred, and results show no new failures compared to the previous version.
- [ ] Every feature behaves as expected against its requirements, core functionality works under normal conditions, and all user stories in the sprint have been tested and verified.
- [ ] The build has been checked for common vulnerabilities such as XSS and SQL injection, authentication/authorization work correctly, and sensitive data is encrypted.
- [ ] The interface matches the design, all elements are aligned and functional, and the flow is easy to use.
- [ ] The build meets agreed performance benchmarks (load time, response time), holds up under expected load, and doesn't degrade with increased usage.
- [ ] The build works across the required browsers, devices, screen sizes, and operating systems.
- [ ] Test cases, execution results, and defect reports are complete and up to date in the test management tool.
- [ ] Automated regression tests are included in the deployment pipeline, cover the critical paths, and run successfully on every deployment.
- [ ] Every issue is tracked in the defect system with clear repro steps and evidence, assigned and prioritized by severity, and fixes are retested before closure.
- [ ] All required tests have been executed and passed, critical issues are resolved or have a documented mitigation plan, and results have been communicated to stakeholders before the build is signed off for release.

## 7. Final Sign-off

| Field | Details |
|---|---|
| Signed off by | [QA Lead name] |
| Date | [Date] |
| Decision | [Approved for release / Approved with known risk / Not approved] |
| Known risks or accepted gaps | [List anything not covered, with reasoning] |
```
