import { expect, test } from "@playwright/test";

async function loginAsAdmin(page) {
  await page.goto("/admin");
  const password = page.getByLabel("رمز مدیریت");
  if (await password.isVisible()) {
    await password.fill("hamkari-dev-admin");
    await page.getByRole("button", { name: "ورود امن" }).click();
  }
  await expect(page.locator("#projectSwitcher")).toBeVisible();
  await expect.poll(() => page.locator("#projectSwitcher").inputValue()).not.toBe("");
}

async function submitEntity(page, buttonName = "ذخیره") {
  const dialog = page.locator("#entityDialog");
  await dialog.getByRole("button", { name: buttonName, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe.serial("پرتفوی و مرکز عملیات چندپروژه‌ای", () => {
  test("پرتفوی جست‌وجو و فیلتر دارد و پرونده عمومی هیچ هویت مالکیتی را افشا نمی‌کند", async ({ page }) => {
    const privateMarker = "نام خصوصی که نباید دیده شود";
    await page.route("**/api/v1/projects", async route => {
      const response = await route.fetch();
      const payload = await response.json();
      if (payload.projects?.[0]?.metrics?.capital) {
        payload.projects[0].metrics.capital.holdings = [{
          stakeholderName: privateMarker,
          mobile: "09120000000",
          units: 100
        }];
      }
      await route.fulfill({ response, json: payload });
    });
    await page.route(/\/api\/v1\/projects\/[^/]+$/, async route => {
      const response = await route.fetch();
      const payload = await response.json();
      if (payload.project?.metrics?.capital) {
        payload.project.metrics.capital.holdings = [{
          stakeholderName: privateMarker,
          email: "private@example.com",
          units: 100
        }];
      }
      await route.fulfill({ response, json: payload });
    });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("هر پروژه");
    const cards = page.locator("[data-portfolio-card]");
    await expect(cards.first()).toBeVisible();
    await expect(page.getByLabel("جست‌وجوی پروژه")).toBeVisible();
    await expect(page.getByLabel("فیلتر صنعت")).toBeVisible();
    await expect(page.getByLabel("فیلتر مرحله")).toBeVisible();
    await expect(page.getByLabel("فیلتر وضعیت")).toBeVisible();

    await page.getByLabel("جست‌وجوی پروژه").fill("پروژه‌ای که قطعاً وجود ندارد");
    await expect(page.getByText("پروژه‌ای با این فیلتر پیدا نشد")).toBeVisible();
    await page.getByLabel("جست‌وجوی پروژه").fill("گلخانه");
    await expect(cards.filter({ hasText: "گلخانه" }).first()).toBeVisible();
    await page.getByLabel("جست‌وجوی پروژه").fill("");
    await page.getByLabel("فیلتر وضعیت").selectOption("active");
    await expect(cards.first()).toBeVisible();
    await expect(page.getByText(privateMarker)).toHaveCount(0);

    const projectHref = await cards.first().getByRole("link").first().getAttribute("href");
    await page.goto(projectHref);
    await expect(page.getByRole("navigation", { name: "بخش‌های پروندهٔ پروژه" })).toBeVisible();
    await expect(page.locator('[data-signal="operation"]')).toContainText("پیشرفت عملیاتی");
    await expect(page.locator('[data-signal="participation"]')).toContainText("تکمیل مشارکت");
    await expect(page.getByText("عملکرد مالی", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "سرمایه و مالکیت" }).click();
    await expect(page).toHaveURL(/tab=capital/);
    await expect(page.getByText(
      "دفتر ثبت داخلی؛ تسویه بانکی و اعتبار حقوقی انتقال خارج از سامانه انجام می‌شود",
      { exact: true }
    )).toBeVisible();
    await expect(page.getByText(privateMarker)).toHaveCount(0);

    await page.getByRole("link", { name: "عملکرد و اهداف" }).click();
    await expect(page.getByRole("heading", { name: "مالی و عملیاتی، کنار هم اما مستقل" })).toBeVisible();
    await page.getByRole("link", { name: "حاکمیت و مصوبات" }).click();
    await expect(page.getByRole("heading", { name: "جلسه‌ها و مصوبات عمومی" })).toBeVisible();

    await page.goto("/projects/digital-supply-network?tab=performance");
    const financeBars = page.locator(".finance-bar");
    await expect(financeBars).toHaveCount(3);
    const values = await financeBars.evaluateAll(elements =>
      elements.map(element => Number(element.value))
    );
    expect(values[0]).toBeGreaterThan(values[1]);
    expect(values[1]).toBeGreaterThan(values[2]);
    await expect(page.locator(".finance-bar[style]")).toHaveCount(0);
    await expect(page.locator(".display-metric.tone-roi strong")).toHaveText("—");
  });

  test("روند مالی خارج از محدوده با مقدار دقیق نمایش داده می‌شود، نه صفر ساختگی", async ({ page }) => {
    const exactRevenue = "18014398509481983";
    await page.route("**/api/v1/projects/digital-supply-network", async route => {
      const response = await route.fetch();
      const payload = await response.json();
      const period = payload.project.financial.periods[0];
      Object.assign(period, {
        revenue: null,
        netProfit: null,
        overflow: true,
        exact: {
          revenue: exactRevenue,
          expense: String(period.expense),
          investment: "0",
          distribution: "0",
          netProfit: "18014391509481983",
          cashFlow: "18014391509481983"
        }
      });
      await route.fulfill({ response, json: payload });
    });

    await page.goto("/projects/digital-supply-network?tab=performance");
    const period = page.locator(".finance-period").first();
    await expect(period).toContainText("۱۸٬۰۱۴٬۳۹۸٬۵۰۹٬۴۸۱٬۹۸۳");
    await expect(period.locator(".finance-bar").first()).toHaveJSProperty("value", 0);
    await expect(period.locator(".finance-bar-row").first()).not.toContainText("۰ ریال");
  });

  test("مدیر یک پروژه مستقل می‌سازد و گردش‌کار منابع اصلی را کامل می‌کند", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsAdmin(page);
    const initialProjectValue = await page.locator("#projectSwitcher").inputValue();
    const initialProjectCount = await page.locator("#projectSwitcher option").count();

    await page.locator("#newProjectButton").click();
    const entity = page.locator("#entityDialog");
    await entity.getByLabel("عنوان پروژه").fill("پروژه آزمون سبد");
    await entity.getByLabel("نشانی کوتاه انگلیسی").fill("portfolio-e2e-project");
    await entity.getByLabel("صنعت").fill("آزمایش محصول");
    await entity.getByLabel("مرحله").selectOption("pilot");
    await entity.getByLabel("وضعیت انتشار").selectOption("published");
    await submitEntity(page, "ساخت پروژه");
    await expect(page.locator("#projectSwitcher option:checked")).toHaveText("پروژه آزمون سبد");
    await expect.poll(() => page.locator("#projectSwitcher option").count())
      .toBeGreaterThanOrEqual(initialProjectCount + 1);

    await page.locator('.nav-item[data-view="stakeholders"]').click();
    for (const [name, role] of [
      ["سرمایه‌گذار آزمون الف", "investor"],
      ["شریک آزمون ب", "partner"]
    ]) {
      await page.getByRole("button", { name: "افزودن ذی‌نفع" }).click();
      await entity.getByLabel("نام").fill(name);
      await entity.getByLabel("نقش").selectOption(role);
      await submitEntity(page, "افزودن");
      await expect(page.locator("#stakeholderList")).toContainText(name);
    }

    await page.locator('.nav-item[data-view="capital"]').click();
    await page.getByRole("button", { name: "طبقهٔ جدید" }).click();
    await entity.getByLabel("نام طبقه").fill("واحد ممتاز آزمون");
    await entity.getByLabel("نماد").fill("TST");
    await entity.getByLabel("سقف واحد مجاز").fill("1000");
    await submitEntity(page);
    await expect(page.locator("#shareClassList")).toContainText("TST");

    await page.locator("#issueSharesButton").click();
    await entity.getByLabel("طبقهٔ سرمایه").selectOption({ label: "واحد ممتاز آزمون (TST)" });
    await entity.getByLabel("دارنده").selectOption({ label: "سرمایه‌گذار آزمون الف" });
    await entity.getByLabel("تعداد واحد").fill("100");
    await submitEntity(page, "ثبت صدور");
    await expect(page.locator("#holdingsTable")).toContainText("سرمایه‌گذار آزمون الف");

    await page.locator('.nav-item[data-view="transfers"]').click();
    await page.getByRole("button", { name: "ثبت عرضه" }).click();
    await entity.getByLabel("طبقهٔ سرمایه").selectOption({ label: "واحد ممتاز آزمون (TST)" });
    await entity.getByLabel("نوع عرضه").selectOption("sell");
    await entity.getByLabel("فروشنده (برای فروش)").selectOption({ label: "سرمایه‌گذار آزمون الف" });
    await entity.getByLabel("تعداد واحد").fill("20");
    await entity.getByLabel("قیمت هر واحد").fill("1000");
    await submitEntity(page);
    await expect(page.locator("#offerList")).toContainText("فروش");

    await page.getByRole("button", { name: "ثبت انتقال" }).click();
    await entity.getByLabel("طبقهٔ سرمایه").selectOption({ label: "واحد ممتاز آزمون (TST)" });
    await entity.getByLabel("انتقال‌دهنده").selectOption({ label: "سرمایه‌گذار آزمون الف" });
    await entity.getByLabel("دریافت‌کننده").selectOption({ label: "شریک آزمون ب" });
    await entity.getByLabel("تعداد واحد").fill("10");
    await entity.getByLabel("مبلغ کل").fill("10000");
    await entity.getByLabel("وضعیت شروع").selectOption("pending");
    await submitEntity(page);
    await page.locator("#transferList").getByRole("button", { name: "تأیید انتقال" }).click();
    await entity.getByLabel("یادداشت تصمیم").fill("تطبیق مدارک خارج از سامانه انجام شد.");
    await submitEntity(page, "تأیید انتقال");
    await expect(page.locator("#transferList")).toContainText("تأییدشده");

    await page.locator('.nav-item[data-view="finance"]').click();
    await page.getByRole("button", { name: "ثبت رویداد مالی" }).click();
    await entity.getByLabel("نوع ثبت").selectOption("investment");
    await entity.getByLabel("مبلغ").fill("1000000");
    await submitEntity(page);
    await expect(page.locator("#financialEntries")).toContainText("سرمایه‌گذاری");

    await page.locator('.nav-item[data-view="goals"]').click();
    await page.getByRole("button", { name: "افزودن هدف" }).click();
    await entity.getByLabel("عنوان هدف").fill("آماده‌سازی پایلوت");
    await entity.getByLabel("وضعیت").selectOption("active");
    await submitEntity(page);
    const goal = page.locator(".goal-panel").filter({ hasText: "آماده‌سازی پایلوت" });
    await goal.getByRole("button", { name: "نقطهٔ عطف" }).click();
    await entity.getByLabel("عنوان نقطهٔ عطف").fill("تحویل نمونه");
    await entity.getByLabel("همین حالا تکمیل‌شده ثبت شود").check();
    await submitEntity(page);
    await expect(goal).toContainText("۱۰۰٪");

    await page.locator('.nav-item[data-view="governance"]').click();
    await page.getByRole("button", { name: "برنامه‌ریزی جلسه" }).click();
    await entity.getByLabel("عنوان جلسه").fill("جلسه تصمیم پایلوت");
    await entity.getByLabel("زمان جلسه").fill("2026-08-01T10:00");
    await entity.getByLabel("در صفحهٔ عمومی نمایش داده شود").check();
    await submitEntity(page);
    const meeting = page.locator(".meeting-panel").filter({ hasText: "جلسه تصمیم پایلوت" });
    await meeting.getByRole("button", { name: "مدیریت حضور" }).click();
    await entity.locator('select[name="stakeholderId"]').selectOption({
      label: "سرمایه‌گذار آزمون الف · سرمایه‌گذار"
    });
    await entity.getByLabel("وضعیت حضور").selectOption("present");
    await submitEntity(page, "ثبت حضور");
    await expect(meeting).toContainText("حاضر");
    await meeting.getByRole("button", { name: "افزودن مصوبه" }).click();
    await entity.getByLabel("عنوان مصوبه").fill("تصویب آغاز پایلوت");
    await entity.getByLabel("وضعیت").selectOption("open");
    await entity.getByLabel("مصوبه عمومی باشد").check();
    await submitEntity(page);
    await meeting.getByRole("button", { name: "ثبت رأی" }).click();
    await entity.locator('select[name="stakeholderId"]').selectOption({
      label: "سرمایه‌گذار آزمون الف · سرمایه‌گذار"
    });
    await entity.locator('select[name="choice"]').selectOption("yes");
    await submitEntity(page, "ثبت رأی");
    await expect(meeting).toContainText("۱ نفر");

    await page.locator("#projectSwitcher").selectOption(initialProjectValue);
    await expect(page.locator("#projectSwitcher")).toHaveValue(initialProjectValue);
    await page.locator("#projectSwitcher").selectOption({ label: "پروژه آزمون سبد" });
    await expect(page.locator("#projectSwitcher option:checked")).toHaveText("پروژه آزمون سبد");

    await page.locator('.nav-item[data-view="project"]').click();
    const publicPage = await page.context().newPage();
    await publicPage.goto("/projects/portfolio-e2e-project");
    await expect(publicPage.getByRole("heading", { level: 1 })).toContainText("پروژه آزمون سبد");
    await expect(publicPage.locator("#live-indicator")).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "بایگانی پروژه" }).click();
    await expect(publicPage).toHaveURL("/");
    await expect(publicPage.getByRole("heading", { level: 1 })).toContainText("هر پروژه");
    await publicPage.close();
    await expect(page.locator("#projectSwitcher option").filter({ hasText: "پروژه آزمون سبد — آرشیو" }))
      .toHaveCount(1);
    await page.locator("#projectSwitcher").selectOption({ label: "پروژه آزمون سبد — آرشیو" });
    await expect(page.getByRole("button", { name: "بازگردانی پروژه" })).toBeVisible();
    await page.getByRole("button", { name: "بازگردانی پروژه" }).click();
    await expect(page.locator("#projectSwitcher option:checked")).toHaveText("پروژه آزمون سبد");
  });
});
