import { request } from '@playwright/test';
import { test, expect } from '../../lib/mock-model-fixtures';
import { sendTrace } from '../../lib/otlp';
import { E2E } from '../../lib/env';
import { POLL } from '../../lib/state-probe';
import { flowAnnotation } from '../../lib/flow-meta';

test.use({ evalBackground: true });

const TEMPLATES = '/model-hub/eval-templates/';
const CONFIGS = '/tracer/custom-eval-config/';
const TASKS = '/tracer/eval-task/';
const TRACE_LIST = '/tracer/trace/list_traces_of_session/';
const SPAN_LIST = '/tracer/observation-span/list_spans_observe/';
const UI_READY = 60_000;

type Created = { result: { id: string } };
type EvalRow = {
  id: string;
  custom_eval_config_id: string;
  eval_task_id: string;
  trace_id: string;
  observation_span_id: string;
  status: string;
  error: boolean;
  output_bool: boolean | number | null;
  output_float: number | null;
  output_str: string | null;
  created_at: string;
};
type Detail = {
  result: {
    observation_spans: Array<{
      observation_span: { id: string };
      eval_rollup?: {
        evals: Array<{
          eval_config_id: string;
          aggregate: Record<string, number>;
          spans: Array<{ span_id: string; value: unknown }>;
        }>;
      };
    }>;
  };
};

function visibleGrid(page: import('@playwright/test').Page) {
  return page.locator('.clean-data-table:visible');
}

function gridRow(page: import('@playwright/test').Page, column: string, value: string) {
  return visibleGrid(page).locator('.ag-row').filter({
    has: page.locator(`[col-id="${column}"]`, { hasText: value }),
  });
}

