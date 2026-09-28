#!/usr/bin/env node
/**
 * Imports Playwright results into an existing QMetry test cycle, matched by test case key.
 *
 * Built for CI/CD. No dependencies: Node 22.18+ runs this TypeScript file directly, so it can be
 * copied into the Playwright project as a single file.
 *
 *   node scripts/qmetry-import-results.ts --report playwright-report/results.json --cycle PROJ-TR-2 \
 *        [--push-log docs/test-cases/proj-123-qmetry-push.json] [--environment Staging] [--build 1.4.0] \
 *        [--story PROJ-123] [--out qmetry-junit.xml] [--allow-unmapped] [--allow-new-cases] [--dry-run]
 *
 * How tests are matched to QMetry test cases (see "Playwright results in CI" in README.md):
 *   - Tag each Playwright test with its QMetry key:   test('...', { tag: '@PROJ-TC-3' }, ...)
 *   - Or with its CSV ID, plus --push-log for the mapping:   { tag: '@TC-POS-01' }
 *   - Or with an annotation:   { annotation: { type: 'qmetry', description: 'PROJ-TC-3' } }
 *
 * The script converts Playwright's JSON report into a JUnit file with one <testsuite> per QMetry
 * test case carrying testcasekey="<key>", then runs QMetry's three-step automation import:
 *   1. POST /rest/api/automation/importresult  (format JUNIT, automationHierarchy 1,
 *      testCycleToReuse, matchTestSteps false)  -> upload URL + trackingId
 *   2. PUT the JUnit file to the upload URL
 *   3. GET /rest/api/automation/importresult/track?trackingId=...  until SUCCESS or FAILED
 *
 * Auth: QTM_AUTOMATION_API_KEY (the key from QMetry > Automation & CI/CD > Automation API), falling
 * back to QTM_API_TOKEN. Read from the environment or from a `.env` file in the working directory.
 * QTM_AUTOMATION_BASE_URL overrides https://qtmcloud.qmetry.com/rest/api/automation for other regions.
 *
 * Exit codes: 0 imported, 1 import or network failure, 2 key missing, 3 bad input or unmapped tests,
 * 5 QMetry created new test cases (a key did not match; check for duplicates).
 * Test failures do not change the exit code: Playwright's own step reports those.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_BASE_URL = "https://qtmcloud.qmetry.com/rest/api/automation";
const KEY_RE = /^@?([A-Z][A-Z0-9_]*-TC-\d+)$/;
const CSV_ID_RE = /^@?(TC-[A-Z0-9]+-\d+)$/;

const dotenv = join(process.cwd(), ".env");
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

function fail(message: string, code = 1): never {
  console.error(JSON.stringify({ error: message }));
  process.exit(code);
}
const log = (m: string) => console.error(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Playwright JSON report

interface PwResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string }[];
}
interface PwTest {
  projectName?: string;
  status?: "expected" | "unexpected" | "flaky" | "skipped";
  annotations?: { type: string; description?: string }[];
  results: PwResult[];
}
interface PwSpec {
  title: string;
  file?: string;
  tags?: string[];
  tests: PwTest[];
}
interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface Outcome {
  key: string;
  title: string;
  project: string;
  status: "passed" | "failed" | "skipped";
  seconds: number;
  message: string;
}

const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;]*m/g, "");

function collectSpecs(suites: PwSuite[], parents: string[] = []): { spec: PwSpec; path: string[] }[] {
  const out: { spec: PwSpec; path: string[] }[] = [];
  for (const s of suites) {
    const path = s.title ? [...parents, s.title] : parents;
    for (const spec of s.specs ?? []) out.push({ spec, path });
    out.push(...collectSpecs(s.suites ?? [], path));
  }
  return out;
}

function keysFor(spec: PwSpec, test: PwTest, csvToKey: Map<string, string>): { keys: string[]; unmappedIds: string[] } {
  const candidates = [
    ...(spec.tags ?? []),
    ...(spec.title.match(/@[A-Z][A-Z0-9_-]*-\d+/g) ?? []),
    ...(test.annotations ?? []).filter((a) => a.type.toLowerCase() === "qmetry" && a.description).map((a) => a.description!.trim()),
  ];
  const keys = new Set<string>();
  const unmappedIds: string[] = [];
  for (const c of candidates) {
    const k = c.match(KEY_RE);
    if (k) {
      keys.add(k[1]);
      continue;
    }
    const id = c.match(CSV_ID_RE);
    if (id) {
      const mapped = csvToKey.get(id[1]);
      if (mapped) keys.add(mapped);
      else unmappedIds.push(id[1]);
    }
  }
  return { keys: [...keys], unmappedIds };
}

function outcomeOf(test: PwTest): { status: Outcome["status"]; seconds: number; message: string } {
  const results = test.results ?? [];
  const last = results[results.length - 1];
  const seconds = results.reduce((n, r) => n + (r.duration ?? 0), 0) / 1000;
  if (!last || test.status === "skipped" || last.status === "skipped") return { status: "skipped", seconds, message: "" };
  // "flaky" means it failed, then passed on retry: the final result counts.
  if (last.status === "passed") {
    const retries = results.length - 1;
    return { status: "passed", seconds, message: retries ? `Passed after ${retries} retr${retries === 1 ? "y" : "ies"}` : "" };
  }
  const err = last.error?.message ?? last.errors?.map((e) => e.message).filter(Boolean).join("\n") ?? "";
  return { status: "failed", seconds, message: stripAnsi(`${last.status}: ${err}`).trim() };
}

// ---------------------------------------------------------------------------
// JUnit output, one <testsuite> per QMetry test case (automation hierarchy 1)

const xml = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function toJUnit(outcomes: Outcome[], summaries: Map<string, string>, story: string | null): string {
  const byKey = new Map<string, Outcome[]>();
  for (const o of outcomes) byKey.set(o.key, [...(byKey.get(o.key) ?? []), o]);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>"];
  for (const [key, list] of byKey) {
    const name = summaries.get(key) ?? `${key} ${list[0].title}`;
    const failures = list.filter((o) => o.status === "failed").length;
    const skipped = list.filter((o) => o.status === "skipped").length;
    const time = list.reduce((n, o) => n + o.seconds, 0).toFixed(3);
    lines.push(`  <testsuite name="${xml(name)}" tests="${list.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${time}" testcasekey="${xml(key)}"${story ? ` storykey="${xml(story)}"` : ""}>`);
    for (const o of list) {
      const caseName = o.project ? `${o.title} [${o.project}]` : o.title;
      const open = `    <testcase classname="${xml(name)}" name="${xml(caseName)}" time="${o.seconds.toFixed(3)}"`;
      if (o.status === "passed") lines.push(`${open}/>`);
      else if (o.status === "skipped") lines.push(`${open}>`, "      <skipped/>", "    </testcase>");
      else {
        const first = o.message.split("\n")[0].slice(0, 500);
        lines.push(`${open}>`, `      <failure message="${xml(first)}" type="PlaywrightFailure">${xml(o.message.slice(0, 20000))}</failure>`, "    </testcase>");
      }
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// QMetry automation import

async function http(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
      const text = await resp.text();
      if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
        await sleep(3000 * attempt);
        continue;
      }
      return { status: resp.status, text };
    } catch (err) {
      if (attempt < 3) {
        await sleep(3000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

interface TrackResponse {
  importStatus?: string;
  processStatus?: string;
  detailedMessage?: string;
  summary?: {
    testCycle?: string;
    testCycleIssueKey?: string;
    testCasesCreated?: number;
    testCaseVersionsCreated?: number;
    testCaseVersionsReused?: number;
    testStepsCreated?: number;
  };
}

async function importJUnit(file: string, junit: string, opts: { cycle: string; environment?: string; build?: string; timeoutSec: number }): Promise<TrackResponse> {
  const apiKey = (process.env.QTM_AUTOMATION_API_KEY || process.env.QTM_API_TOKEN || "").trim();
  if (!apiKey) fail("QTM_AUTOMATION_API_KEY is not set (QMetry > Automation & CI/CD > Automation API > Generate)", 2);
  const base = (process.env.QTM_AUTOMATION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  const request: Record<string, unknown> = {
    format: "JUNIT",
    testCycleToReuse: opts.cycle,
    automationHierarchy: 1,
    matchTestSteps: false,
    isZip: false,
  };
  if (opts.environment) request.environment = opts.environment;
  if (opts.build) request.build = opts.build;

  log(`1/3 requesting upload URL (cycle ${opts.cycle})`);
  const start = await http("POST", `${base}/importresult`, { "Content-Type": "application/json", apiKey }, JSON.stringify(request));
  if (start.status >= 300) fail(`importresult returned HTTP ${start.status}: ${start.text.slice(0, 500)}`);
  const { url, trackingId } = JSON.parse(start.text) as { url?: string; trackingId?: string };
  if (!url || !trackingId) fail(`importresult response had no url or trackingId: ${start.text.slice(0, 500)}`);

  log(`2/3 uploading ${basename(file)} (tracking ${trackingId})`);
  const upload = await http("PUT", url, { "Content-Type": "multipart/form-data" }, junit);
  if (upload.status >= 300) fail(`upload returned HTTP ${upload.status}: ${upload.text.slice(0, 500)}`);

  log("3/3 waiting for QMetry to process the import");
  const deadline = Date.now() + opts.timeoutSec * 1000;
  let last: TrackResponse = {};
  while (Date.now() < deadline) {
    await sleep(4000);
    const track = await http("GET", `${base}/importresult/track?trackingId=${encodeURIComponent(trackingId)}`, { "Content-Type": "application/json", apiKey });
    if (track.status >= 300) fail(`track returned HTTP ${track.status}: ${track.text.slice(0, 500)}`);
    last = JSON.parse(track.text) as TrackResponse;
    const status = (last.importStatus ?? "").toUpperCase();
    if (status === "SUCCESS" || status === "FAILED") return { ...last, trackingId } as TrackResponse;
    log(`   ${last.processStatus ?? "in process"}`);
  }
  fail(`Import not finished after ${opts.timeoutSec}s (tracking ${trackingId}). Check QMetry > Automation & CI/CD > History.`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const usage = "Usage: --report <playwright results.json> --cycle <QMetry cycle key> [--push-log <file>] [--environment <name>] [--build <name>] [--story <Jira key>] [--out <file>] [--allow-unmapped] [--allow-new-cases] [--dry-run]";
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log(usage);
    process.exit(0);
  }
  let values;
  try {
    ({ values } = parseArgs({
    options: {
      report: { type: "string" },
      cycle: { type: "string" },
      "push-log": { type: "string" },
      environment: { type: "string" },
      build: { type: "string" },
      story: { type: "string" },
      out: { type: "string", default: "qmetry-junit.xml" },
      timeout: { type: "string", default: "600" },
      "allow-unmapped": { type: "boolean", default: false },
      "allow-new-cases": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  }));
  } catch (err) {
    fail(`${(err as Error).message}\n${usage}`, 3);
  }
  const reportPath = values.report;
  const cycle = values.cycle?.trim();
  if (!reportPath || !cycle) fail(usage, 3);
  if (!/^[A-Z][A-Z0-9_]*-TR-\d+$/.test(cycle)) fail(`--cycle must be a QMetry test cycle key like PROJ-TR-2, got "${cycle}"`, 3);
  if (!existsSync(reportPath)) fail(`Report not found: ${reportPath}. Add ['json', { outputFile: '${reportPath}' }] to the Playwright reporters.`, 3);

  // Optional mapping from CSV IDs to QMetry keys, and QMetry summaries for suite names.
  const csvToKey = new Map<string, string>();
  const summaries = new Map<string, string>();
  if (values["push-log"]) {
    const pl = JSON.parse(readFileSync(values["push-log"], "utf8")) as { testCases?: Record<string, { key: string; summary?: string }>; testCycle?: { key: string } };
    for (const [id, t] of Object.entries(pl.testCases ?? {})) {
      csvToKey.set(id, t.key);
      if (t.summary) summaries.set(t.key, t.summary);
    }
    if (pl.testCycle?.key && pl.testCycle.key !== cycle) log(`warning: push log cycle is ${pl.testCycle.key}, importing into ${cycle}`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { suites?: PwSuite[] };
  const outcomes: Outcome[] = [];
  const unmapped: string[] = [];
  const unknownIds = new Set<string>();
  for (const { spec, path } of collectSpecs(report.suites ?? [])) {
    for (const test of spec.tests ?? []) {
      const { keys, unmappedIds } = keysFor(spec, test, csvToKey);
      unmappedIds.forEach((i) => unknownIds.add(i));
      const title = [...path.slice(1), spec.title].join(" › ");
      if (!keys.length) {
        unmapped.push(`${spec.file ?? path[0] ?? "?"}: ${title}${test.projectName ? ` [${test.projectName}]` : ""}`);
        continue;
      }
      const o = outcomeOf(test);
      for (const key of keys) outcomes.push({ key, title, project: test.projectName ?? "", ...o });
    }
  }

  const perKey = new Map<string, string>();
  for (const o of outcomes) {
    const prev = perKey.get(o.key);
    perKey.set(o.key, prev === "failed" || o.status === "failed" ? "failed" : prev === "passed" || o.status === "passed" ? "passed" : "skipped");
  }
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const s of perKey.values()) counts[s as keyof typeof counts]++;

  const summary = {
    cycle,
    testCases: perKey.size,
    results: counts,
    playwrightTests: outcomes.length,
    unmappedTests: unmapped,
    unknownCsvIds: [...unknownIds],
  };

  if (!outcomes.length) fail(`No tests in ${reportPath} carry a QMetry key tag. ${JSON.stringify(summary)}`, 3);
  if ((unmapped.length || unknownIds.size) && !values["allow-unmapped"]) {
    console.log(JSON.stringify({ ok: false, reason: "Some tests have no QMetry key. Tag them, or pass --allow-unmapped to import the rest.", ...summary }, null, 2));
    process.exit(3);
  }

  const junit = toJUnit(outcomes, summaries, values.story ?? null);
  writeFileSync(values.out!, junit);
  log(`wrote ${values.out} (${perKey.size} QMetry test cases: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped)`);

  if (values["dry-run"]) {
    console.log(JSON.stringify({ ok: true, dryRun: true, junitFile: values.out, ...summary }, null, 2));
    return;
  }

  const result = await importJUnit(values.out!, junit, {
    cycle,
    environment: values.environment,
    build: values.build,
    timeoutSec: Number(values.timeout) || 600,
  });
  const imported = (result.importStatus ?? "").toUpperCase() === "SUCCESS";
  const created = result.summary?.testCasesCreated ?? 0;
  console.log(JSON.stringify({ ok: imported && (created === 0 || values["allow-new-cases"]), ...summary, qmetry: result }, null, 2));
  if (!imported) process.exit(1);
  if (created > 0 && !values["allow-new-cases"]) {
    console.error(JSON.stringify({ error: `QMetry created ${created} new test case(s): a tagged key did not match a case in ${cycle}. Check for duplicates in QMetry.` }));
    process.exit(5);
  }
}

await main();
