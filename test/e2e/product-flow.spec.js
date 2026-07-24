import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const projectPath = "/projects/greenhouse-20ha";
const applicantName = "شرکت آزمون همکاری";

async function loginAsAdmin(page) {
  await page.goto("/admin");
  const password = page.getByLabel("رمز مدیریت");
  if (await password.isVisible()) {
    await password.fill("hamkari-dev-admin");
    await page.getByRole("button", { name: "ورود امن" }).click();
  }
  await expect(page.getByRole("heading", { name: "نمای کلی" })).toBeVisible();
}

async function stabilizeVisualPage(page) {
  await page.evaluate(() => document.fonts.ready);
}

test.describe.serial("مسیر اصلی محصول", () => {
  test("رگرسیون تصویری مسیرهای اصلی در عرض‌های هدف", async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      const NativeDate = Date;
      const fixedNow = new NativeDate("2026-07-24T08:00:00.000Z").valueOf();
      class FixedDate extends NativeDate {
        constructor(...args) {
          super(...(args.length ? args : [fixedNow]));
        }

        static now() {
          return fixedNow;
        }
      }
      globalThis.Date = FixedDate;
    });

    for (const width of [360, 390, 768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
      await page.goto(projectPath);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await stabilizeVisualPage(page);
      await expect(page).toHaveScreenshot(`project-${width}.png`, { fullPage: true });
    }

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
      await page.goto(`${projectPath}/needs/capital`);
      await expect(page.locator("#proposal-form")).toBeVisible();
      await stabilizeVisualPage(page);
      await expect(page).toHaveScreenshot(`need-detail-${width}.png`, { fullPage: true });
    }

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
      await loginAsAdmin(page);
      await stabilizeVisualPage(page);
      await expect(page).toHaveScreenshot(`admin-overview-${width}.png`, { fullPage: true });
    }
  });

  test("ثبت، پیگیری و پذیرش پیشنهاد پیشرفت واقعی را تغییر می‌دهد", async ({ page }) => {
    await page.goto(projectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("گلخانه");
    await expect(page.locator('[data-summary-percent]')).toHaveText("۰٪");

    const capitalCard = page.locator('[data-need-card-id="capital"]');
    await expect(capitalCard).toBeVisible();
    await capitalCard.getByRole("link", { name: "مشاهده و ارسال پیشنهاد" }).click();
    await expect(page).toHaveURL(/\/needs\/capital$/);
    await expect(page.locator("#proposal-form")).toBeVisible();

    await page.locator("#applicantName").fill(applicantName);
    await page.locator("#mobile").fill("۰۹۱۲۳۴۵۶۷۸۹");
    await page.locator("#email").fill("proposal@example.com");
    await page.locator("#contribution").fill("توان تأمین مرحله‌ای سرمایه ساخت سازه و تجهیزات اصلی پروژه را داریم.");
    await page.locator("#availability").selectOption("within_1_month");
    await page.locator("#notes").fill("برای بررسی اسناد مالی و برنامه زمان‌بندی آماده جلسه هستیم.");
    await page.locator("#consent").check();
    await page.getByRole("button", { name: "ثبت پیشنهاد برای بررسی" }).click();

    await expect(page.locator(".proposal-success")).toBeVisible();
    await expect(page.locator(".reference-code")).toBeVisible();
    await page.getByRole("link", { name: "مشاهده پیگیری‌های من" }).click();
    await expect(page.getByText("در انتظار بررسی", { exact: false })).toBeVisible();

    await loginAsAdmin(page);
    await page.locator('.nav-item[data-view="proposals"]').click();
    const proposalRow = page.locator(".table-row").filter({ hasText: applicantName });
    await expect(proposalRow).toBeVisible();
    await proposalRow.getByRole("button", { name: "بررسی" }).click();
    await expect(page.getByRole("dialog")).toContainText(applicantName);

    await page.getByRole("button", { name: "تماس گرفته شد" }).click();
    await page.getByRole("button", { name: "شروع مذاکره" }).click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "پذیرش و تثبیت نیاز" }).click();
    await expect(page.getByRole("dialog")).toContainText("پذیرفته‌شده");

    await page.goto(projectPath);
    await expect(page.locator('[data-summary-percent]')).toHaveText("۱۳٪");
    await expect(page.locator('[data-need-card-id="capital"]')).toContainText("تعهد نهایی");

    await page.goto("/my-proposals");
    await expect(page.getByText("پذیرفته‌شده", { exact: false })).toBeVisible();
  });

  test("صفحه عمومی در عرض‌های کلیدی هم‌تراز و بدون overflow است", async ({ page }) => {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
      { width: 1280, height: 900 },
      { width: 1440, height: 960 }
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(projectPath);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const measurements = await page.evaluate(() => {
        const header = document.querySelector(".header-inner")?.getBoundingClientRect();
        const hero = document.querySelector(".hero-grid")?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          rightDiff: header && hero ? Math.abs(header.right - hero.right) : 999,
          leftDiff: header && hero ? Math.abs(header.left - hero.left) : 999
        };
      });
      expect(measurements.overflow, `${viewport.width}px horizontal overflow`).toBeLessThanOrEqual(1);
      expect(measurements.rightDiff, `${viewport.width}px right alignment`).toBeLessThanOrEqual(2);
      expect(measurements.leftDiff, `${viewport.width}px left alignment`).toBeLessThanOrEqual(2);
    }
  });

  test("صفحه عمومی و ورود مدیر خطای جدی دسترس‌پذیری ندارند", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(projectPath);
    const publicResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(publicResults.violations.filter(item => ["serious", "critical"].includes(item.impact))).toEqual([]);

    await page.goto("/admin");
    const loginResults = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(loginResults.violations.filter(item => ["serious", "critical"].includes(item.impact))).toEqual([]);
  });

  test("شبکه کند، قطع SSE، حالت آفلاین و نمای مؤثر زوم ۲۰۰٪ پایدار می‌مانند", async ({ page, context }) => {
    await page.addInitScript(() => {
      const nativeSetInterval = window.setInterval.bind(window);
      globalThis.__hamkariIntervals = [];
      window.setInterval = (callback, delay, ...args) => {
        globalThis.__hamkariIntervals.push(delay);
        return nativeSetInterval(callback, delay, ...args);
      };
    });
    await page.route("**/api/v1/projects/greenhouse-20ha/events", route => route.abort());
    await page.route("**/api/v1/projects/greenhouse-20ha", async route => {
      await new Promise(resolve => setTimeout(resolve, 750));
      await route.continue();
    });

    await page.goto(projectPath);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => globalThis.__hamkariIntervals.includes(30_000))
    ).toBe(true);
    await expect(page.locator("#live-indicator")).toBeHidden();

    await context.setOffline(true);
    await expect(page.locator("#offline-indicator")).toBeVisible();
    await context.setOffline(false);
    await expect(page.locator("#offline-indicator")).toBeHidden();

    // 720 CSS pixels on a 1440px display is the effective layout viewport at 200% zoom.
    await page.setViewportSize({ width: 720, height: 900 });
    await page.evaluate(() => {
      document.querySelector("h1").textContent =
        "گلخانه مشارکتی با عنوان چندخطی بسیار طولانی برای سنجش شکست درست سطرها";
      document.querySelector(".need-target strong").textContent =
        "۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶۷۸۹۰";
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("توکن پیگیری فقط از fragment وارد می‌شود و مسیر URL قدیمی غیرفعال است", async ({ page }) => {
    const fakeToken = "A".repeat(43);
    await page.goto(`/my-proposals?token=${fakeToken}`);
    await expect(page).toHaveURL(/\/my-proposals$/);
    await expect(page.getByText("هنوز پیشنهادی در این مرورگر ندارید")).toBeVisible();
  });

  test("پنل مدیر همه صفحه‌های پیشنهاد و آمار تجمیعی را دریافت می‌کند", async ({ page }) => {
    await page.route("**/api/v1/admin/proposals?*", async route => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset") || 0);
      const count = offset === 0 ? 200 : 1;
      const proposals = Array.from({ length: count }, (_, index) => {
        const sequence = offset + index + 1;
        return {
          id: `synthetic-${sequence}`,
          referenceCode: `REF-${sequence}`,
          applicantName: sequence === 201 ? "متقاضی صفحه دوم" : `متقاضی ${sequence}`,
          mobile: "09123456789",
          contribution: "شرح کوتاه پیشنهاد برای آزمون صفحه‌بندی پنل مدیریت.",
          needTitle: "زمین و زیرساخت اولیه",
          status: "new",
          createdAt: "2026-07-24T08:00:00.000Z",
          updatedAt: "2026-07-24T08:00:00.000Z"
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          proposals,
          summary: { total: 201, new: 201, contacted: 0, negotiating: 0, accepted: 0, rejected: 0 },
          pagination: {
            limit: 200,
            offset,
            returned: count,
            matching: 201,
            hasMore: offset === 0,
            nextOffset: offset === 0 ? 200 : null
          }
        })
      });
    });
    await loginAsAdmin(page);
    await expect(page.locator("#navPendingCount")).toHaveText("۲۰۱");
    await page.locator('.nav-item[data-view="proposals"]').click();
    await expect(page.getByText("متقاضی صفحه دوم", { exact: true })).toBeVisible();
  });

  test("مدیر اطلاعات پروژه و چرخه ایجاد تا آرشیو نیاز را از رابط کامل می‌کند", async ({ page }) => {
    await loginAsAdmin(page);
    await page.locator('.nav-item[data-view="project"]').click();
    await page.getByLabel("فرآیند مشارکت").fill(
      "پیشنهاد ثبت می‌شود، مدیر تماس می‌گیرد، مذاکره انجام می‌شود و تعهد نهایی شفاف ثبت خواهد شد."
    );
    await page.getByRole("button", { name: "ذخیره تغییرات" }).click();
    await expect(page.locator("#projectSaveState")).toContainText("ذخیره شد");

    await page.locator('.nav-item[data-view="needs"]').click();
    await page.getByRole("button", { name: "افزودن نیاز" }).click();
    await page.getByLabel("عنوان نیاز").fill("لجستیک آزمایشی");
    await page.getByLabel("دسته‌بندی").fill("عملیات");
    await page.getByLabel("هدف یا خروجی مورد انتظار").fill("برنامه حمل مصوب");
    await page.getByLabel("توضیح کوتاه").fill("طراحی برنامه حمل مرحله‌ای برای تجهیزات و مصالح اصلی پروژه.");
    await page.getByLabel("دامنه و انتظارها").fill("ارائه مسیر، ظرفیت ناوگان و زمان‌بندی قابل اجرا.");
    await page.getByLabel("ترتیب نمایش").fill("9");
    await page.getByRole("button", { name: "ذخیره نیاز" }).click();
    const needCard = page.locator(".need-manager-card").filter({ hasText: "لجستیک آزمایشی" });
    await expect(needCard).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await needCard.getByRole("button", { name: "آرشیو" }).click();
    await expect(needCard).toContainText("آرشیوشده");

    await page.locator('.nav-item[data-view="project"]').click();
    await page.getByLabel("نشانی کوتاه (slug)").fill("greenhouse-live-room");
    await page.getByRole("button", { name: "ذخیره تغییرات" }).click();
    await expect(page.locator("#projectSaveState")).toContainText("ذخیره شد");
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("گلخانه");
    await expect(page.locator("#project-nav-link")).toHaveAttribute(
      "href",
      "/projects/greenhouse-live-room"
    );
  });
});
