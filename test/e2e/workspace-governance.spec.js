import { expect, test } from "@playwright/test";
import {
  startTestApplication,
  TEST_PASSWORD,
} from "../backend/helpers.js";

const OWNER_EMAIL = "workspace-governance-owner@example.test";
const OWNER_PASSWORD = "Workspace-governance-owner-1405";
const TEST_IP = "203.0.113.191";

test.describe.serial("قرارداد رابط سرمایه و حاکمیت", () => {
  let fixture;

  test.beforeAll(async () => {
    fixture = await startTestApplication();
  });

  test.afterAll(async () => {
    await fixture?.close();
  });

  test("ذی‌نفع متصل، انتقال پیش‌نویس، مصوبه دامنه‌دار، رأی امن و پرداخت اختصاصی", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": TEST_IP });
    await page.goto(`${fixture.origin}/workspace`);

    await page.locator(".ws-legacy-login").evaluate((details) => {
      details.open = true;
    });
    await page.locator("#legacyPassword").fill(TEST_PASSWORD);
    await page.locator("#legacyLoginForm button[type=submit]").click();
    await expect(page.locator("#bootstrapDialog")).toHaveAttribute("open", "");
    await page.locator("#bootstrapForm [name=fullName]").fill("مالک تست حاکمیت");
    await page.locator("#bootstrapForm [name=organizationName]").fill("سازمان تست حاکمیت");
    await page.locator("#bootstrapForm [name=email]").fill(OWNER_EMAIL);
    await page.locator("#bootstrapForm [name=password]").fill(OWNER_PASSWORD);
    await page.locator("#bootstrapForm button[type=submit]").click();
    await expect(page.locator("#workspaceView")).toBeVisible();

    const navigate = async (view) => {
      await page.evaluate((selected) => {
        window.location.hash = `#/${selected}`;
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, view);
      await expect(page.locator("#pageBody")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(page.getByText("بارگذاری این بخش کامل نشد")).toHaveCount(0);
    };
    const submitEntity = async () => {
      await page.locator("#entityForm button[type=submit]").click();
      await expect(page.locator("#entityDialog")).not.toHaveAttribute(
        "open",
        "",
      );
    };

    const linkedName = "مالک متصل تست حاکمیت";
    const buyerName = "خریدار تست حاکمیت";
    const className = "سهام عادی تست حاکمیت";
    const classSymbol = "GOVT";
    const meetingTitle = "جلسه انتقال تست حاکمیت";
    const resolutionTitle = "تصویب انتقال ۱۰ واحد تست حاکمیت";

    await navigate("capital");
    await page.getByRole("button", { name: "ذی‌نفع جدید" }).click();
    await page.locator("#dialogFields [name=name]").fill(linkedName);
    await page.locator("#dialogFields [name=role]").selectOption("board");
    const userSelect = page.locator("#dialogFields [name=userId]");
    await expect(userSelect).toBeEnabled();
    const linkedUserId = await userSelect
      .locator("option:not([value=''])")
      .first()
      .getAttribute("value");
    expect(linkedUserId).toBeTruthy();
    await userSelect.selectOption(linkedUserId);
    await submitEntity();

    await page.getByRole("button", { name: "ذی‌نفع جدید" }).click();
    await page.locator("#dialogFields [name=kind]").selectOption("organization");
    await expect(page.locator("#dialogFields [name=userId]")).toBeDisabled();
    await page.locator("#dialogFields [name=kind]").selectOption("person");
    await expect(page.locator("#dialogFields [name=userId]")).toBeEnabled();
    await page.locator("#dialogFields [name=name]").fill(buyerName);
    await page.locator("#dialogFields [name=role]").selectOption("investor");
    await submitEntity();

    await page.getByRole("button", { name: "رده سهام", exact: true }).click();
    await page.locator("#dialogFields [name=name]").fill(className);
    await page.locator("#dialogFields [name=symbol]").fill(classSymbol);
    await page.locator("#dialogFields [name=authorizedUnits]").fill("1000");
    await submitEntity();

    await navigate("governance");
    await page.getByRole("button", { name: "جلسهٔ جدید" }).first().click();
    await page.locator("#dialogFields [name=title]").fill(meetingTitle);
    await page
      .locator("#dialogFields [name=scheduledAt]")
      .fill("2026-07-24T10:00");
    await page.locator("#dialogFields [name=status]").selectOption("held");
    await submitEntity();

    await navigate("capital");
    await page.getByRole("button", { name: "انتقال", exact: true }).click();
    await page
      .locator("#dialogFields [name=shareClassId]")
      .selectOption({ label: `${className} (${classSymbol})` });
    await page
      .locator("#dialogFields [name=fromStakeholderId]")
      .selectOption({ label: linkedName });
    await page
      .locator("#dialogFields [name=toStakeholderId]")
      .selectOption({ label: buyerName });
    await page.locator("#dialogFields [name=units]").fill("10");
    await page.locator("#dialogFields [name=priceAmount]").fill("0");
    const draftRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST"
      && request.url().endsWith("/share-transfers"));
    await submitEntity();
    const draftBody = (await draftRequestPromise).postDataJSON();
    expect(draftBody).toMatchObject({
      status: "draft",
      units: 10,
      priceAmount: 0,
    });
    expect(draftBody).not.toHaveProperty("resolutionId");
    expect(draftBody).not.toHaveProperty("contractId");
    expect(draftBody).not.toHaveProperty("paymentIntentId");

    await page.getByRole("tab", { name: "انتقال و عرضه" }).click();
    const draftRow = page
      .locator("tbody tr")
      .filter({ hasText: `${linkedName} ← ${buyerName}` })
      .filter({ hasText: "۱۰ واحد" })
      .first();
    await expect(draftRow).toContainText("پیش‌نویس");
    await draftRow.getByRole("button", { name: "ساخت مصوبه انتقال" }).click();
    const meetingSelect = page.locator("#dialogFields [name=meetingId]");
    const meetingId = await meetingSelect
      .locator("option")
      .filter({ hasText: meetingTitle })
      .getAttribute("value");
    expect(meetingId).toBeTruthy();
    await meetingSelect.selectOption(meetingId);
    await page.locator("#dialogFields [name=title]").fill(resolutionTitle);
    const resolutionRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST"
      && /\/meetings\/[^/]+\/resolutions$/.test(new URL(request.url()).pathname));
    await submitEntity();
    const resolutionBody = (await resolutionRequestPromise).postDataJSON();
    expect(resolutionBody.status).toBe("draft");
    expect(resolutionBody.operationScope).toMatchObject({
      operationType: "share_transfer",
      actionType: "share_transfer",
      units: 10,
      amount: 0,
      currency: "IRR",
    });
    expect(resolutionBody.operationScope.fromStakeholderId).toBeTruthy();
    expect(resolutionBody.operationScope.toStakeholderId).toBeTruthy();
    expect(resolutionBody.operationScope.fromStakeholderId)
      .not.toBe(resolutionBody.operationScope.toStakeholderId);

    const resolutionRow = page
      .locator("tbody tr")
      .filter({ hasText: resolutionTitle })
      .first();
    await expect(resolutionRow).toContainText("دامنه قابل ویرایش");
    await expect(resolutionRow).toContainText("انتقال ۱۰ واحد");
    page.once("dialog", (dialog) => dialog.accept());
    await resolutionRow
      .getByRole("button", { name: "بازکردن رأی‌گیری" })
      .click();

    const openedResolutionRow = page
      .locator("tbody tr")
      .filter({ hasText: resolutionTitle })
      .first();
    await openedResolutionRow.getByRole("button", { name: "ثبت رأی" }).click();
    const voterOptions = page.locator(
      "#dialogFields [name=stakeholderId] option",
    );
    await expect(voterOptions).toHaveCount(2);
    await expect(voterOptions.nth(1)).toContainText(linkedName);
    await expect(voterOptions.nth(1)).toContainText("رأی مستقیم من");
    await expect(page.locator("#dialogFields [name=stakeholderId]"))
      .not.toContainText(buyerName);
    await page.locator("#entityDialog [data-close-dialog]").last().click();

    await navigate("finance");
    await page.getByRole("button", { name: "دوره مالی" }).click();
    await page.locator("#dialogFields [name=name]").fill("دوره پرداخت تست حاکمیت");
    await page.locator("#dialogFields [name=startsOn]").fill("2035-01-01");
    await page.locator("#dialogFields [name=endsOn]").fill("2035-12-31");
    await submitEntity();

    await navigate("capital");
    await page.getByRole("button", { name: "انتقال", exact: true }).click();
    await page
      .locator("#dialogFields [name=shareClassId]")
      .selectOption({ label: `${className} (${classSymbol})` });
    await page
      .locator("#dialogFields [name=fromStakeholderId]")
      .selectOption({ label: linkedName });
    await page
      .locator("#dialogFields [name=toStakeholderId]")
      .selectOption({ label: buyerName });
    await page.locator("#dialogFields [name=units]").fill("5");
    await page.locator("#dialogFields [name=priceAmount]").fill("1000");
    const pricedTransferResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().endsWith("/share-transfers")
      && response.status() === 201);
    await submitEntity();
    const pricedTransfer = (
      await (await pricedTransferResponsePromise).json()
    ).shareTransfer;
    expect(pricedTransfer.status).toBe("draft");

    await page.getByRole("tab", { name: "انتقال و عرضه" }).click();
    const pricedRow = page
      .locator("tbody tr")
      .filter({ hasText: `${linkedName} ← ${buyerName}` })
      .filter({ hasText: "۵ واحد" })
      .first();
    const paymentRequestPromise = page.waitForRequest((request) =>
      request.method() === "POST"
      && request.url().endsWith("/payment-intents"));
    await pricedRow
      .getByRole("button", { name: "ساخت پرداخت اختصاصی" })
      .click();
    const paymentBody = (await paymentRequestPromise).postDataJSON();
    expect(paymentBody).toEqual({
      direction: "incoming",
      provider: "manual",
      amount: 1000,
      currency: "IRR",
      purposeType: "share_transfer",
      purposeId: pricedTransfer.id,
    });

    await expect(
      page.locator("#dialogFields [name=manualReference]"),
    ).toBeVisible();
    await page
      .locator("#dialogFields [name=manualReference]")
      .fill("BANK-GOVERNANCE-1000");
    await page
      .locator("#dialogFields [name=cashAccountId]")
      .selectOption({ index: 1 });
    await page
      .locator("#dialogFields [name=counterAccountId]")
      .selectOption({ index: 2 });
    await page.locator("#dialogFields [name=occurredOn]").fill("2035-01-01");
    const confirmResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/payment-intents/`)
      && response.url().endsWith("/confirm"));
    await submitEntity();
    expect((await confirmResponsePromise).status()).toBe(200);

    await page.getByRole("tab", { name: "انتقال و عرضه" }).click();
    const refreshedPricedRow = page
      .locator("tbody tr")
      .filter({ hasText: `${linkedName} ← ${buyerName}` })
      .filter({ hasText: "۵ واحد" })
      .first();
    await expect(refreshedPricedRow).toContainText(
      "پرداخت موفق و اختصاصی آماده اتصال",
    );
    await expect(
      refreshedPricedRow.getByRole("button", {
        name: "ساخت پرداخت اختصاصی",
      }),
    ).toHaveCount(0);
  });
});
