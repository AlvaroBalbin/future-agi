import { request, type Page, type Request } from '@playwright/test';
import { test, expect } from '../../lib/fixtures';
import { sendTrace } from '../../lib/otlp';
import { POLL } from '../../lib/state-probe';
import { E2E } from '../../lib/env';
import { flowAnnotation } from '../../lib/flow-meta';

// Saved-view create endpoint (tracer/urls.py `saved-views`). Wire body pinned
// from a request captured from the Save view dialog on dev:
// { project_id, name, tab_type, config: { display: { …, dateFilter }, filters, extra_filters } }.
const SAVED_VIEWS_PATH = '/tracer/saved-views/';
// The endpoint the trace grid posts to (frontend/src/utils/axios.js
// `getTracesForObserveProject`). Body pinned from TraceGrid.jsx buildParams:
// { project_id, page_size, filters: JSON.stringify([...filters, created_at]) }.
const TRACE_LIST_PATH = '/tracer/trace/list_traces_of_session/';
// Browser-side waits — sized like the sibling observe specs.
const UI_READY = 60_000;
// The Observe date dropdown's presets (LLMTracing/ObserveToolbar.jsx DATE_OPTIONS).
const PRESETS = ['Today', 'Yesterday', '7D', '30D', '3M', '6M', '12M'] as const;
type Preset = (typeof PRESETS)[number];
type DateFilter = { dateFilter: string[]; dateOption: string };
type Window = { local: string[]; iso: string[] };

const pad = (n: number) => String(n).padStart(2, '0');
// frontend/src/utils/report-utils.js formatDate: "yyyy-MM-dd HH:mm:ss", local time.
const formatLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

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

// The created_at window a trace-list request carries.
const requestWindow = (r: Request): string[] | null => {
  const body = r.postDataJSON() as { filters?: string } | null;
  const filters = JSON.parse(body?.filters ?? '[]') as Array<{
    column_id: string;
    filter_config: { filter_value: string[] };
  }>;
  return filters.find((f) => f.column_id === 'created_at')?.filter_config.filter_value ?? null;
};

// A saved-view tab's <button> is labelled by its tooltip title, "<name>" or
// "<name> · Press <n>" while inactive with a shortcut
// (components/observe-tabs/CustomViewTab.jsx); its draggable wrapper
// (role=button, aria-roledescription=sortable) shares the text, not the label.
const viewTab = (page: Page, name: string) => page.getByLabel(new RegExp(`^${name}( ·|$)`));

