/**
 * Reads qa.config.json, the per-team settings shared by the scripts, agent, commands and skills.
 *
 * The file is created from qa.config.example.json (by /qa-setup, or by copying it), and
 * qa.config.schema.json is the definition of what it may contain: the allowed keys and required
 * sections below are read from the schema, so the two can't drift apart. The value checks here
 * mirror the schema's types and patterns.
 *
 * Secrets never live here: the QMetry tokens come from .env. Every value has a default, so a
 * missing config file is not fatal for read-only commands, but `doctor` reports it.
 * No dependencies: Node 22.18+ runs this TypeScript file directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = join(REPO_ROOT, "qa.config.json");
export const SCHEMA_FILE = join(REPO_ROOT, "qa.config.schema.json");

export interface QaConfig {
  team: { name: string; documentRole: string };
  jira: { site: string; projectKey: string };
  qmetry: {
    baseUrl: string;
    projectKey: string;
    priorityMap: Record<string, string>;
    caseStatus: string | null;
    labels: boolean;
    mainFolder: string | null;
    /** Sets QMetry's aiGenerated flag on pushed cases, so AI-drafted cases stay identifiable. */
    markAiGenerated: boolean;
  };
  testCases: { defaultTier: "smoke" | "critical" | "full" };
}

export const DEFAULT_QMETRY_BASE_URL = "https://qtmcloud.qmetry.com/rest/api/latest";
const PLACEHOLDER_SITE = "your-site.atlassian.net";
const PLACEHOLDER_KEY = "PROJ";
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const TIERS = ["smoke", "critical", "full"];

const DEFAULTS: QaConfig = {
  team: { name: "Your team", documentRole: "Developers" },
  jira: { site: PLACEHOLDER_SITE, projectKey: PLACEHOLDER_KEY },
  qmetry: {
    baseUrl: DEFAULT_QMETRY_BASE_URL,
    projectKey: PLACEHOLDER_KEY,
    priorityMap: { High: "High", Normal: "Medium", Low: "Low" },
    caseStatus: null,
    labels: true,
    mainFolder: null,
    markAiGenerated: true,
  },
  testCases: { defaultTier: "critical" },
};

export interface ConfigResult {
  config: QaConfig;
  file: string;
  exists: boolean;
  /** Problems that make the file unusable as written. */
  errors: string[];
  /** Values still on their shipped placeholder, or worth a second look. */
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readSection(raw: Record<string, unknown>, name: string, errors: string[]): Record<string, unknown> {
  const value = raw[name];
  if (value === undefined) return {};
  if (!isObject(value)) {
    errors.push(`"${name}" must be an object`);
    return {};
  }
  return value;
}

function str(section: Record<string, unknown>, key: string, path: string, fallback: string, errors: string[]): string {
  const v = section[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`"${path}" must be a non-empty string`);
    return fallback;
  }
  return v.trim();
}

function nullableStr(section: Record<string, unknown>, key: string, path: string, errors: string[]): string | null {
  const v = section[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`"${path}" must be a non-empty string or null`);
    return null;
  }
  return v.trim();
}

function bool(section: Record<string, unknown>, key: string, path: string, fallback: boolean, errors: string[]): boolean {
  const v = section[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") {
    errors.push(`"${path}" must be true or false`);
    return fallback;
  }
  return v;
}

interface SchemaShape {
  properties: Record<string, unknown>;
  required: string[];
  sectionKeys: Record<string, string[]>;
}

/** The parts of qa.config.schema.json the loader enforces: top-level keys, required sections, keys per section. */
function readSchema(errors: string[]): SchemaShape {
  try {
    const s = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as { properties?: Record<string, { properties?: Record<string, unknown> }>; required?: string[] };
    const properties = s.properties ?? {};
    const sectionKeys: Record<string, string[]> = {};
    for (const [name, def] of Object.entries(properties)) {
      if (def && typeof def === "object" && def.properties) sectionKeys[name] = Object.keys(def.properties);
    }
    return { properties, required: s.required ?? [], sectionKeys };
  } catch (err) {
    errors.push(`qa.config.schema.json could not be read: ${(err as Error).message}`);
    return { properties: {}, required: [], sectionKeys: {} };
  }
}

