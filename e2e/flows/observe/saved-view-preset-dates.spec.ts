import { request, type APIRequestContext, type Page, type Request, type TestInfo } from '@playwright/test';
import { test, expect } from '../../lib/fixtures';
import { sendTrace, type SeededTrace } from '../../lib/otlp';
import { POLL, type StateProbe } from '../../lib/state-probe';
import { E2E } from '../../lib/env';
import { flowAnnotation } from '../../lib/flow-meta';
import type { TestActor } from '../../lib/provisioning';

// Saved-view create endpoint (tracer/urls.py `saved-views`). Wire body pinned
// from a request captured from the Save view dialog on dev:
// { project_id, name, tab_type, config: { display: { …, dateFilter }, filters,
//   extra_filters, compare_filters?, compare_date_filter? } }.
const SAVED_VIEWS_PATH = '/tracer/saved-views/';
// The list endpoints the trace and span grids post to (frontend/src/utils/axios.js
// getTracesForObserveProject / getSpansForObserveProject). Body pinned from
// TraceGrid.jsx / SpanGrid.jsx buildParams:
// { project_id, page_size, filters: JSON.stringify([...filters, created_at]) }.
const TRACE_LIST_PATH = '/tracer/trace/list_traces_of_session/';
const SPAN_LIST_PATH = '/tracer/observation-span/list_spans_observe/';
// The trace graph endpoint (axios.js getTraceGraphData); the compare graph is
// the one place the compare date is sent. Body captured with page.on('request'):
// { project_id, interval, property, req_data_config, filters: [...] }.
const TRACE_GRAPH_PATH = '/tracer/trace/get_graph_methods/';
// Browser-side waits — sized like the sibling observe specs.
const UI_READY = 60_000;
// The Observe date dropdown's presets (LLMTracing/ObserveToolbar.jsx DATE_OPTIONS).
const PRESETS = ['Today', 'Yesterday', '7D', '30D', '3M', '6M', '12M'] as const;
type Preset = (typeof PRESETS)[number];
type Option = Preset | 'Custom';
const OPTIONS: Option[] = [...PRESETS, 'Custom'];
type DateFilter = { dateFilter: string[]; dateOption: string };
type Window = { local: string[]; iso: string[] };
type View = { option: Option; name: string; id: string };

const pad = (n: number) => String(n).padStart(2, '0');
// frontend/src/utils/report-utils.js formatDate: "yyyy-MM-dd HH:mm:ss", local time.
const formatLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// A one-day range `daysAgo` days back. Past ~366 days it is outside even the
// 12M window, so a view still querying it lists none of today's or
// yesterday's rows. The harness has no clock control, so aged views are
// planted on the wire instead of waited out.
const staleRange = (daysAgo: number) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysAgo);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [formatLocal(start), formatLocal(end)];
};
const toIso = (range: string[]) => range.map((d) => new Date(d).toISOString());

