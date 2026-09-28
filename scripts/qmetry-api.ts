#!/usr/bin/env node
/**
 * QMetry Test Management for Jira (QTM4J) Cloud REST API helper, used by /qmetry-push.
 *
 * No dependencies: Node 22.18+ runs this TypeScript file directly.
 *
 *   node scripts/qmetry-api.ts doctor
 *   node scripts/qmetry-api.ts check
 *   node scripts/qmetry-api.ts projects
 *   node scripts/qmetry-api.ts project --project PROJ
 *   node scripts/qmetry-api.ts meta --project PROJ
 *   node scripts/qmetry-api.ts folders --project PROJ [--type testcase|testcycle|testplan]
 *   node scripts/qmetry-api.ts create-folder --project PROJ --name Sprint_26 (--parent-id 123 | --root) [--type testcase]
 *   node scripts/qmetry-api.ts plans --project PROJ
 *   node scripts/qmetry-api.ts search-testcases [--text "login"] [--label PROJ-123] [--issue-id 13227] [--folder-id 123] [--limit 50]
 *   node scripts/qmetry-api.ts testcase --key PROJ-TC-3 [--version 1]
 *   node scripts/qmetry-api.ts validate --ticket PROJ-123
 *   node scripts/qmetry-api.ts push --ticket PROJ-123 --issue-id 13227 --reviewer "Name" --name PROJ-123
 *        (--folder Sprint_26 | --folder-id 123) (--plan PROJ-TP-1 | --new-plan "Sprint 26" | --no-plan)
 *        [--priority-map Normal=Medium] [--case-status Done] [--no-labels] [--allow-existing] [--confirm]
 *   node scripts/qmetry-api.ts verify --ticket PROJ-123
 *   node scripts/qmetry-api.ts rollback --ticket PROJ-123 [--confirm]
 *
 * push and rollback only change QMetry when --confirm is passed; without it they print what they would do.
 *
 * Auth: QTM_API_TOKEN (QMetry Open API key, sent as the `apiKey` header), read from the environment or
 * from `.env` at the repo root.
 *
 * Settings: qa.config.json supplies the project key, base URL, priority map, test case status, default
 * folder and whether labels are used. A flag overrides the file, and QTM_API_BASE_URL overrides both.
 *
 * Output is JSON on stdout, progress on stderr. Errors go to stderr with a non-zero exit code:
 * 2 = token missing or config unusable, 3 = a check failed, 1 = any other failure.
 * The token is never printed. QTM_DEBUG=1 traces each call (method, path, status, duration) to stderr.
 *
 * Every QMetry call goes through the typed endpoint functions in scripts/qmetry-endpoints.ts, which
 * follow the QTM4J Cloud Open API specification.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_QMETRY_BASE_URL, loadConfig } from "./config.ts";
import {
  ApiError, createClient, endpoints, type CreateTestCase, type FolderNode, type FolderType, type Named, type TestCaseFilter, type TestCaseSummary,
} from "./qmetry-endpoints.ts";

const SEARCH_PAGE = 100;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSV_HEADER = [
  "ID", "Name", "Objective", "Precondition", "Priority", "Status", "Owner", "Coverage", "Covers",
  "Technique", "Level", "Steps", "Step Test Data", "Step Expected Results",
];
const FOLDER_TYPES = ["testcase", "testcycle", "testplan"];
const RTM_HEADER = ["Requirement ID", "Requirement", "Type", "Source", "Covered By"];
const TECHNIQUES = ["Equivalence Partitioning", "Boundary Value Analysis", "Decision Table", "State Transition", "Pairwise", "Error Guessing"];
const LEVELS = ["UI", "API", "Integration", "Database", "E2E"];
const CSV_PRIORITIES = ["High", "Normal", "Low"];
const PREFIXES = ["POS", "NEG", "BND", "RULE", "ROLE", "DATA", "FAIL", "SEC", "PERF", "A11Y", "COMPAT"];

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Per-team settings. Flags always win over the file, and QTM_API_BASE_URL wins over both.
const { config: CONFIG, errors: CONFIG_ERRORS, warnings: CONFIG_WARNINGS, exists: CONFIG_EXISTS } = loadConfig();
// Lookups /qa-setup needs to write qa.config.json in the first place. Each takes --project.
const SETUP_COMMANDS = ["doctor", "check", "projects", "project", "meta", "folders", "plans"];
const CONFIG_UNSET = (key: string) => CONFIG_WARNINGS.some((w) => w.startsWith(`"${key}" is still the placeholder`));

// ---------------------------------------------------------------------------
// Plumbing

function fail(message: string, code = 1): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(code);
}

function progress(message: string): void {
  console.error(message);
}

function token(): string {
  const value = (process.env.QTM_API_TOKEN ?? "").trim();
  if (!value) {
    fail("QTM_API_TOKEN is not set (add it to .env)", 2);
  }
  return value;
}

const qtm = endpoints(createClient({
  baseUrl: process.env.QTM_API_BASE_URL || CONFIG.qmetry.baseUrl || DEFAULT_QMETRY_BASE_URL,
  apiKey: token,
  debug: process.env.QTM_DEBUG === "1" ? progress : undefined,
}));

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Lookups

interface FlatFolder {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
}

async function projectByKey(key: string): Promise<{ id: number; key: string; name: string }> {
  const resp = await qtm.projects.search(key);
  const match = (resp.data ?? []).find((p) => p.key.toUpperCase() === key.toUpperCase());
  if (!match) {
    throw new ApiError(`Project ${key} not found, or QMetry is not enabled for it`, 404);
  }
  return { id: match.id, key: match.key, name: match.name };
}

async function listFolders(projectId: number, type: FolderType): Promise<FlatFolder[]> {
  const roots = await qtm.folders.tree(projectId, type);
  const out: FlatFolder[] = [];
  const walk = (nodes: FolderNode[], parentId: number | null, prefix: string) => {
    for (const n of nodes) {
      const path = prefix ? `${prefix}/${n.name}` : n.name;
      out.push({ id: n.id, name: n.name, parentId, path });
      walk(n.children ?? [], n.id, path);
    }
  };
  walk(roots, null, "");
  return out;
}

// ---------------------------------------------------------------------------
// CSV (the format defined by the test-case-design skill)

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface Step {
  description: string;
  testData: string;
  expectedResult: string;
}

interface CsvCase {
  id: string;
  name: string;
  objective: string;
  precondition: string;
  priority: string;
  coverage: string;
  covers: string;
  technique: string;
  level: string;
  steps: Step[];
}

export function splitNumbered(caseId: string, column: string, cell: string): string[] {
  const lines = cell.split(/\r?\n/);
  return lines.map((line, i) => {
    const prefix = `${i + 1}. `;
    if (!line.startsWith(prefix)) {
      throw new Error(`${caseId}: line ${i + 1} of "${column}" does not start with "${prefix}"`);
    }
    return line.slice(prefix.length);
  });
}

function csvPath(ticket: string): string {
  return join(REPO_ROOT, "docs", "test-cases", `${ticket.toLowerCase()}-test-cases.csv`);
}

function loadCsv(ticket: string): { cases: CsvCase[]; sha256: string; file: string } {
  const file = csvPath(ticket);
  if (!existsSync(file)) throw new Error(`CSV not found: ${file}. Run /test-craft ${ticket} first.`);
  const buf = readFileSync(file);
  const rows = parseCsv(buf.toString("utf8")).filter((r) => !(r.length === 1 && r[0] === ""));
  const [header, ...body] = rows;
  if (!header || header.join(",") !== CSV_HEADER.join(",")) {
    throw new Error(`CSV header does not match the test-case-design standard. Expected: ${CSV_HEADER.join(",")}`);
  }
  const col = (name: string) => CSV_HEADER.indexOf(name);
  const seen = new Set<string>();
  const cases: CsvCase[] = body.map((r, idx) => {
    if (r.length !== CSV_HEADER.length) throw new Error(`CSV row ${idx + 2} has ${r.length} columns, expected ${CSV_HEADER.length}`);
    const id = r[col("ID")].trim();
    if (!id) throw new Error(`CSV row ${idx + 2} has no ID`);
    if (seen.has(id)) throw new Error(`${id} appears on more than one row`);
    seen.add(id);
    for (const req of ["Name", "Priority", "Coverage"]) {
      if (!r[col(req)].trim()) throw new Error(`${id} has no ${req}`);
    }
    const s = splitNumbered(id, "Steps", r[col("Steps")]);
    const d = splitNumbered(id, "Step Test Data", r[col("Step Test Data")]);
    const e = splitNumbered(id, "Step Expected Results", r[col("Step Expected Results")]);
    if (s.length !== d.length || s.length !== e.length) {
      throw new Error(`${id}: step cells have different line counts (Steps ${s.length}, Step Test Data ${d.length}, Step Expected Results ${e.length})`);
    }
    e.forEach((x, i) => {
      if (x.trim() === "None" || !x.trim()) throw new Error(`${id}: expected result for step ${i + 1} is empty or None`);
    });
    return {
      id,
      name: r[col("Name")].trim(),
      objective: r[col("Objective")],
      precondition: r[col("Precondition")],
      priority: r[col("Priority")].trim(),
      coverage: r[col("Coverage")].trim(),
      covers: r[col("Covers")].trim(),
      technique: r[col("Technique")].trim(),
      level: r[col("Level")].trim(),
      steps: s.map((x, i) => ({ description: x, testData: d[i].trim() === "None" ? "" : d[i], expectedResult: e[i] })),
    };
  });
  if (!cases.length) throw new Error("CSV has no test cases");
  const wrongCoverage = cases.filter((c) => c.coverage.toUpperCase() !== ticket.toUpperCase());
  if (wrongCoverage.length) {
    throw new Error(`Coverage is not ${ticket} for: ${wrongCoverage.map((c) => c.id).join(", ")}`);
  }
  return { cases, sha256: createHash("sha256").update(buf).digest("hex"), file };
}

function caseSummary(c: CsvCase): string {
  return `${c.id} ${c.name}`.slice(0, 255);
}

function caseDescription(c: CsvCase, ticket: string): string {
  const covers = c.covers ? `\n\nCovers: ${c.covers} (${ticket.toLowerCase()}-rtm.csv)` : "";
  return (c.objective + covers).trim();
}

export function caseLabels(c: CsvCase): string[] {
  const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = c.id.replace(/-\d+$/, "").toLowerCase();
  return [c.coverage.toUpperCase(), prefix, c.technique && `technique-${slug(c.technique)}`, c.level && `level-${slug(c.level)}`]
    .filter((x): x is string => Boolean(x));
}

export interface LintResult {
  ok: boolean;
  cases: number;
  requirements: number;
  steps: number;
  /** Breaks the test-case-design standard; a push refuses to run until fixed. */
  problems: string[];
  /** Worth a reviewer's look, but not blocking. */
  warnings: string[];
}