/** Loads and validates the config, reporting problems instead of throwing. */
export function loadConfig(): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(CONFIG_FILE)) {
    return {
      config: DEFAULTS,
      file: CONFIG_FILE,
      exists: false,
      errors: [`qa.config.json not found at ${CONFIG_FILE}. Run /qa-setup in Claude Code to create it, or copy qa.config.example.json and fill it in.`],
      warnings,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    return { config: DEFAULTS, file: CONFIG_FILE, exists: true, errors: [`qa.config.json is not valid JSON: ${(err as Error).message}`], warnings };
  }
  if (!isObject(raw)) {
    return { config: DEFAULTS, file: CONFIG_FILE, exists: true, errors: ["qa.config.json must contain a JSON object"], warnings };
  }

  // Allowed keys and required sections come from the schema, the one definition of the file.
  const schema = readSchema(errors);
  for (const key of Object.keys(raw)) {
    if (!(key in schema.properties)) errors.push(`"${key}" is not a setting in qa.config.schema.json`);
  }
  for (const key of schema.required) {
    if (raw[key] === undefined) errors.push(`"${key}" is required (see qa.config.example.json)`);
  }
  for (const [section, allowed] of Object.entries(schema.sectionKeys)) {
    const value = raw[section];
    if (!isObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) errors.push(`"${section}.${key}" is not a setting in qa.config.schema.json; check the spelling`);
    }
  }

  const team = readSection(raw, "team", errors);
  const jira = readSection(raw, "jira", errors);
  const qmetry = readSection(raw, "qmetry", errors);
  const testCases = readSection(raw, "testCases", errors);

  const jiraKey = str(jira, "projectKey", "jira.projectKey", DEFAULTS.jira.projectKey, errors).toUpperCase();
  if (!KEY_RE.test(jiraKey)) errors.push(`"jira.projectKey" must look like a Jira project key (PROJ), got "${jiraKey}"`);
  const site = str(jira, "site", "jira.site", DEFAULTS.jira.site, errors).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9.-]+$/.test(site)) errors.push(`"jira.site" must be a host like your-site.atlassian.net, got "${site}"`);

  const qmetryKey = str(qmetry, "projectKey", "qmetry.projectKey", jiraKey, errors).toUpperCase();
  if (!KEY_RE.test(qmetryKey)) errors.push(`"qmetry.projectKey" must look like a project key (PROJ), got "${qmetryKey}"`);

  const baseUrl = str(qmetry, "baseUrl", "qmetry.baseUrl", DEFAULTS.qmetry.baseUrl, errors).replace(/\/+$/, "");
  if (!/^https:\/\/[^\s]+$/.test(baseUrl)) errors.push(`"qmetry.baseUrl" must be an https URL, got "${baseUrl}"`);

  const priorityMap: Record<string, string> = { ...DEFAULTS.qmetry.priorityMap };
  const rawMap = qmetry.priorityMap;
  if (rawMap !== undefined && rawMap !== null) {
    if (!isObject(rawMap)) {
      errors.push('"qmetry.priorityMap" must be an object of CSV name to QMetry name');
    } else {
      for (const [from, to] of Object.entries(rawMap)) {
        if (typeof to !== "string" || !to.trim()) errors.push(`"qmetry.priorityMap.${from}" must be a non-empty string`);
        else priorityMap[from] = to.trim();
      }
    }
  }
  for (const csvName of ["High", "Normal", "Low"]) {
    if (!priorityMap[csvName]) warnings.push(`"qmetry.priorityMap" has no entry for the CSV priority "${csvName}"; the name is used as is`);
  }

  const tier = str(testCases, "defaultTier", "testCases.defaultTier", DEFAULTS.testCases.defaultTier, errors).toLowerCase();
  if (!TIERS.includes(tier)) errors.push(`"testCases.defaultTier" must be one of ${TIERS.join(", ")}, got "${tier}"`);

  if (site === PLACEHOLDER_SITE) warnings.push(`"jira.site" is still the placeholder ${PLACEHOLDER_SITE}`);
  if (jiraKey === PLACEHOLDER_KEY) warnings.push(`"jira.projectKey" is still the placeholder ${PLACEHOLDER_KEY}`);
  if (qmetryKey === PLACEHOLDER_KEY) warnings.push(`"qmetry.projectKey" is still the placeholder ${PLACEHOLDER_KEY}`);

  const config: QaConfig = {
    team: {
      name: str(team, "name", "team.name", DEFAULTS.team.name, errors),
      documentRole: str(team, "documentRole", "team.documentRole", DEFAULTS.team.documentRole, errors),
    },
    jira: { site, projectKey: jiraKey },
    qmetry: {
      baseUrl,
      projectKey: qmetryKey,
      priorityMap,
      caseStatus: nullableStr(qmetry, "caseStatus", "qmetry.caseStatus", errors),
      labels: bool(qmetry, "labels", "qmetry.labels", DEFAULTS.qmetry.labels, errors),
      mainFolder: nullableStr(qmetry, "mainFolder", "qmetry.mainFolder", errors),
      markAiGenerated: bool(qmetry, "markAiGenerated", "qmetry.markAiGenerated", DEFAULTS.qmetry.markAiGenerated, errors),
    },
    testCases: { defaultTier: tier as QaConfig["testCases"]["defaultTier"] },
  };

  return { config, file: CONFIG_FILE, exists: true, errors, warnings };
}

/** The config for normal use: exits with a clear message when the file cannot be used. */
export function requireConfig(): QaConfig {
  const result = loadConfig();
  if (result.errors.length) {
    console.error(JSON.stringify({ error: "qa.config.json is not usable", problems: result.errors, file: result.file }));
    process.exit(2);
  }
  return result.config;
}
