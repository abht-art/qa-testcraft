/**
 * QMetry Test Management for Jira (QTM4J) Cloud Open API: the endpoints this repository uses, one typed
 * function each, grouped by resource as in the specification.
 *
 * Spec: https://app.swaggerhub.com/apis-docs/qmetry-ada/qtm4j_cloud/restapi (OpenAPI 3.0.1). Every
 * function names its method and path; request bodies use the spec's field names. Response types list
 * only the fields the scripts read, since the spec types most responses loosely.
 *
 * All calls go through one transport: `apiKey` header auth, a 60 second timeout, retries (reads on
 * network errors, 429 and 5xx; writes on 429 only, because the server did not process them), Retry-After,
 * and QTM_DEBUG=1 tracing that never prints the key. No dependencies: Node 22.18+ runs this directly.
 */

export const DEFAULT_BASE_URL = "https://qtmcloud.qmetry.com/rest/api/latest";
const PAGE = 100; // The spec's maximum for maxResults.
const PAGE_LIMIT = 500;
const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Transport

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Called per request, so a missing key fails at the first call rather than at import. */
  apiKey: () => string;
  debug?: (line: string) => void;
}

type Params = Record<string, string | number>;

export interface Client {
  request<T>(method: string, path: string, params?: Params, body?: unknown): Promise<T>;
}

export function createClient(opts: ClientOptions): Client {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async request<T>(method: string, path: string, params?: Params, body?: unknown): Promise<T> {
      const query = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : "";
      const headers: Record<string, string> = { apiKey: opts.apiKey(), Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      // Search endpoints are POSTs that change nothing, so they retry like reads.
      const isRead = method === "GET" || path.endsWith("/search") || path === "/projects";

      for (let attempt = 1; ; attempt++) {
        const started = Date.now();
        let resp: Response;
        try {
          resp = await fetch(base + path + query, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          });
        } catch (err) {
          opts.debug?.(`[qtm] ${method} ${path} network error after ${Date.now() - started}ms (attempt ${attempt})`);
          if (isRead && attempt < MAX_ATTEMPTS) {
            await sleep(backoff(attempt));
            continue;
          }
          throw new ApiError(`${method} ${path} failed: ${(err as Error).message}`, 0);
        }
        opts.debug?.(`[qtm] ${method} ${path} ${resp.status} ${Date.now() - started}ms (attempt ${attempt})`);
        const raw = await resp.text();
        if (resp.ok) {
          if (!raw) return {} as T;
          try {
            return JSON.parse(raw) as T;
          } catch {
            return raw as unknown as T;
          }
        }
        // A write that failed any way other than 429 may have been applied, so it is never repeated
        // here; the push log's resume looks it up instead.
        const retryable = resp.status === 429 || (isRead && resp.status >= 500);
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(retryAfterMs(resp.headers.get("retry-after")) ?? backoff(attempt));
          continue;
        }
        throw new ApiError(`${method} ${path} returned HTTP ${resp.status}: ${raw.slice(0, 500)}`, resp.status);
      }
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, so several clients hitting the instance limit don't retry in step. */
function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

/** Retry-After as seconds or an HTTP date, capped at a minute. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : undefined;
}

// ---------------------------------------------------------------------------
// Shapes

export interface Page<T> {
  data?: T[];
  total?: number;
}

export interface Named {
  id: number;
  name: string;
  isArchive?: boolean;
}

export interface FolderNode {
  id: number;
  name: string;
  children?: FolderNode[];
}

export type FolderType = "testcase" | "testcycle" | "testplan";

export interface Project {
  id: number;
  key: string;
  name: string;
  qmetryEnabled?: boolean;
}

/** `{ id, versionNo }`: how the spec refers to one version of a test case when linking. */
export interface CaseRef {
  id: string;
  versionNo: number;
}

export interface TestCaseSummary {
  id: string;
  key: string;
  summary: string;
  version?: { versionNo: number };
  folder?: { id: number; name: string } | null;
  status?: { name: string } | null;
  priority?: { name: string } | null;
  labels?: { id: number; name: string }[] | null;
  archived?: boolean;
}

export interface TestStep {
  id?: number;
  stepDetails?: string;
  testData?: string;
  expectedResult?: string;
}

/** Filter for POST /testcases/search (TestCaseFilterRequest). Only the fields the scripts use. */
export interface TestCaseFilter {
  projectId: number;
  key?: string;
  summary?: string;
  folderId?: number;
  withChild?: boolean;
  labels?: number[];
  requirementIds?: number[];
  searchText?: string;
  aiGenerated?: boolean;
}

/** Body for POST /testcases (Test Case Create Request Body). */
export interface CreateTestCase {
  projectId: number;
  folderId: number;
  summary: string;
  description?: string;
  precondition?: string;
  priority?: number;
  status?: number;
  labels?: number[];
  aiGenerated?: boolean;
  isAutomated?: boolean;
  steps?: { stepDetails: string; testData?: string; expectedResult: string }[];
}

export interface Created {
  id: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Paging

/** Pages through a search endpoint until it runs out. */
export async function pageAll<T>(client: Client, path: string, body: unknown): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; ; page++) {
    // A server that ignored startAt would otherwise return the same page forever.
    if (page >= PAGE_LIMIT) throw new ApiError(`${path} returned more than ${PAGE_LIMIT * PAGE} rows; paging looks broken`, 0);
    const resp = await client.request<Page<T>>("POST", path, { startAt: page * PAGE, maxResults: PAGE }, body);
    const data = resp.data ?? [];
    out.push(...data);
    if (data.length < PAGE || out.length >= (resp.total ?? 0)) break;
  }
  return out;
}