/**
 * Machine checks for the review checklist items that can be decided from the files alone (C, F, T5,
 * D1, H3, parts of W4). The judgement items (coverage depth, technique choice, honesty) stay with the
 * agent and the human reviewer. Pure function so it can be tested without files or a network.
 */
export function lintDraft(ticket: string, casesText: string, rtmText: string | null): LintResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const clean = (rows: string[][]) => rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const result = (cases: number, requirements: number, steps: number): LintResult =>
    ({ ok: problems.length === 0, cases, requirements, steps, problems, warnings });

  let caseRows: string[][];
  try {
    caseRows = clean(parseCsv(casesText));
  } catch (err) {
    problems.push(`Test case CSV does not parse: ${(err as Error).message}`);
    return result(0, 0, 0);
  }
  const [header, ...body] = caseRows;
  if (!header || header.join(",") !== CSV_HEADER.join(",")) {
    problems.push(`C2: test case header is not the standard one. Expected: ${CSV_HEADER.join(",")}`);
    return result(0, 0, 0);
  }
  if (!body.length) problems.push("C4: test case CSV has no rows");
  const col = (row: string[], name: string) => (row[CSV_HEADER.indexOf(name)] ?? "");

  // RTM first, so case Covers values can be checked against it.
  const reqIds = new Set<string>();
  const coveredBy = new Map<string, string[]>();
  if (rtmText === null) {
    problems.push(`C1: ${ticket.toLowerCase()}-rtm.csv is missing`);
  } else {
    try {
      const [rtmHeader, ...rtmBody] = clean(parseCsv(rtmText));
      if (!rtmHeader || rtmHeader.join(",") !== RTM_HEADER.join(",")) {
        problems.push(`C2: RTM header is not the standard one. Expected: ${RTM_HEADER.join(",")}`);
      } else {
        rtmBody.forEach((r, i) => {
          const [id, text, type, source, covered] = r.map((x) => x.trim());
          const where = `RTM row ${i + 2}`;
          if (r.length !== RTM_HEADER.length) problems.push(`${where} has ${r.length} columns, expected ${RTM_HEADER.length}`);
          if (!/^R\d+$/.test(id ?? "")) problems.push(`${where}: Requirement ID "${id}" is not R1, R2, ...`);
          else if (reqIds.has(id)) problems.push(`${where}: ${id} appears twice`);
          reqIds.add(id);
          if (!text) problems.push(`${where} (${id}): Requirement is empty`);
          // "Non-functional (security)" is allowed: the standard names the kinds in brackets.
          if (!/^(Functional|Technical|Non-functional( \([^)]+\))?)$/.test(type ?? "")) problems.push(`T3: ${id} Type "${type}" is not Functional, Non-functional or Technical`);
          if (!source) problems.push(`T3: ${id} has no Source`);
          const ids = (covered ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          if (!ids.length) warnings.push(`T4: ${id} is not covered by any case; it must be listed under Gaps Flagged`);
          coveredBy.set(id, ids);
        });
      }
    } catch (err) {
      problems.push(`RTM CSV does not parse: ${(err as Error).message}`);
    }
  }

  const seen = new Set<string>();
  const covers = new Map<string, string[]>();
  const sequences = new Map<string, number[]>();
  let steps = 0;
  body.forEach((r, idx) => {
    const id = col(r, "ID").trim() || `row ${idx + 2}`;
    if (r.length !== CSV_HEADER.length) {
      problems.push(`C4: ${id} has ${r.length} columns, expected ${CSV_HEADER.length}`);
      return;
    }
    const m = /^TC-([A-Z0-9]+)-(\d{2,})$/.exec(id);
    if (!m) problems.push(`F1: "${id}" is not TC-<PREFIX>-<nn>`);
    else if (!PREFIXES.includes(m[1])) problems.push(`F1: ${id} uses an unknown prefix TC-${m[1]}`);
    else sequences.set(m[1], [...(sequences.get(m[1]) ?? []), Number(m[2])]);
    if (seen.has(id)) problems.push(`F1: ${id} appears on more than one row`);
    seen.add(id);

    const name = col(r, "Name").trim();
    if (!name) problems.push(`F2: ${id} has no Name`);
    else if (`${id} ${name}`.length > 255) problems.push(`F2: "${id} ${name.slice(0, 40)}..." is longer than 255 characters`);
    if (!col(r, "Objective").trim()) problems.push(`F5: ${id} has no Objective`);
    if (!col(r, "Precondition").trim()) problems.push(`F5: ${id} has no Precondition (write "None" if there is none)`);
    if (!CSV_PRIORITIES.includes(col(r, "Priority").trim())) problems.push(`F9: ${id} Priority "${col(r, "Priority")}" is not High, Normal or Low`);
    if (col(r, "Status").trim() !== "Draft") problems.push(`F10: ${id} Status is "${col(r, "Status")}", must be Draft`);
    if (col(r, "Owner").trim()) problems.push(`F10: ${id} Owner must be empty`);
    if (col(r, "Coverage").trim().toUpperCase() !== ticket.toUpperCase()) problems.push(`F10: ${id} Coverage is "${col(r, "Coverage")}", expected ${ticket.toUpperCase()}`);
    if (!TECHNIQUES.includes(col(r, "Technique").trim())) problems.push(`D1: ${id} Technique "${col(r, "Technique")}" is not one of the six in the standard`);
    if (!LEVELS.includes(col(r, "Level").trim())) problems.push(`F4: ${id} Level "${col(r, "Level")}" is not ${LEVELS.join(", ")}`);

    const caseCovers = col(r, "Covers").split(",").map((x) => x.trim()).filter(Boolean);
    if (!caseCovers.length) problems.push(`F3: ${id} Covers no requirement`);
    covers.set(id, caseCovers);

    try {
      const s = splitNumbered(id, "Steps", col(r, "Steps"));
      const d = splitNumbered(id, "Step Test Data", col(r, "Step Test Data"));
      const e = splitNumbered(id, "Step Expected Results", col(r, "Step Expected Results"));
      steps += s.length;
      if (s.length !== d.length || s.length !== e.length) {
        problems.push(`F7: ${id} step cells have different line counts (${s.length}, ${d.length}, ${e.length})`);
      }
      s.forEach((x, i) => { if (!x.trim()) problems.push(`F7: ${id} step ${i + 1} is empty`); });
      d.forEach((x, i) => { if (!x.trim()) problems.push(`F6: ${id} test data for step ${i + 1} is empty (write None)`); });
      e.forEach((x, i) => { if (!x.trim() || x.trim() === "None") problems.push(`F8: ${id} expected result for step ${i + 1} is empty or None`); });
    } catch (err) {
      problems.push(`F7: ${(err as Error).message}`);
    }

    const text = CSV_HEADER.map((h) => col(r, h)).join("\n");
    for (const url of text.match(/https?:\/\/[^\s"',)]+/g) ?? []) {
      problems.push(`H3: ${id} contains a real URL (${url}); use {{baseUrl}} and a path`);
    }
    if (/\bBearer\s+(?!\{\{)[A-Za-z0-9._~+/-]{16,}/.test(text) || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) {
      problems.push(`H3: ${id} appears to contain a real credential; use {{authToken}}`);
    }
    if (/[–—]/.test(text)) warnings.push(`W4: ${id} uses an en or em dash`);
  });

  for (const [prefix, nums] of sequences) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted.some((n, i) => n !== i + 1)) warnings.push(`F1: TC-${prefix} sequence is ${sorted.join(", ")}, expected to run 01, 02, ... without gaps`);
  }

  if (rtmText !== null && reqIds.size) {
    for (const [id, reqs] of covers) {
      for (const req of reqs) if (!reqIds.has(req)) problems.push(`T5: ${id} Covers ${req}, which is not in the RTM`);
    }
    for (const [req, ids] of coveredBy) {
      for (const id of ids) {
        if (!seen.has(id)) problems.push(`T5: RTM ${req} is Covered By ${id}, which is not in the test case file`);
        else if (!(covers.get(id) ?? []).includes(req)) warnings.push(`T5: RTM ${req} lists ${id}, but ${id} does not list ${req} in Covers`);
      }
    }
  }

  return result(body.length, reqIds.size, steps);
}

function rtmPath(ticket: string): string {
  return join(REPO_ROOT, "docs", "test-cases", `${ticket.toLowerCase()}-rtm.csv`);
}

function lintFiles(ticket: string): LintResult {
  const file = csvPath(ticket);
  if (!existsSync(file)) throw new Error(`CSV not found: ${file}. Run /test-craft ${ticket} first.`);
  const rtm = rtmPath(ticket);
  return lintDraft(ticket, readFileSync(file, "utf8"), existsSync(rtm) ? readFileSync(rtm, "utf8") : null);
}

// ---------------------------------------------------------------------------
// Push log

interface PushLog {
  tool: "qmetry";
  ticket: string;
  issueId: number;
  projectKey: string;
  projectId: number;
  csvFile: string;
  csvSha256: string;
  reviewer: string;
  pushedBy: string;
  name: string;
  startedAt: string;
  completedAt: string | null;
  state: "in_progress" | "complete" | "rolled_back";
  mainFolder: { id: number; path: string };
  subfolder: { id: number; name: string } | null;
  // aiGenerated is absent from logs written before it existed; those pushes did not set it.
  mapping: { priority: Record<string, string>; caseStatus: string | null; labels: boolean; aiGenerated?: boolean };
  labels: Record<string, { id: number; created: boolean }>;
  testCases: Record<string, { id: string; key: string; versionNo: number; summary: string }>;
  requirementLinked: boolean;
  testCycle: { id: string; key: string; summary: string; linkedCases: number; requirementLinked: boolean } | null;
  testPlan: { id: string; key: string; summary: string; created: boolean } | null;
  planRequest: { mode: "existing" | "new" | "none"; value: string | null };
  planLinked: boolean | "none";
  pending: { type: string; name: string } | null;
  failures: { step: string; csvId: string | null; error: string; at: string }[];
  verification?: unknown;
  rollback?: unknown;
}

function logPath(ticket: string): string {
  return join(REPO_ROOT, "docs", "test-cases", `${ticket.toLowerCase()}-qmetry-push.json`);
}

function readLog(ticket: string): PushLog | null {
  const p = logPath(ticket);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PushLog) : null;
}