const urlDateFilter = (page: Page): DateFilter | null => {
  const raw = new URL(page.url()).searchParams.get('primaryTraceDateFilter');
  return raw === null ? null : (JSON.parse(raw) as DateFilter);
};

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
  const projectName = `e2e-svdates-${suffix}`;
  const todayRoot = `e2e.svd-today-${suffix}`;
  const yesterdayRoot = `e2e.svd-yesterday-${suffix}`;

  // ~400 days back: outside even the 12M window, so a view still querying its
  // stored range lists neither seeded trace. No clock control in the harness,
  // so the aged view is planted on the wire instead of waited out.
  const staleStart = new Date();
  staleStart.setHours(0, 0, 0, 0);
  staleStart.setDate(staleStart.getDate() - 400);
  const staleEnd = new Date(staleStart);
  staleEnd.setDate(staleEnd.getDate() + 1);
  const staleRange = [formatLocal(staleStart), formatLocal(staleEnd)];

  const yesterdayNoon = new Date();
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  yesterdayNoon.setHours(12, 0, 0, 0);
  const yesterdayNs = BigInt(yesterdayNoon.getTime()) * 1_000_000n;

  const seeded = await test.step('seed a trace now and one yesterday at noon', async () => {
    const today = await sendTrace(req, {
      collectorUrl: E2E.collectorUrl, apiKey: actor.apiKey,
      secretKey: actor.secretKey, projectName, rootName: todayRoot,
    });
    const yesterday = await sendTrace(req, {
      collectorUrl: E2E.collectorUrl, apiKey: actor.apiKey,
      secretKey: actor.secretKey, projectName, rootName: yesterdayRoot,
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
    return { today, yesterday };
  });

  const projects = await probe.pg<{ id: string }>(
    'SELECT id FROM tracer_project WHERE name = $1 AND organization_id = $2',
    [projectName, actor.organizationId]);
  expect(projects).toHaveLength(1);
  const projectId = projects[0].id;

  const views: Array<{ option: Preset | 'Custom'; name: string; id: string }> = [];
  for (const option of [...PRESETS, 'Custom' as const]) {
    const name = `e2e-svd-${option}-${suffix}`;
    const created = await actor.api.post<{ result: { id: string } }>(SAVED_VIEWS_PATH, {
      project_id: projectId, name, tab_type: 'traces',
      config: {
        display: { viewMode: 'graph', dateFilter: { dateFilter: staleRange, dateOption: option } },
        filters: [], extra_filters: [],
      },
    });
    views.push({ option, name, id: created.result.id });
  }
  await testInfo.attach('seeded', {
    body: JSON.stringify({
      projectId, projectName, staleRange,
      todayTraceId: seeded.today.traceId, yesterdayTraceId: seeded.yesterday.traceId,
      views,
    }, null, 2),
    contentType: 'application/json',
  });

  const listRequests: Request[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(TRACE_LIST_PATH)
        && (r.postDataJSON() as { project_id?: string } | null)?.project_id === projectId) {
      listRequests.push(r);
    }
  });

  await test.step('open the project trace list', async () => {
    await page.goto(`/dashboard/observe/${projectId}/llm-tracing?tab=traces`,
      { waitUntil: 'domcontentloaded' });
    await expect(viewTab(page, views[0].name))
      .toBeVisible({ timeout: UI_READY });
  });

  // Real rows carry row-id; AG Grid's hidden loading stub (.ag-row-loading,
  // text "ERR") does not.
  const traceNames = page.locator('.clean-data-table:visible .ag-row[row-id] [col-id="trace_name"]');
  const expectedRows: Record<Preset, string[]> = {
    Today: [todayRoot],
    Yesterday: [yesterdayRoot],
    '7D': [todayRoot, yesterdayRoot],
    '30D': [todayRoot, yesterdayRoot],
    '3M': [todayRoot, yesterdayRoot],
    '6M': [todayRoot, yesterdayRoot],
    '12M': [todayRoot, yesterdayRoot],
  };

  for (const view of views) {
    await test.step(`${view.option}: open the saved view`, async () => {
      // A UTC-hour or midnight boundary can pass between computing the
      // expectation and the app resolving the preset; accept either side.
      const before = await presetWindows(page);
      listRequests.length = 0;
      const response = page.waitForResponse((r) =>
        r.url().includes(TRACE_LIST_PATH) && r.request().method() === 'POST',
        { timeout: UI_READY });
      await viewTab(page, view.name).click();
      await response;
      const after = await presetWindows(page);

      if (view.option === 'Custom') {
        await expect.poll(() => urlDateFilter(page), { timeout: UI_READY })
          .toEqual({ dateFilter: staleRange, dateOption: 'Custom' });
        const staleIso = staleRange.map((d) => new Date(d).toISOString());
        expect(listRequests.length).toBeGreaterThan(0);
        for (const r of listRequests) expect(requestWindow(r)).toEqual(staleIso);
        await expect(traceNames).toHaveCount(0, { timeout: UI_READY });
        return;
      }

      const candidates = [before[view.option], after[view.option]];
      // The tab switch seeds the URL with this view's stored filter; the list
      // response above lands after the hook has rewritten it. Require the
      // preset as of now (either side of a boundary), quoting both on failure.
      await expect.poll(() => urlDateFilter(page)?.dateOption, { timeout: UI_READY })
        .toBe(view.option);
      expect(candidates.map((w) => ({ dateFilter: w.local, dateOption: view.option })),
        `URL date filter for ${view.option}`).toContainEqual(urlDateFilter(page));
      expect(listRequests.length).toBeGreaterThan(0);
      for (const r of listRequests) {
        const sent = requestWindow(r);
        expect(candidates.map((w) => w.iso), `request window for ${view.option}`)
          .toContainEqual(sent);
      }
      await expect(traceNames).toHaveText(expectedRows[view.option], { timeout: UI_READY });
    });
  }

  await test.step('storage: opening the views wrote nothing back', async () => {
    const rows = await probe.pg<{ id: string; date_filter: DateFilter }>(
      "SELECT id::text AS id, config->'display'->'dateFilter' AS date_filter FROM tracer_saved_view WHERE id = ANY($1::uuid[])",
      [views.map((v) => v.id)]);
    expect(rows).toHaveLength(views.length);
    for (const row of rows) {
      const view = views.find((v) => v.id === row.id);
      expect(row.date_filter).toEqual({ dateFilter: staleRange, dateOption: view?.option });
    }
  });

  await req.dispose();
});
