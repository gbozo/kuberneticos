import { expect, test } from '@playwright/test';

test.describe('KuberneticOS desktop shell', () => {
  test('pins the taskbar to the bottom of the viewport', async ({ page }) => {
    await page.goto('/');

    const taskbar = page.locator('.kos-taskbar');
    await expect(taskbar).toBeVisible();

    const box = await taskbar.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();

    // The taskbar's bottom edge aligns with the bottom of the viewport.
    expect(Math.abs(box!.y + box!.height - viewport!.height)).toBeLessThanOrEqual(2);
  });

  test('opens the start menu above the taskbar and launches a window', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.kos-startmenu')).toHaveCount(0);

    await page.getByRole('button', { name: 'Start' }).click();

    const menu = page.locator('.kos-startmenu');
    await expect(menu).toBeVisible();

    const taskbar = page.locator('.kos-taskbar');
    const menuBox = await menu.boundingBox();
    const taskbarBox = await taskbar.boundingBox();
    // The start menu sits above (does not overlap) the taskbar.
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(taskbarBox!.y + 2);

    await menu.getByRole('button', { name: 'Cluster Explorer' }).click();
    await expect(menu).toHaveCount(0);

    const window = page.locator('.kos-window');
    await expect(window).toHaveCount(1);
    await expect(window.locator('.kos-window__title')).toHaveText('Cluster Explorer');
  });

  test('closes a window with its title-bar close control', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Start' }).click();
    await page.locator('.kos-startmenu').getByRole('button', { name: 'Cluster Explorer' }).click();

    const window = page.locator('.kos-window');
    await expect(window).toHaveCount(1);

    await window.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.kos-window')).toHaveCount(0);
  });
});