function writeLog(log: PushLog): void {
  const p = logPath(log.ticket);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(log, null, 2) + "\n");
  renameSync(tmp, p);
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// ---------------------------------------------------------------------------
// Commands: read-only

async function check(): Promise<void> {
  const resp = await qtm.projects.search("", 0, 1);
  console.log(JSON.stringify({ ok: true, qmetryProjects: resp.total ?? null }));
}

/** QMetry-enabled projects the key can see, for choosing qmetry.projectKey. */
async function projects(): Promise<void> {
  const out: { id: number; key: string; name: string }[] = [];
  for (let startAt = 0; ; startAt += SEARCH_PAGE) {
    const resp = await qtm.projects.search("", startAt, SEARCH_PAGE);
    const data = resp.data ?? [];
    out.push(...data.filter((p) => p.qmetryEnabled !== false).map((p) => ({ id: p.id, key: p.key, name: p.name })));
    if (data.length < SEARCH_PAGE || startAt + data.length >= (resp.total ?? 0)) break;
  }
  console.log(JSON.stringify(out, null, 2));
}

async function project(key: string): Promise<void> {
  console.log(JSON.stringify(await projectByKey(key), null, 2));
}

async function meta(key: string): Promise<void> {
  const p = await projectByKey(key);
  const [priorities, testCaseStatuses, testCycleStatuses, testPlanStatuses, labels] = await Promise.all([
    qtm.projects.priorities(p.id),
    qtm.projects.testCaseStatuses(p.id),
    qtm.projects.testCycleStatuses(p.id),
    qtm.projects.testPlanStatuses(p.id),
    qtm.labels.list(p.id),
  ]);
  const slim = (xs: Named[]) => xs.map((x) => ({ id: x.id, name: x.name, archived: x.isArchive ?? false }));
  console.log(JSON.stringify({
    project: p,
    priorities: slim(priorities),
    testCaseStatuses: slim(testCaseStatuses),
    testCycleStatuses: slim(testCycleStatuses),
    testPlanStatuses: slim(testPlanStatuses),
    labelCount: labels.length,
  }, null, 2));
}

async function folders(key: string, type: FolderType): Promise<void> {
  const p = await projectByKey(key);
  const list = await listFolders(p.id, type);
  list.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  console.log(JSON.stringify(list, null, 2));
}