// The window each preset resolves to right now, computed in the browser so it
// shares the app's timezone. Mirrors timeWindowPresets.js presetToRange +
// observePresetDateFilter: day presets on local midnights; rolling presets end
// at the next local midnight and start `duration` back, floored to the UTC
// hour; months subtract like date-fns (day clamped to the target month).
async function presetWindows(page: Page): Promise<Record<Preset, Window>> {
  return page.evaluate(() => {
    const p2 = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
      `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const addDays = (d: Date, n: number) => {
      const r = new Date(d);
      r.setDate(r.getDate() + n);
      return r;
    };
    const subMonths = (d: Date, n: number) => {
      const r = new Date(d);
      const day = r.getDate();
      r.setDate(1);
      r.setMonth(r.getMonth() - n);
      const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
      r.setDate(Math.min(day, last));
      return r;
    };
    const floorHour = (d: Date) =>
      new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = addDays(dayStart, 1);
    const ranges: Record<string, Date[]> = {
      Today: [dayStart, tomorrow],
      Yesterday: [addDays(dayStart, -1), dayStart],
      '7D': [floorHour(addDays(now, -7)), tomorrow],
      '30D': [floorHour(addDays(now, -30)), tomorrow],
      '3M': [floorHour(subMonths(now, 3)), tomorrow],
      '6M': [floorHour(subMonths(now, 6)), tomorrow],
      '12M': [floorHour(subMonths(now, 12)), tomorrow],
    };
    return Object.fromEntries(
      Object.entries(ranges).map(([k, [s, e]]) => [
        k,
        { local: [fmt(s), fmt(e)], iso: [s.toISOString(), e.toISOString()] },
      ]),
    );
  }) as Promise<Record<Preset, Window>>;
}

// The created_at window a list or graph request carries. List bodies send
// filters as a JSON string, graph bodies as an array.
const requestWindow = (r: Request): string[] | null => {
  const raw = (r.postDataJSON() as { filters?: unknown } | null)?.filters ?? [];
  const filters = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{
    column_id: string;
    filter_config: { filter_value: string[] };
  }>;
  return filters.find((f) => f.column_id === 'created_at')?.filter_config.filter_value ?? null;
};

// Collects every POST to `path` for one project, so a step can require that
// none of them went out with the stored window.
const captureRequests = (page: Page, path: string, projectId: string) => {
  const captured: Request[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(path)
        && (r.postDataJSON() as { project_id?: string } | null)?.project_id === projectId) {
      captured.push(r);
    }
  });
  return captured;
};

// A saved-view tab's <button> is labelled by its tooltip title, "<name>" or
// "<name> · Press <n>" while inactive with a shortcut
// (components/observe-tabs/CustomViewTab.jsx); its draggable wrapper
// (role=button, aria-roledescription=sortable) shares the text, not the label.
const viewTab = (page: Page, name: string) => page.getByLabel(new RegExp(`^${name}( ·|$)`));

const urlDateFilter = (page: Page, key: string): DateFilter | null => {
  const raw = new URL(page.url()).searchParams.get(key);
  return raw === null ? null : (JSON.parse(raw) as DateFilter);
};

// Real rows carry row-id; AG Grid's hidden loading stub (.ag-row-loading,
// text "ERR") does not. Sorted, so rows sharing a timestamp compare as a set.
const gridColumn = (page: Page, colId: string) =>
  page.locator(`.clean-data-table:visible .ag-row[row-id] [col-id="${colId}"]`)
    .evaluateAll((cells) => cells.map((c) => (c.textContent ?? '').trim()).sort());

type Seeded = {
  projectId: string; today: SeededTrace; yesterday: SeededTrace;
  names: { todayRoot: string; todayChild: string; yesterdayRoot: string; yesterdayChild: string };
};

// One trace now and one yesterday at local noon, in a project of its own, so
// Today, Yesterday and the rolling presets each select a distinct set.
async function seedTwoDays(
  actor: TestActor, probe: StateProbe, req: APIRequestContext, suffix: string,
): Promise<Seeded> {
  const projectName = `e2e-svdates-${suffix}`;
  const names = {
    todayRoot: `e2e.svd-today-${suffix}`, todayChild: `e2e.svd-today-llm-${suffix}`,
    yesterdayRoot: `e2e.svd-yesterday-${suffix}`, yesterdayChild: `e2e.svd-yesterday-llm-${suffix}`,
  };
  const yesterdayNoon = new Date();
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  yesterdayNoon.setHours(12, 0, 0, 0);
  const yesterdayNs = BigInt(yesterdayNoon.getTime()) * 1_000_000n;

  const today = await sendTrace(req, {
    collectorUrl: E2E.collectorUrl, apiKey: actor.apiKey, secretKey: actor.secretKey,
    projectName, rootName: names.todayRoot, childName: names.todayChild,
  });
  const yesterday = await sendTrace(req, {
    collectorUrl: E2E.collectorUrl, apiKey: actor.apiKey, secretKey: actor.secretKey,
    projectName, rootName: names.yesterdayRoot, childName: names.yesterdayChild,
    startTimeUnixNano: yesterdayNs, endTimeUnixNano: yesterdayNs + 50_000_000n,
  });
  for (const t of [today, yesterday]) {
    await expect.poll(async () => {
      const rows = await probe.ch<{ n: string }>(
        'SELECT count() AS n FROM spans FINAL WHERE trace_id = {t:String}',
        { t: t.traceId });
      return Number(rows[0].n);
    }, POLL.SPAN_VISIBLE).toBe(t.spanIds.length);
  }
  const projects = await probe.pg<{ id: string }>(
    'SELECT id FROM tracer_project WHERE name = $1 AND organization_id = $2',
    [projectName, actor.organizationId]);
  expect(projects).toHaveLength(1);
  return { projectId: projects[0].id, today, yesterday, names };
}

async function createViews(
  actor: TestActor, projectId: string, tabType: 'traces' | 'spans', label: string,
  suffix: string, config: (option: Option) => Record<string, unknown>,
): Promise<View[]> {
  const views: View[] = [];
  for (const option of OPTIONS) {
    const name = `e2e-svd-${label}-${option}-${suffix}`;
    const created = await actor.api.post<{ result: { id: string } }>(SAVED_VIEWS_PATH, {
      project_id: projectId, name, tab_type: tabType, config: config(option),
    });
    views.push({ option, name, id: created.result.id });
  }
  return views;
}

// Opening a view must not save it back: every row still holds what was stored.
async function expectStoredUnchanged(
  probe: StateProbe, views: View[], jsonPath: string, expected: (v: View) => DateFilter,
) {
  const rows = await probe.pg<{ id: string; date_filter: DateFilter }>(
    `SELECT id::text AS id, config${jsonPath} AS date_filter FROM tracer_saved_view WHERE id = ANY($1::uuid[])`,
    [views.map((v) => v.id)]);
  expect(rows).toHaveLength(views.length);
  for (const row of rows) {
    const view = views.find((v) => v.id === row.id) as View;
    expect(row.date_filter, `stored date of ${view.option}`).toEqual(expected(view));
  }
}

// One preset or Custom view opened from the tab bar: the URL date param and
// every list request carry the preset as of now (or the stored Custom range),
// and the grid lists exactly the rows that window selects.
async function openListView(page: Page, opts: {
  view: View; dateKey: string; stored: string[]; requests: Request[];
  listPath: string; colId: string; rows: Record<Option, string[]>;
}) {
  const { view, dateKey, stored, requests, listPath, colId, rows } = opts;
  // A UTC-hour or midnight boundary can pass between computing the
  // expectation and the app resolving the preset; accept either side.
  const before = await presetWindows(page);
  requests.length = 0;
  const response = page.waitForResponse((r) =>
    r.url().includes(listPath) && r.request().method() === 'POST', { timeout: UI_READY });
  await viewTab(page, view.name).click();
  await response;
  const after = await presetWindows(page);

  // The tab switch seeds the URL with this view's stored filter; the list
  // response above lands after the hook has rewritten it.
  await expect.poll(() => urlDateFilter(page, dateKey)?.dateOption, { timeout: UI_READY })
    .toBe(view.option);
  if (view.option === 'Custom') {
    expect(urlDateFilter(page, dateKey)).toEqual({ dateFilter: stored, dateOption: 'Custom' });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(requestWindow(r)).toEqual(toIso(stored));
  } else {
    const candidates = [before[view.option], after[view.option]];
    expect(candidates.map((w) => ({ dateFilter: w.local, dateOption: view.option })),
      `URL date filter for ${view.option}`).toContainEqual(urlDateFilter(page, dateKey));
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(candidates.map((w) => w.iso), `request window for ${view.option}`)
        .toContainEqual(requestWindow(r));
    }
  }
  await expect.poll(() => gridColumn(page, colId), { timeout: UI_READY })
    .toEqual([...rows[view.option]].sort());
}

test('OBS-E2E-038: a saved view opens its preset date on fresh dates, and Custom on its saved range', {
  tag: ['@flow'],
  annotation: flowAnnotation({
    id: 'OBS-E2E-038', area: 'observe',
    userGoal: 'A user who reopens a saved trace view set to a preset date (Today, Yesterday, 7D…12M) days later sees that preset as of now, while a Custom view keeps the exact range it was saved with',
    steps: ['send one trace now and one yesterday at noon so a project auto-creates',
            'save one trace view per preset and one Custom view, all storing a range from ~400 days ago',
            'open the project trace list',
            'click each saved view tab in turn'],
    backendChecks: ['both traces have all their spans in ClickHouse spans (FINAL)',
                    'each preset view sends every trace-list request with the preset window as of now, never the stored one, and the URL date param is rewritten to it',
                    'Today lists only the today trace, Yesterday only the yesterday trace, and 7D–12M exactly both',
                    'the Custom view sends and keeps its stored range verbatim and lists neither trace',
                    'opening the views writes nothing back: every tracer_saved_view row in PG still holds its stored range'],
  }),
}, async ({ page, actor, probe }, testInfo) => {
  // SPAN_VISIBLE (15s) + navigation + 8 tab steps, each bounded by UI_READY
  // (9 × 60s = 540s), past the 120s default; the rest is headroom.
  test.setTimeout(600_000);
  const req = await request.newContext();
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const stored = staleRange(400);
  const seeded = await test.step('seed a trace now and one yesterday at noon',
    () => seedTwoDays(actor, probe, req, suffix));
  const views = await createViews(actor, seeded.projectId, 'traces', 'tr', suffix, (option) => ({
    display: { viewMode: 'graph', dateFilter: { dateFilter: stored, dateOption: option } },
    filters: [], extra_filters: [],
  }));
  await attachSeeded(testInfo, { ...seeded, stored, views });

  const { todayRoot, yesterdayRoot } = seeded.names;
  const both = [todayRoot, yesterdayRoot];
  const rows: Record<Option, string[]> = {
    Today: [todayRoot], Yesterday: [yesterdayRoot],
    '7D': both, '30D': both, '3M': both, '6M': both, '12M': both, Custom: [],
  };
  const requests = captureRequests(page, TRACE_LIST_PATH, seeded.projectId);

  await test.step('open the project trace list', async () => {
    await page.goto(`/dashboard/observe/${seeded.projectId}/llm-tracing?tab=traces`,
      { waitUntil: 'domcontentloaded' });
    await expect(viewTab(page, views[0].name)).toBeVisible({ timeout: UI_READY });
  });
  for (const view of views) {
    await test.step(`${view.option}: open the saved view`, () => openListView(page, {
      view, dateKey: 'primaryTraceDateFilter', stored, requests,
      listPath: TRACE_LIST_PATH, colId: 'trace_name', rows,
    }));
  }
  await test.step('storage: opening the views wrote nothing back', () =>
    expectStoredUnchanged(probe, views, "->'display'->'dateFilter'",
      (v) => ({ dateFilter: stored, dateOption: v.option })));
  await req.dispose();
});

test('OBS-E2E-039: a saved span view opens its preset date on fresh dates, and Custom on its saved range', {
  tag: ['@flow'],
  annotation: flowAnnotation({
    id: 'OBS-E2E-039', area: 'observe',
    userGoal: 'A user who reopens a saved span view set to a preset date (Today, Yesterday, 7D…12M) days later sees that preset as of now, while a Custom view keeps the exact range it was saved with',
    steps: ['send one trace now and one yesterday at noon so a project auto-creates',
            'save one span view per preset and one Custom view, all storing a range from ~400 days ago',
            'open the project span list',
            'click each saved view tab in turn'],
    backendChecks: ['both traces have all their spans in ClickHouse spans (FINAL)',
                    'each preset view sends every span-list request with the preset window as of now, never the stored one, and the URL date param is rewritten to it',
                    'Today lists only the today spans, Yesterday only the yesterday spans, and 7D–12M exactly all four',
                    'the Custom view sends and keeps its stored range verbatim and lists no span',
                    'opening the views writes nothing back: every tracer_saved_view row in PG still holds its stored range'],
  }),
}, async ({ page, actor, probe }, testInfo) => {
  // Same budget as OBS-E2E-038: SPAN_VISIBLE + 9 × UI_READY + headroom.
  test.setTimeout(600_000);
  const req = await request.newContext();
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const stored = staleRange(400);
  const seeded = await test.step('seed a trace now and one yesterday at noon',
    () => seedTwoDays(actor, probe, req, suffix));
  const views = await createViews(actor, seeded.projectId, 'spans', 'sp', suffix, (option) => ({
    display: { viewMode: 'graph', dateFilter: { dateFilter: stored, dateOption: option } },
    filters: [], extra_filters: [],
  }));
  await attachSeeded(testInfo, { ...seeded, stored, views });

  const { todayRoot, todayChild, yesterdayRoot, yesterdayChild } = seeded.names;
  const all = [todayRoot, todayChild, yesterdayRoot, yesterdayChild];
  const rows: Record<Option, string[]> = {
    Today: [todayRoot, todayChild], Yesterday: [yesterdayRoot, yesterdayChild],
    '7D': all, '30D': all, '3M': all, '6M': all, '12M': all, Custom: [],
  };
  const requests = captureRequests(page, SPAN_LIST_PATH, seeded.projectId);

  await test.step('open the project span list', async () => {
    await page.goto(`/dashboard/observe/${seeded.projectId}/llm-tracing?tab=traces&selectedTab=spans`,
      { waitUntil: 'domcontentloaded' });
    await expect(viewTab(page, views[0].name)).toBeVisible({ timeout: UI_READY });
  });
  for (const view of views) {
    await test.step(`${view.option}: open the saved view`, () => openListView(page, {
      view, dateKey: 'primarySpanDateFilter', stored, requests,
      listPath: SPAN_LIST_PATH, colId: 'span_name', rows,
    }));
  }
  await test.step('storage: opening the views wrote nothing back', () =>
    expectStoredUnchanged(probe, views, "->'display'->'dateFilter'",
      (v) => ({ dateFilter: stored, dateOption: v.option })));
  await req.dispose();
});

test('OBS-E2E-040: a saved compare view opens its compare preset date on fresh dates, and a Custom compare range as saved', {
  tag: ['@flow'],
  annotation: flowAnnotation({
    id: 'OBS-E2E-040', area: 'observe',
    userGoal: 'A user who reopens a saved trace view in compare mode days later sees its compare preset (Today, Yesterday, 7D…12M) as of now, while a Custom compare range stays exactly as saved',
    steps: ['send one trace now and one yesterday at noon so a project auto-creates',
            'save one compare-mode trace view per compare preset and one with a Custom compare range, all storing a compare range from ~400 days ago and a Custom primary range from ~500 days ago',
            'open the project trace list',
            'click each saved view tab in turn'],
    backendChecks: ['both traces have all their spans in ClickHouse spans (FINAL)',
                    'each compare preset view sends the compare graph request with the preset window as of now and no graph request with the stored compare window, and the URL compare date param is rewritten to it',
                    'the Custom compare view keeps its stored compare range in the URL and sends a graph request with it',
                    'opening the views writes nothing back: every tracer_saved_view row in PG still holds its stored compare range'],
  }),
}, async ({ page, actor, probe }, testInfo) => {
  // Same budget as OBS-E2E-038: SPAN_VISIBLE + 9 × UI_READY + headroom.
  test.setTimeout(600_000);
  const req = await request.newContext();
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const stored = staleRange(400);
  // The primary range differs from the compare range, so a graph request
  // carrying the stored compare window can only be the compare graph.
  const primary = staleRange(500);
  const seeded = await test.step('seed a trace now and one yesterday at noon',
    () => seedTwoDays(actor, probe, req, suffix));
  const views = await createViews(actor, seeded.projectId, 'traces', 'cmp', suffix, (option) => ({
    display: {
      viewMode: 'graph', showCompare: true,
      dateFilter: { dateFilter: primary, dateOption: 'Custom' },
    },
    filters: [], extra_filters: [],
    compare_filters: [], compare_extra_filters: [],
    compare_date_filter: { dateFilter: stored, dateOption: option },
  }));
  await attachSeeded(testInfo, { ...seeded, stored, primary, views });
  const graphRequests = captureRequests(page, TRACE_GRAPH_PATH, seeded.projectId);
  const sentWindows = () => graphRequests.map(requestWindow);

  await test.step('open the project trace list', async () => {
    await page.goto(`/dashboard/observe/${seeded.projectId}/llm-tracing?tab=traces`,
      { waitUntil: 'domcontentloaded' });
    await expect(viewTab(page, views[0].name)).toBeVisible({ timeout: UI_READY });
  });
  for (const view of views) {
    await test.step(`${view.option}: open the saved compare view`, async () => {
      const before = await presetWindows(page);
      graphRequests.length = 0;
      await viewTab(page, view.name).click();
      await expect.poll(() => urlDateFilter(page, 'compareTraceDateFilter')?.dateOption,
        { timeout: UI_READY }).toBe(view.option);

      if (view.option === 'Custom') {
        expect(urlDateFilter(page, 'compareTraceDateFilter'))
          .toEqual({ dateFilter: stored, dateOption: 'Custom' });
        await expect.poll(sentWindows, { timeout: UI_READY }).toContainEqual(toIso(stored));
        return;
      }
      // No list request marks the compare rewrite, so wait for the URL to
      // leave the stored range before asserting what it moved to.
      await expect.poll(() => urlDateFilter(page, 'compareTraceDateFilter'),
        { timeout: UI_READY }).not.toEqual({ dateFilter: stored, dateOption: view.option });
      const after = await presetWindows(page);
      const candidates = [before[view.option], after[view.option]];
      expect(candidates.map((w) => ({ dateFilter: w.local, dateOption: view.option })),
        `URL compare date filter for ${view.option}`)
        .toContainEqual(urlDateFilter(page, 'compareTraceDateFilter'));
      await expect.poll(
        () => candidates.some((w) => sentWindows().some((s) => JSON.stringify(s) === JSON.stringify(w.iso))),
        { timeout: UI_READY }).toBe(true);
      expect(sentWindows(), `no graph request with the stored compare window for ${view.option}`)
        .not.toContainEqual(toIso(stored));
    });
  }
  await test.step('storage: opening the views wrote nothing back', () =>
    expectStoredUnchanged(probe, views, "->'compare_date_filter'",
      (v) => ({ dateFilter: stored, dateOption: v.option })));
  await req.dispose();
});

async function attachSeeded(testInfo: TestInfo, body: Record<string, unknown>) {
  await testInfo.attach('seeded', {
    body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    contentType: 'application/json',
  });
}
