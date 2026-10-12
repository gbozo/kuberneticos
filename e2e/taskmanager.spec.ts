import { expect, test, type Page } from '@playwright/test';

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
  replicasets: { source: 'mock', replicasets: [] },
  replicationcontrollers: { source: 'mock', replicationcontrollers: [] },
  services: { source: 'mock', services: [] },
  pods: { source: 'mock', pods: [{ name: 'web-abc123', namespace: 'default', phase: 'Running' }] },
  podLogs: { source: 'mock', logs: 'line one\nline two\nstarted on 2026-01-01' },
};

async function mockClusterApi(page: Page): Promise<URL[]> {
  const podLogRequests: URL[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let payload: unknown;
    if (path.endsWith('/api/clusters')) {
      payload = MOCK_JSON.clusters;
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
    } else if (path.endsWith('/api/pods/logs')) {
      podLogRequests.push(url);
      payload = MOCK_JSON.podLogs;
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
  return podLogRequests;
}

test.describe('Task Manager window app', () => {
  test('launches from the start menu with the right title', async ({ page }) => {
    await mockClusterApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('.kos-startmenu').getByRole('button', { name: 'Task Manager' }).click();

    const window = page.locator('.kos-window');
    await expect(window).toHaveCount(1);
    await expect(window.locator('.kos-window__title')).toHaveText('Task Manager');
  });

  test('drills down from a cluster to namespace workloads to pod logs', async ({ page }) => {
    const podLogRequests = await mockClusterApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('.kos-startmenu').getByRole('button', { name: 'Task Manager' }).click();

    const content = page.locator('.kos-taskmanager__content');

    // A single cluster is auto-selected, landing on the nodes section.
    await expect(
      content.locator('.kos-taskmanager__row-button', { hasText: 'k8s-master' }),
    ).toBeVisible();

    // Switch to namespaces and drill into the "default" namespace.
    await content.getByRole('button', { name: 'Namespaces' }).click();
    await expect(
      content.locator('.kos-taskmanager__row-button', { hasText: 'default' }),
    ).toBeVisible();
    await content.locator('.kos-taskmanager__row-button', { hasText: 'default' }).click();

    // Workloads for the namespace render the mocked deployment and pod.
    await expect(content.getByText('Deployments')).toBeVisible();
    await expect(
      content.locator('.kos-taskmanager__row-button', { hasText: 'web 3/3 ready' }),
    ).toBeVisible();
    await expect(
      content.locator('.kos-taskmanager__row-button', { hasText: 'web-abc123' }),
    ).toBeVisible();

    // Select the pod to open its logs.
    await content.locator('.kos-taskmanager__row-button', { hasText: 'web-abc123' }).click();
    const logs = content.locator('.kos-taskmanager__logs');
    await expect(logs).toContainText('line one');
    await expect(logs).toContainText('started on 2026-01-01');

    // The log request carried the cluster, namespace, pod and tailLines filters.
    // React StrictMode double-invokes effects in dev, so tolerate more than one request.
    expect(podLogRequests.length).toBeGreaterThanOrEqual(1);
    const logUrl = podLogRequests[podLogRequests.length - 1];
    expect(logUrl.searchParams.get('cluster')).toBe('c1');
    expect(logUrl.searchParams.get('namespace')).toBe('default');
    expect(logUrl.searchParams.get('pod')).toBe('web-abc123');
    expect(logUrl.searchParams.get('tailLines')).toBe('200');

    // The breadcrumb reveals the drill-down path.
    const breadcrumbs = page.locator('.kos-taskmanager__crumb-button');
    await expect(breadcrumbs).toHaveText(['Clusters', 'Local', 'default', 'web-abc123']);

    // Back returns to the namespace workloads.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(
      content.locator('.kos-taskmanager__row-button', { hasText: 'web-abc123' }),
    ).toBeVisible();
  });

  test('shows the offline message when no clusters are configured', async ({ page }) => {
    await page.route('**/api/clusters', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ source: 'mock', clusters: [] }),
      }),
    );
    await page.goto('/');

    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('.kos-startmenu').getByRole('button', { name: 'Task Manager' }).click();

    await expect(page.locator('.kos-taskmanager')).toContainText(
      'No clusters configured — start the Go server',
    );
  });
});