async function createFolder(key: string, name: string, parentId: number, type: FolderType): Promise<void> {
  if (/[\\/]/.test(name)) throw new Error("Folder name must not contain / or \\");
  const p = await projectByKey(key);
  const existing = (await listFolders(p.id, type)).find(
    (f) => (parentId === -1 ? f.parentId === null : f.parentId === parentId) && f.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    console.log(JSON.stringify({ created: false, alreadyExists: true, ...existing }));
    return;
  }
  const resp = await qtm.folders.create(p.id, type, name, parentId);
  console.log(JSON.stringify({ created: true, id: resp.id, name: resp.name ?? name, parentId }));
}

async function plans(key: string): Promise<void> {
  const p = await projectByKey(key);
  const list = await qtm.testPlans.searchAll({ projectId: p.id });
  console.log(JSON.stringify(list.map((x) => ({ id: x.id, key: x.key, summary: x.summary, status: x.status?.name ?? null })), null, 2));
}

async function validate(ticket: string): Promise<void> {
  const lint = lintFiles(ticket);
  // loadCsv is the parser the push uses, so a file that lints clean but fails here still can't be pushed.
  let parsed: { sha256: string; file: string; priorities: string[] } | null = null;
  try {
    const { cases, sha256, file } = loadCsv(ticket);
    parsed = { sha256, file: file.slice(REPO_ROOT.length + 1), priorities: [...new Set(cases.map((c) => c.priority))] };
  } catch (err) {
    if (!lint.problems.length) lint.problems.push((err as Error).message);
    lint.ok = false;
  }
  console.log(JSON.stringify({ ...lint, ...parsed }, null, 2));
  if (!lint.ok) process.exit(3);
}

interface SearchOptions {
  projectKey: string;
  text: string | null;
  label: string | null;
  issueId: number | null;
  folderId: number | null;
  limit: number;
}

/** Existing QMetry test cases, for the duplicate and regression checks. Read-only. */
async function searchTestCases(opts: SearchOptions): Promise<void> {
  const p = await projectByKey(opts.projectKey);
  const filter: TestCaseFilter = { projectId: p.id };
  // The spec searches key and summary by default and doesn't list other searchInFields values.
  if (opts.text) filter.searchText = opts.text;
  if (opts.issueId !== null) filter.requirementIds = [opts.issueId];
  if (opts.folderId !== null) {
    filter.folderId = opts.folderId;
    filter.withChild = true;
  }
  if (opts.label) {
    const hit = byName(await qtm.labels.list(p.id), opts.label);
    if (!hit) {
      console.log(JSON.stringify({ project: p.key, total: 0, returned: 0, testCases: [], note: `No label named "${opts.label}" in ${p.key}` }, null, 2));
      return;
    }
    filter.labels = [hit.id];
  }
  const out: TestCaseSummary[] = [];
  let total = 0;
  for (let startAt = 0; out.length < opts.limit; startAt += SEARCH_PAGE) {
    const resp = await qtm.testCases.search(filter, startAt, Math.min(SEARCH_PAGE, opts.limit - out.length));
    const data = resp.data ?? [];
    total = resp.total ?? data.length;
    out.push(...data);
    if (!data.length || out.length >= total) break;
  }
  console.log(JSON.stringify({
    project: p.key,
    total,
    returned: out.length,
    testCases: out.map((t) => ({
      key: t.key,
      summary: t.summary,
      version: t.version?.versionNo ?? null,
      folder: t.folder?.name ?? null,
      status: t.status?.name ?? null,
      priority: t.priority?.name ?? null,
      labels: (t.labels ?? []).map((l) => l.name),
      archived: t.archived ?? false,
    })),
  }, null, 2));
}

/** One test case with its steps, so an existing case can be compared with a draft. Read-only. */
async function getTestCase(key: string, versionNo: number | null): Promise<void> {
  // A test case key carries its project: PROJ-TC-3 is in PROJ.
  const p = await projectByKey(key.replace(/-TC-\d+$/, ""));
  const hit = (await qtm.testCases.search({ projectId: p.id, key }, 0, 1)).data?.find((t) => t.key.toUpperCase() === key.toUpperCase());
  if (!hit) throw new ApiError(`Test case ${key} not found in ${p.key}`, 404);
  const version = versionNo ?? hit.version?.versionNo ?? 1;
  const tc = await qtm.testCases.getVersion(hit.id, version);
  const steps = await qtm.testCases.steps(hit.id, version);
  const name = (v: unknown) => (v && typeof v === "object" && "name" in v ? (v as { name: string }).name : v ?? null);
  console.log(JSON.stringify({
    key: tc.key ?? key,
    version,
    summary: tc.summary ?? null,
    description: tc.description ?? null,
    precondition: tc.precondition ?? null,
    status: name(tc.status),
    priority: name(tc.priority),
    folder: name(tc.folder),
    labels: Array.isArray(tc.labels) ? (tc.labels as unknown[]).map(name) : [],
    steps: steps.map((s, i) => ({ n: i + 1, step: s.stepDetails ?? "", testData: s.testData ?? "", expected: s.expectedResult ?? "" })),
  }, null, 2));
}

// ---------------------------------------------------------------------------
// push

interface PushOptions {
  ticket: string;
  projectKey: string | null;
  issueId: number;
  reviewer: string;
  name: string;
  folderPath: string | null;
  folderId: number | null;
  plan: { mode: "existing" | "new" | "none"; value: string | null };
  priorityMap: Record<string, string>;
  caseStatus: string | null;
  labels: boolean;
  aiGenerated: boolean;
  allowExisting: boolean;
  confirm: boolean;
}

function parsePriorityMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [from, to] = pair.split("=").map((s) => s.trim());
    if (!from || !to) throw new Error(`--priority-map entry "${pair}" must look like CsvName=QMetryName`);
    map[from] = to;
  }
  return map;
}

const byName = (xs: Named[], name: string) =>
  xs.find((x) => x.name.toLowerCase() === name.toLowerCase() && !x.isArchive) ?? xs.find((x) => x.name.toLowerCase() === name.toLowerCase());