/** Some list endpoints return a bare array, others `{ data: [...] }`. */
async function list<T>(client: Client, path: string): Promise<T[]> {
  const resp = await client.request<T[] | Page<T>>("GET", path);
  return Array.isArray(resp) ? resp : (resp.data ?? []);
}

// ---------------------------------------------------------------------------
// Endpoints

export function endpoints(client: Client) {
  const req = client.request.bind(client);
  const enc = encodeURIComponent;

  return {
    projects: {
      /** POST /projects: QMetry-enabled projects matching `search`. */
      search: (search: string, startAt = 0, maxResults = 100) =>
        req<Page<Project>>("POST", "/projects", { startAt, maxResults }, { search }),
      /** GET /projects/{projectId}/priorities */
      priorities: (projectId: number) => list<Named>(client, `/projects/${projectId}/priorities`),
      /** GET /projects/{projectId}/testcase-statuses */
      testCaseStatuses: (projectId: number) => list<Named>(client, `/projects/${projectId}/testcase-statuses`),
      /** GET /projects/{projectId}/testcycle-statuses */
      testCycleStatuses: (projectId: number) => list<Named>(client, `/projects/${projectId}/testcycle-statuses`),
      /** GET /projects/{projectId}/testplan-statuses */
      testPlanStatuses: (projectId: number) => list<Named>(client, `/projects/${projectId}/testplan-statuses`),
    },

    labels: {
      /** GET /projects/{projectId}/labels */
      list: (projectId: number) => list<Named>(client, `/projects/${projectId}/labels`),
      /** POST /projects/{projectId}/labels (CreateLabelRequest) */
      create: (projectId: number, name: string) => req<{ id: number }>("POST", `/projects/${projectId}/labels`, undefined, { name }),
    },

    folders: {
      /** GET /projects/{projectId}/{type}-folders: the folder tree. */
      tree: async (projectId: number, type: FolderType) => {
        const resp = await req<Page<FolderNode> | FolderNode[]>("GET", `/projects/${projectId}/${type}-folders`);
        return Array.isArray(resp) ? resp : (resp.data ?? []);
      },
      /** POST /projects/{projectId}/{type}-folders (FolderRequest). parentId -1 creates a root folder. */
      create: (projectId: number, type: FolderType, folderName: string, parentId: number) =>
        req<{ id: number; name?: string }>("POST", `/projects/${projectId}/${type}-folders`, undefined, { folderName, parentId }),
      /** DELETE /projects/{projectId}/{type}-folders/{folderId} */
      delete: (projectId: number, type: FolderType, folderId: number) =>
        req<unknown>("DELETE", `/projects/${projectId}/${type}-folders/${folderId}`),
    },

    testCases: {
      /** POST /testcases/search: one page. */
      search: (filter: TestCaseFilter, startAt = 0, maxResults = PAGE) =>
        req<Page<TestCaseSummary>>("POST", "/testcases/search", { startAt, maxResults }, { filter }),
      /** POST /testcases/search: every page. */
      searchAll: (filter: TestCaseFilter) => pageAll<TestCaseSummary>(client, "/testcases/search", { filter }),
      /** POST /testcases: creates a case with its steps in one call. */
      create: (body: CreateTestCase) =>
        req<Created & { versionNo?: number; warningMessage?: string[] }>("POST", "/testcases", undefined, body),
      /** GET /testcases/{idOrKey}/versions/{no} */
      getVersion: (idOrKey: string, versionNo: number) =>
        req<Record<string, unknown>>("GET", `/testcases/${enc(idOrKey)}/versions/${versionNo}`),
      /** POST /testcases/{id}/versions/{no}/teststeps/search: every step. */
      steps: (id: string, versionNo: number) =>
        pageAll<TestStep>(client, `/testcases/${enc(id)}/versions/${versionNo}/teststeps/search`, {}),
      /** DELETE /testcases/{id} */
      delete: (id: string) => req<unknown>("DELETE", `/testcases/${enc(id)}`),
    },

    requirements: {
      /** POST /requirements/{id}/testcases/link: `issueId` is the numeric Jira issue ID, not the key. */
      linkTestCases: (issueId: number, testcases: CaseRef[]) =>
        req<unknown>("POST", `/requirements/${issueId}/testcases/link`, undefined, { testcases }),
    },

    testCycles: {
      /** POST /testcycles/search: every page. */
      searchAll: (filter: { projectId: number; summary?: string; key?: string }) =>
        pageAll<Created & { summary: string }>(client, "/testcycles/search", { filter }),
      /** POST /testcycles (CreateTestCycleRequest), linking cases in the same call. */
      create: (body: { projectId: number; summary: string; description?: string; folderId?: number; testCasesToLink?: { testCases: CaseRef[] } }) =>
        req<Created>("POST", "/testcycles", undefined, body),
      /** POST /testcycles/{id}/testcases/search: every linked case. */
      testCases: (cycleId: string) => pageAll<{ id: string; key?: string }>(client, `/testcycles/${enc(cycleId)}/testcases/search`, { filter: {} }),
      /** POST /testcycles/{id}/testcases (LinkTestCaseRequest) */
      linkTestCases: (cycleId: string, testCases: CaseRef[]) =>
        req<unknown>("POST", `/testcycles/${enc(cycleId)}/testcases`, undefined, { testCases }),
      /** POST /testcycles/{id}/requirements/link (LinkRequirementsRequest) */
      linkRequirements: (cycleId: string, requirementIds: number[]) =>
        req<unknown>("POST", `/testcycles/${enc(cycleId)}/requirements/link`, undefined, { requirementIds }),
      /** DELETE /testcycles/{id} */
      delete: (cycleId: string) => req<unknown>("DELETE", `/testcycles/${enc(cycleId)}`),
    },

    testPlans: {
      /** POST /testplans/search: every page. */
      searchAll: (filter: { projectId: number; summary?: string }) =>
        pageAll<Created & { summary: string; status?: { name: string } }>(client, "/testplans/search", { filter }),
      /** POST /testplans (TestPlanRequest) */
      create: (body: { projectId: number; summary: string; description?: string }) => req<Created>("POST", "/testplans", undefined, body),
      /** PUT /testplans/{id}/testcycles (TestPlanLinkTestCyclesRequest) */
      linkTestCycles: (planId: string, testcycleIds: string[]) =>
        req<unknown>("PUT", `/testplans/${enc(planId)}/testcycles`, undefined, { testcycleIds }),
      /** DELETE /testplans/{id}/testcycles (TestPlanUnlinkTestCyclesRequest). There is no /unlink route. */
      unlinkTestCycles: (planId: string, testcycleIds: string[]) =>
        req<unknown>("DELETE", `/testplans/${enc(planId)}/testcycles`, undefined, { testcycleIds }),
      /** DELETE /testplans/{id} */
      delete: (planId: string) => req<unknown>("DELETE", `/testplans/${enc(planId)}`),
    },
  };
}

export type QMetry = ReturnType<typeof endpoints>;
