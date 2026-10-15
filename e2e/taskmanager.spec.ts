// Task Manager 2.0 e2e (Phase 5, T1).
//
// The Task Manager was rewritten as a Win11 shell, so the old breadcrumb
// selectors (`.kos-taskmanager__content`, `__row-button`, `__logs`,
// `__crumb-button`) are gone. The dropped breadcrumbs' capability now lives in
// the row-activated detail flyouts, so this spec asserts pod logs, service
// detail and node detail.
import { expect, test, type Locator, type Page } from '@playwright/test';

const MOCK_JSON = {
  clusters: {
    source: 'mock',
    clusters: [{ id: 'c1', name: 'Local', server: 'https://127.0.0.1:6443' }],
  },
  nodes: {
    source: 'mock',
    nodes: [{ name: 'k8s-master', status: 'Ready', roles: ['control-plane'], version: 'v1.30.0' }],
  },
  namespaces: { source: 'mock', namespaces: [{ name: 'default', status: 'Active' }] },
  deployments: {
    source: 'mock',
    deployments: [
      {
        name: 'web',
        namespace: 'default',
        replicas: { desired: 3, ready: 3, available: 3, updated: 3 },
        images: ['nginx:1.27'],
      },
    ],
  },
  replicasets: {
    source: 'mock',
    replicasets: [
      {
        name: 'web-abc123',
        namespace: 'default',
        replicas: { desired: 3, ready: 3, available: 3, updated: 3 },
        ownerKind: 'Deployment',
        ownerName: 'web',
      },
    ],
  },
  replicationcontrollers: { source: 'mock', replicationcontrollers: [] },
  services: {
    source: 'mock',
    services: [
      {
        name: 'web',
        namespace: 'default',
        type: 'ClusterIP',
        clusterIP: '10.96.0.10',
        ports: [{ name: 'http', port: 80, protocol: 'TCP', targetPort: '8080' }],
        selector: { app: 'web' },
      },
    ],
  },
  nodeDetail: {
    name: 'k8s-master',
    status: 'Ready',
    roles: ['control-plane'],
    version: 'v1.30.0',
    capacity: { cpu: '8', memory: '16Gi', pods: '110' },
    allocatable: { cpu: '7910m', memory: '15711780Ki', pods: '110' },
    conditions: [{ type: 'Ready', status: 'True' }],
    addresses: [{ type: 'InternalIP', address: '172.18.0.2' }],
  },
  podLogs: 'line one\nline two\nstarted on 2026-01-01',
  pods: {
    source: 'mock',
    pods: [
      {
        name: 'web-abc123-xyz',
        namespace: 'default',
        phase: 'Running',
        node: 'k8s-master',
        ownerKind: 'ReplicaSet',
        ownerName: 'web-abc123',
        labels: { app: 'web' },
      },
    ],
  },
  nodeMetrics: {
    source: 'mock',
    available: true,
    nodes: [
      {
        name: 'k8s-master',
        cpuMillis: 740,
        memoryBytes: 1073741824,
        cpuAllocatableMillis: 4000,
        memoryAllocatableBytes: 8589934592,
        diskUsedBytes: 21474836480,
        diskCapacityBytes: 107374182400,
        networkRxBytes: 1024,
        networkTxBytes: 2048,
        podCount: 10,
      },
    ],
  },
  podMetrics: {
    source: 'mock',
    available: true,
    pods: [
      {
        name: 'web-abc123-xyz',
        namespace: 'default',
        node: 'k8s-master',
        cpuMillis: 50,
        memoryBytes: 52428800,
        containers: [{ name: 'web', cpuMillis: 50, memoryBytes: 52428800 }],
      },
    ],
  },
};

interface MockOptions {
  readonly offline?: boolean;
}