async function push(opts: PushOptions): Promise<void> {
  const ticket = opts.ticket.toUpperCase();
  const existingLog = readLog(ticket);
  // --project wins, then a configured project key, then the ticket's own prefix.
  const projectKey = (existingLog?.projectKey ?? opts.projectKey ?? (CONFIG_UNSET("qmetry.projectKey") ? null : CONFIG.qmetry.projectKey) ?? ticket.replace(/-\d+$/, "")).toUpperCase();
  const { cases, sha256, file } = loadCsv(ticket);

  // ---- Log state: new push, resume, or stop.
  if (existingLog?.state === "complete") {
    fail(`Already pushed: ${logPath(ticket)} is complete. Cases: ${Object.values(existingLog.testCases).map((c) => c.key).join(", ")}`, 3);
  }
  if (existingLog?.state === "rolled_back") {
    fail(`${logPath(ticket)} records a rollback. Move or delete that log before pushing again.`, 3);
  }
  if (existingLog && existingLog.csvSha256 !== sha256) {
    fail(`The CSV changed after this push started (log sha ${existingLog.csvSha256}, now ${sha256}). Decide with the user before resuming.`, 3);
  }
  const resuming = Boolean(existingLog);

  // ---- Pre-push checks (read-only).
  const proj = await projectByKey(projectKey);
  const [priorities, caseStatuses, allLabels, tcFolders] = await Promise.all([
    qtm.projects.priorities(proj.id),
    qtm.projects.testCaseStatuses(proj.id),
    (resuming ? existingLog!.mapping.labels : opts.labels) ? qtm.labels.list(proj.id) : Promise.resolve([] as Named[]),
    listFolders(proj.id, "testcase"),
  ]);

  const problems: string[] = [];
  let existingCases: { total: number; keys: string[] } | null = null;
  if (!resuming) {
    // The same machine checks the agent and reviewers run, so a CSV that breaks the standard can't reach QMetry.
    problems.push(...lintFiles(ticket).problems.map((p) => `CSV standard: ${p}`));

    // The push log only guards the machine it lives on. QMetry itself is the shared record, so a
    // ticket that already has linked cases is stopped here, whoever pushed them.
    const linked = await qtm.testCases.search({ projectId: proj.id, requirementIds: [opts.issueId] }, 0, 20);
    existingCases = { total: linked.total ?? (linked.data ?? []).length, keys: (linked.data ?? []).map((t) => t.key) };
    if (existingCases.total > 0 && !opts.allowExisting) {
      problems.push(`${ticket} already has ${existingCases.total} test case(s) linked in QMetry (${existingCases.keys.join(", ")}). Another push may have happened elsewhere. Check them, then pass --allow-existing only if adding to them is intended.`);
    }
  }
  const priorityMap = resuming ? existingLog!.mapping.priority : opts.priorityMap;
  const priorityIds: Record<string, number> = {};
  for (const csvName of new Set(cases.map((c) => c.priority))) {
    const target = priorityMap[csvName] ?? csvName;
    const found = byName(priorities, target);
    if (found) priorityIds[csvName] = found.id;
    else problems.push(`Priority "${target}" (CSV "${csvName}") not in QMetry. Available: ${priorities.filter((p) => !p.isArchive).map((p) => p.name).join(", ")}. Use --priority-map ${csvName}=<name>.`);
  }

  const caseStatusName = resuming ? existingLog!.mapping.caseStatus : opts.caseStatus;
  let caseStatusId: number | undefined;
  if (caseStatusName) {
    const found = byName(caseStatuses, caseStatusName);
    if (found) caseStatusId = found.id;
    else problems.push(`Test case status "${caseStatusName}" not in QMetry. Available: ${caseStatuses.filter((s) => !s.isArchive).map((s) => s.name).join(", ")}.`);
  }

  let mainFolder: FlatFolder | undefined;
  if (resuming) {
    mainFolder = tcFolders.find((f) => f.id === existingLog!.mainFolder.id);
  } else if (opts.folderId !== null) {
    mainFolder = tcFolders.find((f) => f.id === opts.folderId);
  } else if (opts.folderPath) {
    const want = opts.folderPath.replace(/^\/+|\/+$/g, "").toLowerCase();
    const matches = tcFolders.filter((f) => f.path.toLowerCase() === want || f.name.toLowerCase() === want);
    if (matches.length > 1) problems.push(`Folder "${opts.folderPath}" matches several folders: ${matches.map((m) => `${m.path} (${m.id})`).join("; ")}. Use --folder-id.`);
    mainFolder = matches.length === 1 ? matches[0] : undefined;
  }
  if (!mainFolder && !problems.some((p) => p.startsWith("Folder"))) {
    problems.push(`Main test case folder not found (${opts.folderId ?? opts.folderPath ?? existingLog?.mainFolder.path}). Create it first with create-folder.`);
  }

  const planReq = resuming ? existingLog!.planRequest : opts.plan;
  let existingPlan: { id: string; key: string; summary: string } | undefined;
  if (planReq.mode !== "none") {
    const allPlans = await qtm.testPlans.searchAll({ projectId: proj.id });
    if (planReq.mode === "existing") {
      existingPlan = allPlans.find((p) => p.key.toUpperCase() === (planReq.value ?? "").toUpperCase());
      if (!existingPlan) problems.push(`Test plan ${planReq.value} not found in ${projectKey}.`);
    } else if (!resuming && allPlans.some((p) => p.summary.toLowerCase() === (planReq.value ?? "").toLowerCase())) {
      problems.push(`A test plan named "${planReq.value}" already exists (${allPlans.find((p) => p.summary.toLowerCase() === (planReq.value ?? "").toLowerCase())!.key}). Use --plan <key> instead.`);
    }
  }

  const subfolderName = resuming ? existingLog!.name : opts.name;
  const existingSub = mainFolder
    ? tcFolders.find((f) => f.parentId === mainFolder!.id && f.name.toLowerCase() === subfolderName.toLowerCase())
    : undefined;
  if (existingSub && !(resuming && existingLog!.subfolder?.id === existingSub.id) && !(resuming && existingLog!.pending?.type === "subfolder")) {
    problems.push(`Folder "${mainFolder!.path}/${subfolderName}" already exists and this push did not create it. It may hold cases from an earlier push.`);
  }

  const useLabels = resuming ? existingLog!.mapping.labels : opts.labels;
  const labelNames = useLabels ? [...new Set(cases.flatMap(caseLabels))] : [];
  const labelsToCreate = labelNames.filter((n) => !allLabels.some((l) => l.name.toLowerCase() === n.toLowerCase()));

  const stepCount = cases.reduce((n, c) => n + c.steps.length, 0);
  const plan = {
    ticket,
    issueId: resuming ? existingLog!.issueId : opts.issueId,
    project: proj,
    csv: { file, sha256, cases: cases.length, steps: stepCount },
    reviewer: resuming ? existingLog!.reviewer : opts.reviewer,
    mainFolder: mainFolder ? { id: mainFolder.id, path: mainFolder.path } : null,
    subfolder: `${mainFolder?.path ?? "?"}/${subfolderName}`,
    testCycle: subfolderName,
    priorities: Object.fromEntries(Object.entries(priorityIds).map(([k, id]) => [k, `${priorityMap[k] ?? k} (${id})`])),
    caseStatus: caseStatusName ? `${caseStatusName} (${caseStatusId ?? "?"})` : "project default",
    labels: useLabels ? { total: labelNames.length, toCreate: labelsToCreate } : "off",
    testPlan: planReq.mode === "existing" ? `link to ${existingPlan?.key ?? planReq.value}` : planReq.mode === "new" ? `create "${planReq.value}" and link` : "none",
    aiGenerated: resuming ? existingLog!.mapping.aiGenerated ?? false : opts.aiGenerated,
    existingCasesInQmetry: existingCases,
    resuming,
    estimatedCalls: 1 + labelsToCreate.length + cases.length + 1 + 2 + (planReq.mode === "none" ? 0 : planReq.mode === "new" ? 2 : 1),
  };

  if (problems.length) {
    console.log(JSON.stringify({ ok: false, problems, plan }, null, 2));
    process.exit(3);
  }
  if (!opts.confirm) {
    console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
    return;
  }

  // ---- Push.
  const log: PushLog = existingLog ?? {
    tool: "qmetry",
    ticket,
    issueId: opts.issueId,
    projectKey,
    projectId: proj.id,
    csvFile: file.slice(REPO_ROOT.length + 1),
    csvSha256: sha256,
    reviewer: opts.reviewer,
    pushedBy: userInfo().username,
    name: opts.name,
    startedAt: now(),
    completedAt: null,
    state: "in_progress",
    mainFolder: { id: mainFolder!.id, path: mainFolder!.path },
    subfolder: null,
    mapping: { priority: opts.priorityMap, caseStatus: opts.caseStatus, labels: opts.labels, aiGenerated: opts.aiGenerated },
    labels: {},
    testCases: {},
    requirementLinked: false,
    testCycle: null,
    testPlan: null,
    planRequest: opts.plan,
    planLinked: opts.plan.mode === "none" ? "none" : false,
    pending: null,
    failures: [],
  };
  writeLog(log);

  const step = async <T>(name: string, csvId: string | null, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      log.failures.push({ step: name, csvId, error: (err as Error).message, at: now() });
      writeLog(log);
      fail(`${name}${csvId ? ` (${csvId})` : ""} failed: ${(err as Error).message}. Nothing after this was attempted. Re-run the same push command to resume.`);
    }
  };
  const setPending = (type: string, name: string) => {
    log.pending = { type, name };
    writeLog(log);
  };
  const clearPending = () => {
    log.pending = null;
    writeLog(log);
  };

  // 1. Subfolder.
  if (!log.subfolder) {
    const found = existingSub && (log.pending?.type === "subfolder" || resuming) ? existingSub : undefined;
    if (found) {
      log.subfolder = { id: found.id, name: found.name };
      clearPending();
    } else {
      setPending("subfolder", log.name);
      const created = await step("create subfolder", null, () =>
        qtm.folders.create(proj.id, "testcase", log.name, log.mainFolder.id));
      log.subfolder = { id: created.id, name: log.name };
      clearPending();
    }
    progress(`subfolder ${log.mainFolder.path}/${log.name} (${log.subfolder.id})`);
  }

  // 2. Labels.
  const labelIds: Record<string, number> = {};
  if (log.mapping.labels) {
    const current = await qtm.labels.list(proj.id);
    for (const name of labelNames) {
      const hit = current.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (hit) {
        labelIds[name] = hit.id;
        if (!log.labels[name]) log.labels[name] = { id: hit.id, created: log.pending?.type === "label" && log.pending.name === name };
        continue;
      }
      setPending("label", name);
      const created = await step("create label", null, () =>
        qtm.labels.create(proj.id, name));
      labelIds[name] = created.id;
      log.labels[name] = { id: created.id, created: true };
      clearPending();
    }
    if (log.pending?.type === "label") clearPending();
    writeLog(log);
  }

  // 3. Test cases, each created with its steps, folder, priority, status, and labels in one call.
  for (const c of cases) {
    if (log.testCases[c.id]) continue;
    const summary = caseSummary(c);
    if (log.pending?.type === "testcase" && log.pending.name === c.id) {
      const found = (await qtm.testCases.searchAll({ projectId: proj.id, folderId: log.subfolder!.id, summary }))
        .find((t) => t.summary === summary);
      if (found) {
        log.testCases[c.id] = { id: found.id, key: found.key, versionNo: found.version?.versionNo ?? 1, summary };
        clearPending();
        progress(`${c.id} -> ${found.key} (found after interrupted create)`);
        continue;
      }
    }
    setPending("testcase", c.id);
    const body: CreateTestCase = {
      projectId: proj.id,
      folderId: log.subfolder!.id,
      summary,
      description: caseDescription(c, ticket),
      precondition: c.precondition,
      priority: priorityIds[c.priority],
      steps: c.steps.map((s) => ({ stepDetails: s.description, expectedResult: s.expectedResult, ...(s.testData ? { testData: s.testData } : {}) })),
    };
    if (caseStatusId !== undefined) body.status = caseStatusId;
    // QMetry's own provenance flag, so AI-drafted cases can be filtered and reported on in QMetry.
    if (log.mapping.aiGenerated) body.aiGenerated = true;
    if (log.mapping.labels) body.labels = caseLabels(c).map((n) => labelIds[n]).filter((x): x is number => x !== undefined);
    const created = await step("create test case", c.id, () =>
      qtm.testCases.create(body));
    log.testCases[c.id] = { id: created.id, key: created.key, versionNo: created.versionNo ?? 1, summary };
    clearPending();
    progress(`${c.id} -> ${created.key} (${c.steps.length} steps)`);
  }
  const caseRefs = cases.map((c) => ({ id: log.testCases[c.id].id, versionNo: log.testCases[c.id].versionNo }));

  // 4. Link every case to the Jira ticket in one call.
  if (!log.requirementLinked) {
    await step("link test cases to Jira issue", null, () =>
      qtm.requirements.linkTestCases(log.issueId, caseRefs));
    log.requirementLinked = true;
    writeLog(log);
    progress(`linked ${caseRefs.length} test cases to ${ticket}`);
  }

  // 5. Test cycle, created with all cases linked (one execution each).
  if (!log.testCycle) {
    let cycle: { id: string; key: string } | undefined;
    if (log.pending?.type === "testcycle") {
      cycle = (await qtm.testCycles.searchAll({ projectId: proj.id, summary: log.name }))
        .find((t) => t.summary === log.name);
    }
    if (!cycle) {
      setPending("testcycle", log.name);
      cycle = await step("create test cycle", null, () =>
        qtm.testCycles.create({
          projectId: proj.id,
          summary: log.name,
          description: `Test cases for ${ticket}. Reviewed by ${log.reviewer}.`,
          testCasesToLink: { testCases: caseRefs },
        }));
    }
    log.testCycle = { id: cycle.id, key: cycle.key, summary: log.name, linkedCases: 0, requirementLinked: false };
    clearPending();
    progress(`test cycle ${cycle.key}`);
  }
  const linked = await step("count cycle test cases", null, () =>
    qtm.testCycles.testCases(log.testCycle!.id));
  if (linked.length < caseRefs.length) {
    const have = new Set(linked.map((x) => x.id));
    const missing = caseRefs.filter((r) => !have.has(r.id));
    await step("link test cases to test cycle", null, () =>
      qtm.testCycles.linkTestCases(log.testCycle!.id, missing));
  }
  log.testCycle.linkedCases = caseRefs.length;
  writeLog(log);

  // 6. Link the cycle to the Jira ticket.
  if (!log.testCycle.requirementLinked) {
    await step("link test cycle to Jira issue", null, () =>
      qtm.testCycles.linkRequirements(log.testCycle!.id, [log.issueId]));
    log.testCycle.requirementLinked = true;
    writeLog(log);
  }

  // 7. Test plan.
  if (log.planRequest.mode !== "none" && log.planLinked !== true) {
    if (!log.testPlan) {
      if (log.planRequest.mode === "existing") {
        log.testPlan = { id: existingPlan!.id, key: existingPlan!.key, summary: existingPlan!.summary, created: false };
      } else {
        const summary = log.planRequest.value!;
        let planHit: { id: string; key: string } | undefined;
        if (log.pending?.type === "testplan") {
          planHit = (await qtm.testPlans.searchAll({ projectId: proj.id, summary }))
            .find((t) => t.summary === summary);
        }
        if (!planHit) {
          setPending("testplan", summary);
          planHit = await step("create test plan", null, () =>
            qtm.testPlans.create({ projectId: proj.id, summary }));
        }
        log.testPlan = { id: planHit.id, key: planHit.key, summary, created: true };
        clearPending();
      }
      writeLog(log);
    }
    await step("link test cycle to test plan", null, () =>
      qtm.testPlans.linkTestCycles(log.testPlan!.id, [log.testCycle!.id]));
    log.planLinked = true;
    writeLog(log);
    progress(`test cycle added to plan ${log.testPlan.key}`);
  }

  // 8. Verify, then mark complete.
  const verification = await verifyLog(log);
  log.verification = verification;
  if (verification.ok) {
    log.state = "complete";
    log.completedAt = now();
  }
  writeLog(log);
  console.log(JSON.stringify({ ok: verification.ok, log: logPath(ticket).slice(REPO_ROOT.length + 1), summary: summarize(log), verification }, null, 2));
  if (!verification.ok) process.exit(1);
}

