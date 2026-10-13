import { test, expect } from '../../lib/fixtures';
import { flowAnnotation } from '../../lib/flow-meta';
import { seedCallExecutions } from '../../lib/simulate-seed';

const UI_READY = 60_000;

test('AGENT-E2E-001: agent call logs render evaluation columns for scoped call executions', {
  tag: ['@flow'],
  annotation: flowAnnotation({
    id: 'AGENT-E2E-001',
    area: 'agents',
    userGoal: 'A developer opening an agent version Call Logs sees the evaluation result column for its calls.',
    steps: [
      'seed completed call executions with evaluation output in one actor scope',
      'open the agent version Call Logs tab',
      'see the seeded calls and their evaluation column',
    ],
    backendChecks: [
      'the seeded AgentDefinition, AgentVersion and CallExecution rows belong to the actor organization and workspace',
      'all seeded calls are completed and carry non-empty eval_outputs',
      'the Call Logs endpoint returns the actor-scoped rows used by the grid',
    ],
  }),
}, async ({ page, actor }) => {
  test.setTimeout(120_000);
  const seed = seedCallExecutions({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    count: 2,
  });

  await page.goto(
    `/dashboard/simulate/agent-definitions/${seed.agentDefinitionId}?activeTab=CallLogs&version=${seed.agentVersionId}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.addStyleTag({ content: '.tsqd-parent-container { display: none !important; }' });

  const rows = page.locator('.clean-data-table:visible .ag-row');
  await expect(rows).toHaveCount(seed.callExecutionCount, { timeout: UI_READY });
  await expect(page.getByText('Evaluation', { exact: true })).toBeVisible({ timeout: UI_READY });
});