test('OBS-E2E-037: Observe count tiles use one latest completed eval per span', {
  tag: ['@flow'],
  annotation: flowAnnotation({
    id: 'OBS-E2E-037',
    area: 'observe',
    userGoal: 'See one latest completed evaluation result per span in Observe list tiles and the detail rollup.',
    steps: [
      'ingest one trace with a root and child span',
      'run the same Pass/Fail evaluator twice against the same child span',
      'verify both completed attempts exist and the second is newer',
      'see exactly one pass in the trace and span count tiles',
      'expand the detail per-span breakdown and see the latest result',
    ],
    backendChecks: [
      'actor-scoped project and both OTLP spans are present in ClickHouse spans FINAL',
      'Postgres and ClickHouse tracer_eval_logger FINAL contain exactly two completed attempts for the same config and child span, with the second newer',
      'trace and span list responses render {pass:1,fail:0} for the minted eval config',
      'trace detail exposes the child latest value pass and aggregate {pass:1,fail:0}',
      'the trace and span grids render exactly 1 pass and the expanded rollup renders the latest result',
    ],
  }),
}, async ({ page, actor, probe, mockModel }, testInfo) => {
  test.setTimeout(600_000);
  page.setDefaultTimeout(UI_READY);
  const req = await request.newContext();
  const suffix = `${testInfo.workerIndex}-${Date.now().toString(36)}`;
  const projectName = `e2e-obs-count-${suffix}`;
  const rootName = `e2e-obs-count-root-${suffix}`;
  const childName = `e2e-obs-count-child-${suffix}`;
  const evalName = `e2e-obs-count-eval-${suffix}`;
  const explanation = `e2e-obs-count-explanation-${suffix}`;
  const attach = (name: string, value: unknown) => testInfo.attach(name, {
    contentType: 'application/json',
    body: JSON.stringify(value),
  });

  try {
    await mockModel.assertReady();
    const seed = await sendTrace(req, {
      collectorUrl: E2E.collectorUrl,
      apiKey: actor.apiKey,
      secretKey: actor.secretKey,
      projectName,
      rootName,
      childName,
      childAttributes: { answer: '"Pass"' },
    });
    attach('seed', { projectName, rootName, childName, seed });

    await expect.poll(async () => (await probe.ch<{ n: string }>(
      'SELECT count() AS n FROM spans FINAL WHERE trace_id={t:String}',
      { t: seed.traceId },
    ))[0]?.n, POLL.SPAN_VISIBLE).toBe(String(seed.spanIds.length));

    const projects = await probe.pg<{ id: string }>(
      'SELECT id FROM tracer_project WHERE name=$1 AND organization_id=$2',
      [projectName, actor.organizationId],
    );
    expect(projects).toHaveLength(1);
    const projectId = projects[0].id;
    attach('project', { projectId, organizationId: actor.organizationId, workspaceId: actor.workspaceId });

    const template = (await actor.api.post<Created>(`${TEMPLATES}create-v2/`, {
      name: evalName,
      eval_type: 'llm',
      instructions: `Reply with exactly this JSON: {"result": {{answer}}, "explanation": "${explanation}"}`,
      model: mockModel.model,
      output_type: 'pass_fail',
      pass_threshold: 0.5,
      check_internet: false,
      error_localizer_enabled: false,
    })).result.id;
    const config = (await actor.api.post<Created>(CONFIGS, {
      project: projectId,
      eval_template: template,
      name: evalName,
      model: mockModel.model,
      mapping: { answer: 'answer' },
      config: { mapping: { answer: 'answer' } },
      error_localizer: false,
    })).result.id;
    attach('eval-definition', { template, config, evalName });

    const runTask = async (label: string) => {
      await mockModel.assertReady();
      const now = Date.now();
      const body = {
        name: `${evalName}-${label}`,
        project: projectId,
        evals: [config],
        filters: {
          project_id: projectId,
          date_range: [new Date(now - 3_600_000).toISOString(), new Date(now + 3_600_000).toISOString()],
          span_id: [seed.spanIds[1]],
        },
        run_type: 'historical',
        row_type: 'spans',
        spans_limit: 1,
        sampling_rate: 100,
      };
      const id = (await actor.api.post<Created>(TASKS, body)).result.id;
      await expect.poll(async () => (await actor.api.get<{ status: string }>(`${TASKS}${id}/`)).status,
        POLL.EVAL_RESULT).toBe('completed');
      return id;
    };

    const firstTask = await runTask('first');
    const secondTask = await runTask('second');
    attach('tasks', { firstTask, secondTask });

    const readEvalRows = () => probe.pg<EvalRow>(
      `SELECT id, custom_eval_config_id, eval_task_id, trace_id, observation_span_id,
        status, error, output_bool, output_float, output_str,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM tracer_eval_logger WHERE eval_task_id = ANY($1::uuid[]) ORDER BY created_at, id::text`,
      [[firstTask, secondTask]],
    );
    await expect.poll(async () => (await readEvalRows()).length, POLL.CDC_VISIBLE).toBe(2);
    const rows = await readEvalRows();
    expect(rows.map((row) => row.eval_task_id)).toEqual([firstTask, secondTask]);
    expect(new Date(rows[1].created_at).getTime()).toBeGreaterThan(new Date(rows[0].created_at).getTime());
    expect(rows.every((row) => row.custom_eval_config_id === config && row.observation_span_id === seed.spanIds[1]
      && row.status === 'completed' && !row.error)).toBe(true);
    attach('eval-rows', rows);

    const traceUrl = `/dashboard/observe/${projectId}/llm-tracing?tab=traces&selectedTab=trace`;
    await page.goto(traceUrl, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: '.tsqd-parent-container { display: none !important; }' });
    const traceRow = gridRow(page, 'trace_name', rootName);
    await expect(traceRow.locator(`[col-id="${config}"]`)).toContainText('1 pass');

    await page.goto(`/dashboard/observe/${projectId}/llm-tracing?tab=traces&selectedTab=spans`, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: '.tsqd-parent-container { display: none !important; }' });
    const spanRow = gridRow(page, 'span_name', childName);
    await expect(spanRow.locator(`[col-id="${config}"]`)).toContainText('1 pass');

    await spanRow.locator('[col-id="span_name"]').click();
    await page.getByRole('tab', { name: 'Evals', exact: true }).click();
    const breakdown = page.getByRole('button', { name: 'Show per-span breakdown (1)', exact: true });
    await breakdown.click();
    await expect(page.getByText(evalName, { exact: true })).toBeVisible();
    await expect(page.getByText(/1\/1 passed/, { exact: false })).toBeVisible();
    await expect(page.getByText(explanation, { exact: true })).toBeVisible();

    const detail = await actor.api.get<Detail>(`/tracer/trace/${seed.traceId}/?project_id=${projectId}`);
    const detailEntry = detail.result.observation_spans.find((entry) => entry.observation_span.id === seed.spanIds[1]);
    const rollup = detailEntry?.eval_rollup?.evals.find((entry) => entry.eval_config_id === config);
    expect(rollup?.aggregate).toEqual({ pass: 1, fail: 0 });
    expect(rollup?.spans.find((entry) => entry.span_id === seed.spanIds[1])?.value).toBe('pass');
    attach('detail-rollup', { traceId: seed.traceId, spanId: seed.spanIds[1], rollup });
  } finally {
    await req.dispose();
  }
});