function summarize(log: PushLog) {
  return {
    ticket: log.ticket,
    reviewer: log.reviewer,
    folder: `${log.mainFolder.path}/${log.subfolder?.name ?? "?"}`,
    testCases: Object.fromEntries(Object.entries(log.testCases).map(([k, v]) => [k, v.key])),
    testCycle: log.testCycle?.key ?? null,
    testPlan: log.testPlan?.key ?? null,
    planLinked: log.planLinked,
    labelsCreated: Object.entries(log.labels).filter(([, v]) => v.created).map(([k]) => k),
    failures: log.failures,
  };
}

async function verifyLog(log: PushLog) {
  const issues: string[] = [];
  const { cases } = loadCsv(log.ticket);
  const inFolder = await qtm.testCases.searchAll({ projectId: log.projectId, folderId: log.subfolder!.id });
  const logged = new Set(Object.values(log.testCases).map((t) => t.id));
  const found = new Set(inFolder.map((t) => t.id));
  for (const id of logged) if (!found.has(id)) issues.push(`Logged test case ${id} not found in the subfolder`);
  for (const t of inFolder) if (!logged.has(t.id)) issues.push(`Subfolder holds ${t.key}, which this push did not log`);

  for (const c of cases) {
    const t = log.testCases[c.id];
    if (!t) {
      issues.push(`${c.id} was not created`);
      continue;
    }
    const steps = await qtm.testCases.steps(t.id, t.versionNo);
    if (steps.length !== c.steps.length) issues.push(`${c.id} (${t.key}) has ${steps.length} steps in QMetry, CSV has ${c.steps.length}`);
  }

  let cycleCases = 0;
  if (log.testCycle) {
    cycleCases = (await qtm.testCycles.testCases(log.testCycle.id)).length;
    if (cycleCases !== cases.length) issues.push(`Test cycle ${log.testCycle.key} has ${cycleCases} test cases, expected ${cases.length}`);
  } else {
    issues.push("No test cycle logged");
  }

  let requirementCases: number | null = null;
  try {
    const linkedToIssue = await qtm.testCases.searchAll({ projectId: log.projectId, requirementIds: [log.issueId], folderId: log.subfolder!.id });
    requirementCases = linkedToIssue.length;
    if (requirementCases !== cases.length) issues.push(`${requirementCases} of ${cases.length} test cases are linked to ${log.ticket}`);
  } catch (err) {
    issues.push(`Could not check links to ${log.ticket}: ${(err as Error).message}`);
  }

  return { ok: issues.length === 0, casesInFolder: inFolder.length, cycleCases, casesLinkedToIssue: requirementCases, issues };
}

