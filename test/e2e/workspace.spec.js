import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const OWNER_EMAIL = 'owner-workspace@example.test';
const OWNER_PASSWORD = 'Workspace-owner-password-1405';

test.describe('فضای کاری سازمانی', () => {
  test('راه‌اندازی مالک و همهٔ نماهای اصلی پایدار، دسترس‌پذیر و بدون سرریز هستند', async ({
    page,
  }) => {
    const serverErrors = [];
    const consoleErrors = [];
    page.on('response', (response) => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    // Keep this full-suite bootstrap isolated from the legacy-login rate-limit
    // bucket exercised by the preceding compatibility tests.
    await page.setExtraHTTPHeaders({
      'X-Forwarded-For': '203.0.113.77',
    });

    await page.goto('/workspace');
    await page.locator('.ws-legacy-login').evaluate((details) => {
      details.open = true;
    });
    await page.locator('#legacyPassword').fill('hamkari-dev-admin');
    await page.locator('#legacyLoginForm button[type=submit]').click();
    await expect(page.locator('#bootstrapDialog')).toHaveAttribute('open', '');

    await page.locator('#bootstrapForm [name=fullName]').fill('مالک آزمایشی');
    await page.locator('#bootstrapForm [name=organizationName]').fill('سازمان آزمون هم‌ساخت');
    await page.locator('#bootstrapForm [name=email]').fill(OWNER_EMAIL);
    await page.locator('#bootstrapForm [name=password]').fill(OWNER_PASSWORD);
    await page.locator('#bootstrapForm button[type=submit]').click();

    await expect(page.locator('#workspaceView')).toBeVisible();
    await expect(page.locator('#pageBody')).toHaveAttribute('aria-busy', 'false');

    const views = [
      'overview',
      'portfolio',
      'participation',
      'execution',
      'resources',
      'performance',
      'finance',
      'capital',
      'governance',
      'compliance',
      'documents',
      'marketplace',
      'reports',
      'team',
      'settings',
      'security',
    ];
    for (const view of views) {
      await page.evaluate((selected) => {
        window.location.hash = `#/${selected}`;
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, view);
      await expect(page.locator('#pageBody')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      await expect(page.getByText('بارگذاری این بخش کامل نشد')).toHaveCount(0);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      window.location.hash = '#/overview';
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('#pageBody')).toHaveAttribute('aria-busy', 'false');
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter((violation) =>
        ['critical', 'serious'].includes(violation.impact)),
    ).toEqual([]);
    expect(serverErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
