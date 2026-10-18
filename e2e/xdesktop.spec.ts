import { expect, test, type Page, type Route } from '@playwright/test';

// M4 offline contract (xdesktop-plan.md §5): XDesktop and Terminal never have a
// live session in e2e — the suite runs against `vite dev` without a cluster, so
// the /api leg is mocked with page.route. Everything below asserts graceful
// degradation: explain, offer Retry, and never break the window manager.
const OFFLINE_ERROR = 'offline: no Kubernetes cluster is configured';

function jsonFulfill(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function openStartMenuApp(page: Page, appTitle: string): Promise<void> {
  await page.getByRole('button', { name: 'Start' }).click();
  await page.locator('.kos-startmenu').getByRole('button', { name: appTitle }).click();
}

test.describe('X-Desktop remote apps (offline mode)', () => {
  test('start-menu Remote App without a pod target shows the empty state', async ({ page }) => {
    await page.goto('/');

    await openStartMenuApp(page, 'Remote App');

    const window = page.locator('.kos-window');
    await expect(window).toHaveCount(1);
    await expect(window.locator('.kos-window__title')).toHaveText('Remote App');

    const status = window.locator('.kos-xdesktop__status');
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-kind', 'error');
    await expect(status).toContainText(
      'No pod or app command — open a remote app from Cluster Explorer.',
    );
    // No pod target to retry against, so no Retry control.
    await expect(window.locator('.kos-xdesktop__retry')).toHaveCount(0);

    // No allocation was attempted: the empty state stays stable.
    await expect(status).toContainText('No pod or app command');
  });

  test('closing the degraded Remote App keeps the window manager functional', async ({ page }) => {
    // Cluster Explorer asks the (mocked, offline) API for clusters: empty list,
    // the documented offline answer.
    await page.route(/\/api\/clusters$/, (route: Route) =>
      route.fulfill(jsonFulfill({ source: 'offline', clusters: [] })),
    );

    await page.goto('/');
    await openStartMenuApp(page, 'Remote App');

    const window = page.locator('.kos-window');
    await expect(window.locator('.kos-xdesktop__status')).toContainText('No pod or app command');

    await window.getByRole('button', { name: 'Close' }).click();
    await expect(window).toHaveCount(0);
    await expect(page.locator('.kos-taskbar')).toBeVisible();

    // The desktop still launches fresh windows afterwards.
    await openStartMenuApp(page, 'Cluster Explorer');
    await expect(page.locator('.kos-window')).toHaveCount(1);
    await expect(page.locator('.kos-window .kos-window__title')).toHaveText('Cluster Explorer');
    await expect(page.getByText('No clusters configured — start the Go server')).toBeVisible();
  });

  test('start-menu Terminal without a pod target shows the empty state', async ({ page }) => {
    await page.goto('/');

    await openStartMenuApp(page, 'Terminal');

    const window = page.locator('.kos-window');
    await expect(window).toHaveCount(1);
    await expect(window.locator('.kos-window__title')).toHaveText('Terminal');

    const status = window.locator('.kos-terminal__status');
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-kind', 'error');
    await expect(status).toContainText('No pod selected — open a terminal from Cluster Explorer.');
    await expect(window.locator('.kos-terminal__retry')).toHaveCount(0);
  });

  test('a pod GUI session degrades gracefully against the offline server and closes cleanly', async ({
    page,
  }) => {
    // Mocked single-cluster server: one pod flagged with the x-app annotation
    // (the Cluster Explorer "Open GUI app" gate).
    await page.route(/\/api\/clusters$/, (route: Route) =>
      route.fulfill(
        jsonFulfill({
          source: 'offline',
          clusters: [{ id: 'kind', name: 'kind', server: 'https://kind:6443' }],
        }),
      ),
    );
    await page.route(/\/api\/pods\?/, (route: Route) =>
      route.fulfill(
        jsonFulfill({
          source: 'offline',
          pods: [
            {
              name: 'firefox-0',
              namespace: 'default',
              phase: 'Running',
              annotations: { 'kos.dev/x-app': 'firefox' },
            },
          ],
        }),
      ),
    );
    // The display allocator answers like the Go server in offline mode: 503.
    await page.route(/\/api\/xdisplay$/, (route: Route) =>
      route.fulfill(jsonFulfill({ source: 'offline', error: OFFLINE_ERROR }, 503)),
    );

    await page.goto('/');
    await openStartMenuApp(page, 'Cluster Explorer');
    await expect(page.locator('.kos-window')).toHaveCount(1);

    await page.getByRole('button', { name: 'Open GUI app…' }).click();

    const session = page.locator('.kos-window').filter({ hasText: 'firefox-0/firefox' });
    await expect(session).toHaveCount(1);

    const status = session.locator('.kos-xdesktop__status');
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('data-kind', 'error');
    await expect(status).toContainText(OFFLINE_ERROR);
    await expect(session.getByRole('button', { name: 'Retry' })).toBeVisible();

    // Closing the degraded session tears it down without dangling windows.
    await session.getByRole('button', { name: 'Close' }).click();
    await expect(session).toHaveCount(0);
    await expect(page.locator('.kos-window')).toHaveCount(1);
    await expect(page.locator('.kos-taskbar')).toBeVisible();

    await page.locator('.kos-window').getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.kos-window')).toHaveCount(0);
  });
});