async function verify(ticket: string): Promise<void> {
  const log = readLog(ticket.toUpperCase());
  if (!log) throw new Error(`No push log at ${logPath(ticket)}`);
  // verifyLog compares QMetry against the CSV on disk, so an edited CSV would report false problems.
  const { sha256 } = loadCsv(log.ticket);
  const csvChanged = sha256 !== log.csvSha256;
  const result = await verifyLog(log);
  console.log(JSON.stringify({
    summary: summarize(log),
    csv: csvChanged
      ? { changedSincePush: true, note: "The CSV was edited after the push, so differences below may be edits rather than push problems." }
      : { changedSincePush: false },
    verification: result,
  }, null, 2));
  if (!result.ok) process.exit(1);
}

// ---------------------------------------------------------------------------
// rollback: delete exactly what the push log says this push created.

async function rollback(ticket: string, confirm: boolean): Promise<void> {
  const log = readLog(ticket.toUpperCase());
  if (!log) throw new Error(`No push log at ${logPath(ticket)}`);
  if (log.state === "rolled_back") throw new Error("This push is already rolled back");

  const actions = [
    ...(log.testPlan?.created ? [`delete test plan ${log.testPlan.key}`] : log.testPlan && log.planLinked === true ? [`unlink test cycle from plan ${log.testPlan.key}`] : []),
    ...(log.testCycle ? [`delete test cycle ${log.testCycle.key}`] : []),
    ...Object.entries(log.testCases).map(([id, t]) => `delete test case ${t.key} (${id})`),
    ...(log.subfolder ? [`delete folder ${log.mainFolder.path}/${log.subfolder.name}`] : []),
  ];
  const keptLabels = Object.entries(log.labels).filter(([, v]) => v.created).map(([k]) => k);
  if (!confirm) {
    console.log(JSON.stringify({ dryRun: true, actions, labelsKept: keptLabels, note: "Labels are left in place; other test cases may use them." }, null, 2));
    return;
  }

  const done: string[] = [];
  const failed: string[] = [];
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      done.push(label);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) done.push(`${label} (already gone)`);
      else failed.push(`${label}: ${(err as Error).message}`);
    }
  };

  if (log.testPlan?.created) await attempt(`delete test plan ${log.testPlan.key}`, () => qtm.testPlans.delete(log.testPlan!.id));
  else if (log.testPlan && log.planLinked === true && log.testCycle) {
    await attempt(`unlink test cycle from plan ${log.testPlan.key}`, () =>
      qtm.testPlans.unlinkTestCycles(log.testPlan!.id, [log.testCycle!.id]));
  }
  if (log.testCycle) await attempt(`delete test cycle ${log.testCycle.key}`, () => qtm.testCycles.delete(log.testCycle!.id));
  for (const [id, t] of Object.entries(log.testCases)) {
    await attempt(`delete test case ${t.key} (${id})`, () => qtm.testCases.delete(t.id));
  }
  if (log.subfolder) {
    await attempt(`delete folder ${log.mainFolder.path}/${log.subfolder.name}`, () =>
      qtm.folders.delete(log.projectId, "testcase", log.subfolder!.id));
  }

  log.rollback = { at: now(), done, failed, labelsKept: keptLabels };
  if (!failed.length) log.state = "rolled_back";
  writeLog(log);
  console.log(JSON.stringify({ ok: failed.length === 0, done, failed, labelsKept: keptLabels }, null, 2));
  if (failed.length) process.exit(1);
}

// ---------------------------------------------------------------------------

/** Setup check for a new clone: config, token, API reachability, and the project's own values. */
async function doctor(): Promise<void> {
  const problems: string[] = [];
  const notes: string[] = [...CONFIG_WARNINGS];
  problems.push(...CONFIG_ERRORS);

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) problems.push(`Node ${process.versions.node} is too old; these scripts need 22.18 or newer`);

  const hasToken = Boolean((process.env.QTM_API_TOKEN ?? "").trim());
  if (!hasToken) problems.push("QTM_API_TOKEN is not set (copy .env.example to .env and add your QMetry Open API key)");
  if (!(process.env.QTM_AUTOMATION_API_KEY ?? "").trim()) {
    notes.push("QTM_AUTOMATION_API_KEY is not set; importing automated results falls back to QTM_API_TOKEN");
  }

  const out: Record<string, unknown> = {
    node: process.versions.node,
    config: { file: "qa.config.json", jiraSite: CONFIG.jira.site, jiraProject: CONFIG.jira.projectKey, qmetryProject: CONFIG.qmetry.projectKey, baseUrl: CONFIG.qmetry.baseUrl },
  };

  if (hasToken && !problems.length) {
    try {
      const proj = await projectByKey(CONFIG.qmetry.projectKey);
      const [priorities, statuses] = await Promise.all([
        qtm.projects.priorities(proj.id),
        qtm.projects.testCaseStatuses(proj.id),
      ]);
      const names = (xs: Named[]) => xs.filter((x) => !x.isArchive).map((x) => x.name);
      out.project = { id: proj.id, key: proj.key, name: proj.name };
      out.priorities = names(priorities);
      out.testCaseStatuses = names(statuses);
      for (const [csvName, target] of Object.entries(CONFIG.qmetry.priorityMap)) {
        if (!byName(priorities, target)) problems.push(`qa.config.json maps CSV priority "${csvName}" to "${target}", which ${proj.key} does not have. Available: ${names(priorities).join(", ")}`);
      }
      if (CONFIG.qmetry.caseStatus && !byName(statuses, CONFIG.qmetry.caseStatus)) {
        problems.push(`qa.config.json sets the test case status "${CONFIG.qmetry.caseStatus}", which ${proj.key} does not have. Available: ${names(statuses).join(", ")}`);
      }
      if (CONFIG.qmetry.mainFolder) {
        const want = CONFIG.qmetry.mainFolder.replace(/^\/+|\/+$/g, "").toLowerCase();
        const folders = await listFolders(proj.id, "testcase");
        const hits = folders.filter((f) => f.path.toLowerCase() === want || f.name.toLowerCase() === want);
        if (!hits.length) notes.push(`The configured main folder "${CONFIG.qmetry.mainFolder}" does not exist yet; create it with create-folder before the first push`);
        else if (hits.length > 1) notes.push(`The configured main folder "${CONFIG.qmetry.mainFolder}" matches ${hits.length} folders; a push will need --folder-id`);
      }
    } catch (err) {
      problems.push(`Could not reach QMetry: ${(err as Error).message}`);
    }
  }

  out.ok = problems.length === 0;
  out.problems = problems;
  out.notes = notes;
  console.log(JSON.stringify(out, null, 2));
  if (problems.length) process.exit(3);
}