async function mockClusterApi(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let payload: unknown;
    // Metrics branches must come first: `/api/metrics/nodes` also ends with
    // `/nodes`, so it would otherwise be swallowed by the generic node route.
    if (path.endsWith('/api/metrics/nodes')) {
      payload = MOCK_JSON.nodeMetrics;
    } else if (path.endsWith('/api/metrics/pods')) {
      payload = MOCK_JSON.podMetrics;
    } else if (path.endsWith('/api/nodes/detail')) {
      payload = { source: 'mock', node: MOCK_JSON.nodeDetail };
    } else if (path.endsWith('/api/pods/logs')) {
      payload = { source: 'mock', logs: MOCK_JSON.podLogs };
    } else if (path.endsWith('/api/clusters')) {
      payload = options.offline ? { source: 'offline', clusters: [] } : MOCK_JSON.clusters;
    } else if (path.endsWith('/api/nodes')) {
      payload = MOCK_JSON.nodes;
    } else if (path.endsWith('/api/namespaces')) {
      payload = MOCK_JSON.namespaces;
    } else if (path.endsWith('/api/deployments')) {
      payload = MOCK_JSON.deployments;
    } else if (path.endsWith('/api/replicasets')) {
      payload = MOCK_JSON.replicasets;
    } else if (path.endsWith('/api/replicationcontrollers')) {
      payload = MOCK_JSON.replicationcontrollers;
    } else if (path.endsWith('/api/services')) {
      payload = MOCK_JSON.services;
    } else if (path.endsWith('/api/pods')) {
      payload = MOCK_JSON.pods;
    } else {
      payload = { source: 'mock' };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function openTaskManager(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Start' }).click();
  await page.locator('.kos-startmenu').getByRole('button', { name: 'Task Manager' }).click();

  const window = page.locator('.kos-window');
  await expect(window).toHaveCount(1);
  await expect(window.locator('.kos-window__title')).toHaveText('Task Manager');
  return window;
}

test.describe('Task Manager window app', () => {
  test('launches on the Workloads page with the cluster hero', async ({ page }) => {
    await mockClusterApi(page);
    await page.goto('/');

    const window = await openTaskManager(page);

    const rail = window.locator('nav[role="tablist"][aria-label="Task Manager"]');
    await expect(rail).toBeVisible();
    for (const name of ['Workloads', 'Performance', 'Services', 'Pods', 'Namespaces', 'Nodes']) {
      await expect(rail.getByRole('tab', { name })).toBeVisible();
    }
    await expect(
      window.locator('.kos-taskmanager__rail-footer').getByRole('tab', { name: 'Settings' }),
    ).toBeVisible();

    // The default page is Workloads (fresh context: no `kos.tm.*` persisted).
    await expect(window.locator('.kos-tm-view--workloads')).toBeVisible();
    const grid = window.getByRole('grid', { name: 'Workloads' });
    await expect(grid).toBeVisible();
    await expect(grid.getByText('web', { exact: true })).toBeVisible();

    const hero = window.locator('.kos-taskmanager__hero');
    await expect(hero).toHaveAttribute('aria-label', 'Cluster overview');
    await expect(hero.locator('.kos-taskmanager__hero-title')).toHaveText('Local');
    const meta = hero.locator('.kos-taskmanager__hero-meta');
    await expect(meta).toContainText('Version');
    await expect(meta).toContainText('Nodes');
  });

  test('navigates pages and expands the workload tree', async ({ page }) => {
    await mockClusterApi(page);
    await page.goto('/');

    const window = await openTaskManager(page);
    const rail = window.locator('nav[role="tablist"][aria-label="Task Manager"]');

    await rail.getByRole('tab', { name: 'Performance' }).click();
    await expect(window.locator('.kos-tm-view--performance')).toBeVisible();
    const resources = window.locator('.kos-tm-resource-list');
    for (const name of ['CPU', 'Memory', 'Disk', 'Network']) {
      await expect(resources.getByRole('button', { name })).toBeVisible();
    }
    await expect(
      window.getByText('Metrics unavailable — install metrics-server to see live data'),
    ).toHaveCount(0);

    await rail.getByRole('tab', { name: 'Services' }).click();
    await expect(window.locator('.kos-tm-view--services')).toBeVisible();
    await expect(window.getByRole('grid', { name: 'Services' })).toBeVisible();

    await rail.getByRole('tab', { name: 'Pods' }).click();
    await expect(window.locator('.kos-tm-view--inventory[data-page="pods"]')).toBeVisible();
    const podsGrid = window.getByRole('grid', { name: 'Pods' });
    await expect(podsGrid).toBeVisible();
    await expect(podsGrid.getByText('web-abc123-xyz', { exact: true })).toBeVisible();

    await rail.getByRole('tab', { name: 'Workloads' }).click();
    await expect(window.locator('.kos-tm-view--workloads')).toBeVisible();

    const firstRow = window.locator('.kos-tm-table__row').first();
    await firstRow.locator('button.kos-tm-table__tree-toggle[aria-label="Expand"]').click();
    await expect(window.getByText('web-abc123', { exact: true })).toBeVisible();

    const replicasetRow = window.locator('.kos-tm-table__row', { hasText: 'web-abc123' }).first();
    await replicasetRow.locator('.kos-tm-table__tree-toggle').click();
    await expect(window.getByText('web-abc123-xyz', { exact: true })).toBeVisible();
  });

  test('shows the offline empty state when no clusters are configured', async ({ page }) => {
    await mockClusterApi(page, { offline: true });
    await page.goto('/');

    const window = await openTaskManager(page);
    await expect(window.locator('.kos-taskmanager__status.is-error')).toHaveText(
      'No clusters configured — start the Go server',
    );
  });

  test('opens the workload detail flyout with pod logs', async ({ page }) => {
    await mockClusterApi(page);
    await page.goto('/');

    const window = await openTaskManager(page);
    const flyout = page.locator('aside.kos-tm-flyout');
    await expect(flyout).toHaveCount(0);

    // Flattening the tree to Pod makes the pod a root row.
    await window.getByLabel('Group by').selectOption('pod');
    const podRow = window.getByRole('row', { name: /web-abc123-xyz/ });
    await expect(podRow).toBeVisible();
    await podRow.dblclick();

    await expect(flyout).toBeVisible();
    await expect(flyout.locator('.kos-tm-flyout__title')).toHaveText('web-abc123-xyz');
    await expect(flyout.getByRole('heading', { name: 'Logs' })).toBeVisible();
    await expect(flyout.locator('.kos-tm-flyout__logs')).toContainText('line one');

    await flyout.getByRole('button', { name: 'Close' }).click();
    await expect(flyout).toBeHidden();

    // Non-pod workloads show the children list instead of logs.
    await window.getByLabel('Group by').selectOption('deployment');
    await window.getByRole('row', { name: /web/ }).first().dblclick();
    await expect(flyout).toBeVisible();
    await expect(flyout.getByRole('heading', { name: 'Children' })).toBeVisible();
  });

  test('opens service and node detail flyouts', async ({ page }) => {
    await mockClusterApi(page);
    await page.goto('/');

    const window = await openTaskManager(page);
    const rail = window.locator('nav[role="tablist"][aria-label="Task Manager"]');
    const flyout = page.locator('aside.kos-tm-flyout');

    await rail.getByRole('tab', { name: 'Services' }).click();
    await expect(window.locator('.kos-tm-view--services')).toBeVisible();
    await window.getByRole('row', { name: /web/ }).first().dblclick();

    await expect(flyout).toBeVisible();
    const ports = flyout.locator('.kos-tm-flyout__table');
    await expect(ports).toContainText('80');
    await expect(ports).toContainText('8080');
    await expect(flyout.getByText('app=web')).toBeVisible();
    await expect(flyout.getByText('web-abc123-xyz')).toBeVisible();

    await flyout.getByRole('button', { name: 'Close' }).click();
    await expect(flyout).toBeHidden();

    await rail.getByRole('tab', { name: 'Nodes' }).click();
    await expect(window.locator('.kos-tm-view--inventory[data-page="nodes"]')).toBeVisible();
    await window
      .getByRole('row', { name: /k8s-master/ })
      .first()
      .dblclick();

    await expect(flyout).toBeVisible();
    await expect(flyout.getByRole('heading', { name: 'Capacity' })).toBeVisible();
    await expect(flyout).toContainText('Ready');
  });
});