const USAGE = `Usage:
  node scripts/qmetry-api.ts doctor
  node scripts/qmetry-api.ts check
  node scripts/qmetry-api.ts projects
  node scripts/qmetry-api.ts project [--project <KEY>]
  node scripts/qmetry-api.ts meta [--project <KEY>]
  node scripts/qmetry-api.ts folders [--project <KEY>] [--type testcase|testcycle|testplan]
  node scripts/qmetry-api.ts create-folder [--project <KEY>] --name <name> (--parent-id <id> | --root) [--type testcase|testcycle|testplan]
  node scripts/qmetry-api.ts plans [--project <KEY>]
  node scripts/qmetry-api.ts search-testcases [--project <KEY>] [--text <words>] [--label <name>] [--issue-id <numeric Jira id>] [--folder-id <id>] [--limit 50]
  node scripts/qmetry-api.ts testcase --key <PROJ-TC-3> [--version <n>]
  node scripts/qmetry-api.ts validate --ticket <KEY-123>
  node scripts/qmetry-api.ts push --ticket <KEY-123> --issue-id <numeric Jira id> --reviewer <name> --name <folder and cycle name>
       (--folder <path> | --folder-id <id>) (--plan <plan key> | --new-plan <summary> | --no-plan)
       [--project <KEY>] [--priority-map CsvName=QMetryName,...] [--case-status <name>] [--no-labels] [--allow-existing] [--confirm]
  node scripts/qmetry-api.ts verify --ticket <KEY-123>
  node scripts/qmetry-api.ts rollback --ticket <KEY-123> [--confirm]

Defaults for --project, --folder, --priority-map, --case-status and labels come from qa.config.json.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // A config that can't be trusted would silently fall back to defaults, so only doctor runs on one.
  // With no config file yet, the setup lookups still run; everything else waits for a usable config.
  if (CONFIG_ERRORS.length && command !== "doctor" && !(!CONFIG_EXISTS && SETUP_COMMANDS.includes(command))) {
    console.error(JSON.stringify({ error: "qa.config.json is not usable, so settings cannot be trusted", problems: CONFIG_ERRORS, fix: "Correct the file, or run: node scripts/qmetry-api.ts doctor" }));
    process.exit(2);
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        project: { type: "string" },
        type: { type: "string", default: "testcase" },
        name: { type: "string" },
        "parent-id": { type: "string" },
        root: { type: "boolean", default: false },
        ticket: { type: "string" },
        "issue-id": { type: "string" },
        reviewer: { type: "string" },
        folder: { type: "string" },
        "folder-id": { type: "string" },
        plan: { type: "string" },
        "new-plan": { type: "string" },
        "no-plan": { type: "boolean", default: false },
        "priority-map": { type: "string" },
        "case-status": { type: "string" },
        "no-labels": { type: "boolean", default: false },
        "allow-existing": { type: "boolean", default: false },
        text: { type: "string" },
        label: { type: "string" },
        key: { type: "string" },
        version: { type: "string" },
        limit: { type: "string", default: "50" },
        confirm: { type: "boolean", default: false },
      },
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n${USAGE}`);
  }
  const need = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || !value.trim()) fail(`--${name} is required\n${USAGE}`);
    return value.trim();
  };
  const intArg = (name: string): number => {
    const n = Number(need(name));
    if (!Number.isInteger(n)) fail(`--${name} must be a whole number`);
    return n;
  };
  const type = String(values.type) as FolderType;
  if (!FOLDER_TYPES.includes(type)) fail(`--type must be one of ${FOLDER_TYPES.join(", ")}`);

  // Read-only commands take the project from --project or the config; push resolves it separately.
  const projectKey = (): string => {
    const flag = values.project;
    if (typeof flag === "string" && flag.trim()) return flag.trim().toUpperCase();
    // Before qa.config.json exists there is no project to default to, so --project is required.
    if (CONFIG_EXISTS && !CONFIG_UNSET("qmetry.projectKey")) return CONFIG.qmetry.projectKey;
    return need("project");
  };

  switch (command) {
    case "doctor":
      return run(doctor);
    case "check":
      return run(check);
    case "projects":
      return run(projects);
    case "project":
      return run(() => project(projectKey()));
    case "meta":
      return run(() => meta(projectKey()));
    case "folders":
      return run(() => folders(projectKey(), type));
    case "create-folder": {
      if (!values.root && typeof values["parent-id"] !== "string") fail(`create-folder needs --parent-id or --root\n${USAGE}`);
      const parentId = values.root ? -1 : intArg("parent-id");
      return run(() => createFolder(projectKey(), need("name"), parentId, type));
    }
    case "plans":
      return run(() => plans(projectKey()));
    case "search-testcases": {
      const limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("--limit must be a whole number from 1 to 500");
      return run(() => searchTestCases({
        projectKey: projectKey(),
        text: typeof values.text === "string" && values.text.trim() ? values.text.trim() : null,
        label: typeof values.label === "string" && values.label.trim() ? values.label.trim() : null,
        issueId: typeof values["issue-id"] === "string" ? intArg("issue-id") : null,
        folderId: typeof values["folder-id"] === "string" ? intArg("folder-id") : null,
        limit,
      }));
    }
    case "testcase": {
      const key = need("key").toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*-TC-\d+$/.test(key)) fail("--key must be a QMetry test case key like PROJ-TC-3");
      return run(() => getTestCase(key, typeof values.version === "string" ? intArg("version") : null));
    }
    case "validate":
      return run(() => validate(need("ticket")));
    case "push": {
      const ticket = need("ticket");
      const resuming = readLog(ticket.toUpperCase()) !== null;
      const planFlags = [values.plan, values["new-plan"], values["no-plan"] ? "x" : undefined].filter(Boolean).length;
      if (!resuming && planFlags !== 1) fail(`push needs exactly one of --plan, --new-plan, --no-plan\n${USAGE}`);
      // The folder can come from qa.config.json instead of a flag.
      const folderPath = typeof values.folder === "string" ? values.folder : CONFIG.qmetry.mainFolder;
      if (!resuming && !folderPath && !values["folder-id"]) {
        fail(`push needs --folder or --folder-id, or "qmetry.mainFolder" in qa.config.json\n${USAGE}`);
      }
      return run(() => push({
        ticket,
        projectKey: typeof values.project === "string" && values.project.trim() ? values.project.trim() : null,
        issueId: resuming ? 0 : intArg("issue-id"),
        reviewer: resuming ? "" : need("reviewer"),
        name: resuming ? "" : need("name"),
        folderPath: typeof values["folder-id"] === "string" ? null : folderPath,
        folderId: typeof values["folder-id"] === "string" ? intArg("folder-id") : null,
        plan: values["no-plan"] ? { mode: "none", value: null }
          : typeof values["new-plan"] === "string" ? { mode: "new", value: values["new-plan"] }
          : { mode: "existing", value: typeof values.plan === "string" ? values.plan : null },
        // Config supplies the defaults; --priority-map entries override them one by one.
        priorityMap: { ...CONFIG.qmetry.priorityMap, ...parsePriorityMap(values["priority-map"] as string | undefined) },
        caseStatus: typeof values["case-status"] === "string" ? values["case-status"] : CONFIG.qmetry.caseStatus,
        labels: values["no-labels"] ? false : CONFIG.qmetry.labels,
        aiGenerated: CONFIG.qmetry.markAiGenerated,
        allowExisting: Boolean(values["allow-existing"]),
        confirm: Boolean(values.confirm),
      }));
    }
    case "verify":
      return run(() => verify(need("ticket")));
    case "rollback":
      return run(() => rollback(need("ticket"), Boolean(values.confirm)));
    default:
      console.log(USAGE);
      process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
