import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  databaseInternals,
  openDatabase,
  SCHEMA_VERSION,
} from '../../src/database.js';
import { loadConfig } from '../../src/config.js';
import { startTestApplication, TEST_PASSWORD } from './helpers.js';

async function login(client) {
  const result = await client.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  return { 'X-CSRF-Token': result.data.csrfToken };
}

test('public portfolio exposes three safe project summaries and rich public detail', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const client = fixture.client();

  let result = await client.request('/api/v1/projects');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.projects.length, 3);
  assert.equal(result.data.summary.projectCount, 3);
  assert.ok(result.data.projects.every((project) => project.metrics));
  assert.ok(
    result.data.projects.every(
      (project) => !JSON.stringify(project.metrics).includes('digital-owner'),
    ),
  );

  result = await client.request('/api/v1/projects/digital-supply-network');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.industry, 'فناوری');
  assert.equal(result.data.project.sector, 'تجارت دیجیتال');
  assert.equal(result.data.project.kind, 'پلتفرم');
  assert.equal(result.data.project.stage, 'pilot');
  assert.equal(result.data.project.currency, 'IRR');
  assert.equal(result.data.project.budgetAmount, 95_000_000_000);
  assert.equal(result.data.project.valuationAmount, 180_000_000_000);
  assert.equal(result.data.project.startDate, '2026-08-01');
  assert.equal(result.data.project.isDefault, false);
  assert.ok(Array.isArray(result.data.project.capital.shareOffers));
  assert.ok(result.data.project.capital.shareOffers.length >= 1);
  assert.ok(Array.isArray(result.data.project.goals.items));
  assert.ok(Array.isArray(result.data.project.governance.meetings));
  assert.equal(
    Object.hasOwn(result.data.project.capital.shareOffers[0], 'sellerStakeholderId'),
    false,
  );
});

test('admin portfolio APIs keep projects scoped and expose dashboard modules', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);

  let result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'factory-alpha',
      title: 'Factory Alpha',
      status: 'published',
      stage: 'execution',
      currency: 'IRR',
      budgetAmount: 5_000_000,
      valuationAmount: 8_000_000,
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;

  result = await admin.request(`/api/v1/admin/projects/${projectId}/needs`, {
    method: 'POST',
    headers,
    body: {
      title: 'Production line',
      description: 'A complete production line implementation scope.',
      category: 'execution',
      targetValue: 'one line',
      requirements: 'Documented industrial delivery experience.',
    },
  });
  assert.equal(result.response.status, 201);
  const needId = result.data.need.id;
  result = await admin.request(`/api/v1/admin/projects/${projectId}/needs`);
  assert.equal(result.data.needs.length, 1);
  assert.equal(
    (await admin.request('/api/v1/admin/projects/greenhouse-20ha/needs')).data.needs.length,
    8,
  );
  const applicant = fixture.client();
  result = await applicant.request(`/api/v1/needs/${needId}/proposals`, {
    method: 'POST',
    headers: { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' },
    body: {
      applicantName: 'Factory Partner',
      mobile: '09123456789',
      contribution: 'We can deliver the complete production scope and commissioning.',
      availability: 'Within one month',
      consent: true,
      website: '',
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(
    (await admin.request(`/api/v1/admin/projects/${projectId}/proposals`))
      .data.proposals.length,
    1,
  );
  assert.equal(
    (await admin.request('/api/v1/admin/projects/greenhouse-20ha/proposals'))
      .data.proposals.length,
    0,
  );

  const createStakeholder = async (name, role) => {
    const response = await admin.request(
      `/api/v1/admin/projects/${projectId}/stakeholders`,
      {
        method: 'POST',
        headers,
        body: { name, kind: 'person', role },
      },
    );
    assert.equal(response.response.status, 201);
    return response.data.stakeholder.id;
  };
  const ownerId = await createStakeholder('Primary Owner', 'owner');
  const investorId = await createStakeholder('Second Investor', 'investor');
  const alternateInvestorId = await createStakeholder(
    'Alternate Investor',
    'investor',
  );

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes`,
    {
      method: 'POST',
      headers,
      body: {
        name: 'Common',
        symbol: 'FAC',
        authorizedUnits: 100,
        votingWeight: 1,
      },
    },
  );
  assert.equal(result.response.status, 201);
  const shareClassId = result.data.shareClass.id;

  const missingIssuanceKey = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers,
      body: { stakeholderId: ownerId, units: 80 },
    },
  );
  assert.equal(missingIssuanceKey.response.status, 400);
  assert.equal(
    missingIssuanceKey.data.error.code,
    'INVALID_IDEMPOTENCY_KEY',
  );

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      body: { stakeholderId: ownerId, units: 80 },
    },
  );
  assert.equal(result.response.status, 201);
  const issuanceEntryId = result.data.entryId;
  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      body: { stakeholderId: ownerId, units: 80 },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.idempotentReplay, true);
  assert.equal(result.data.entryId, issuanceEntryId);
  const issuanceConflict = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      body: { stakeholderId: ownerId, units: 79 },
    },
  );
  assert.equal(issuanceConflict.response.status, 409);
  assert.equal(issuanceConflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count
      FROM share_ledger
      WHERE id=? OR (
        project_id=? AND stakeholder_id=? AND entry_type='issuance'
      )
    `).get(issuanceEntryId, projectId, ownerId).count,
    1,
  );
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count
      FROM operation_receipts
      WHERE scope='share_issuance' AND project_id=?
    `).get(projectId).count,
    1,
  );

  const invalidOfferDate = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': '10000000-0000-4000-8000-000000000001',
      },
      body: {
        shareClassId,
        side: 'sell',
        sellerStakeholderId: ownerId,
        units: 1,
        unitPrice: 10,
        availableUntil: '2026-02-30',
      },
    },
  );
  assert.equal(invalidOfferDate.response.status, 400);
  assert.ok(invalidOfferDate.data.error.fields.availableUntil);

  const offerKey = '10000000-0000-4000-8000-000000000002';
  const offerBody = {
    shareClassId,
    side: 'sell',
    sellerStakeholderId: ownerId,
    buyerStakeholderId: investorId,
    units: 50,
    unitPrice: 10,
    availableUntil: new Date().toISOString().slice(0, 10),
  };
  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': offerKey,
      },
      body: offerBody,
    },
  );
  assert.equal(result.response.status, 201);
  const offerId = result.data.shareOffer.id;
  const offerReplay = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': offerKey,
      },
      body: offerBody,
    },
  );
  assert.equal(offerReplay.response.status, 200);
  assert.equal(offerReplay.data.shareOffer.id, offerId);
  assert.equal(offerReplay.data.idempotentReplay, true);
  const offerConflict = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': offerKey,
      },
      body: { ...offerBody, units: 49 },
    },
  );
  assert.equal(offerConflict.response.status, 409);
  assert.equal(offerConflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count FROM share_offers WHERE id=?
    `).get(offerId).count,
    1,
  );

  const wrongOfferCounterparty = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-transfers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': '10000000-0000-4000-8000-000000000003',
      },
      body: {
        offerId,
        shareClassId,
        fromStakeholderId: ownerId,
        toStakeholderId: alternateInvestorId,
        units: 1,
        status: 'pending',
      },
    },
  );
  assert.equal(wrongOfferCounterparty.response.status, 400);
  assert.equal(wrongOfferCounterparty.data.error.code, 'INVALID_REFERENCE');

  const transferKey = '10000000-0000-4000-8000-000000000004';
  const transferBody = {
    offerId,
    shareClassId,
    fromStakeholderId: ownerId,
    toStakeholderId: investorId,
    units: 30,
    status: 'pending',
  };
  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-transfers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': transferKey,
      },
      body: transferBody,
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.shareTransfer.priceAmount, 300);
  const transferId = result.data.shareTransfer.id;
  const transferReplay = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-transfers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': transferKey,
      },
      body: transferBody,
    },
  );
  assert.equal(transferReplay.response.status, 200);
  assert.equal(transferReplay.data.shareTransfer.id, transferId);
  const transferConflict = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-transfers`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': transferKey,
      },
      body: { ...transferBody, units: 29 },
    },
  );
  assert.equal(transferConflict.response.status, 409);
  assert.equal(transferConflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count FROM share_transfers WHERE id=?
    `).get(transferId).count,
    1,
  );

  await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers/${offerId}`,
    {
      method: 'PATCH',
      headers,
      body: { unitPrice: 11 },
    },
  );
  const stalePriceApproval = await admin.request(
    `/api/v1/admin/projects/${projectId}/share-transfers/${transferId}`,
    {
      method: 'PATCH',
      headers,
      body: { status: 'approved' },
    },
  );
  assert.equal(stalePriceApproval.response.status, 409);
  assert.equal(stalePriceApproval.data.error.code, 'OFFER_PRICE_CHANGED');
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count FROM share_ledger WHERE related_transfer_id=?
    `).get(transferId).count,
    0,
  );
  await admin.request(
    `/api/v1/admin/projects/${projectId}/share-offers/${offerId}`,
    {
      method: 'PATCH',
      headers,
      body: { unitPrice: 10 },
    },
  );

  const approvals = await Promise.all([
    admin.request(
      `/api/v1/admin/projects/${projectId}/share-transfers/${transferId}`,
      {
        method: 'PATCH',
        headers,
        body: { status: 'approved', decisionNote: 'Approved by board.' },
      },
    ),
    admin.request(
      `/api/v1/admin/projects/${projectId}/share-transfers/${transferId}`,
      {
        method: 'PATCH',
        headers,
        body: { status: 'approved', decisionNote: 'Duplicate approval request.' },
      },
    ),
  ]);
  assert.deepEqual(
    approvals.map((approval) => approval.response.status),
    [200, 200],
  );
  [result] = approvals;
  assert.equal(
    result.data.capTable.holdings.find(
      (holding) => holding.stakeholderId === investorId,
    ).units,
    30,
  );

  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count
      FROM share_ledger
      WHERE related_transfer_id=?
    `).get(transferId).count,
    2,
  );
  assert.equal(
    fixture.application.db.prepare(
      'SELECT remaining_units FROM share_offers WHERE id=?',
    ).get(offerId).remaining_units,
    20,
  );

  let financialKeySequence = 0;
  const missingFinancialKey = await admin.request(
    `/api/v1/admin/projects/${projectId}/financial-entries`,
    {
      method: 'POST',
      headers,
      body: {
        type: 'revenue',
        amount: 1,
        occurredOn: '2026-01-01',
      },
    },
  );
  assert.equal(missingFinancialKey.response.status, 400);
  assert.equal(
    missingFinancialKey.data.error.code,
    'INVALID_IDEMPOTENCY_KEY',
  );
  const financial = async (body, key = null) => admin.request(
    `/api/v1/admin/projects/${projectId}/financial-entries`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': key || `90000000-0000-4000-8000-${String(
          ++financialKeySequence,
        ).padStart(12, '0')}`,
      },
      body,
    },
  );
  await financial({
    type: 'investment',
    amount: 1_000,
    occurredOn: '2026-01-01',
    stakeholderId: investorId,
  });
  const revenueBody = {
    type: 'revenue',
    amount: 600,
    occurredOn: '2026-02-01',
  };
  const revenueKey = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const revenueEntry = await financial(revenueBody, revenueKey);
  assert.equal(revenueEntry.response.status, 201);
  const revenueReplay = await financial(revenueBody, revenueKey);
  assert.equal(revenueReplay.response.status, 200);
  assert.equal(
    revenueReplay.data.financialEntry.id,
    revenueEntry.data.financialEntry.id,
  );
  const revenueConflict = await financial(
    { ...revenueBody, amount: 601 },
    revenueKey,
  );
  assert.equal(revenueConflict.response.status, 409);
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count
      FROM operation_receipts
      WHERE scope='financial_entry' AND project_id=?
    `).get(projectId).count,
    2,
  );
  const expense = await financial({
    type: 'expense',
    amount: 200,
    occurredOn: '2026-02-02',
  });
  assert.equal(expense.response.status, 201);
  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/financial-entries/${expense.data.financialEntry.id}/reversal`,
    {
      method: 'POST',
      headers,
      body: { description: 'Incorrect expense corrected.' },
    },
  );
  assert.equal(result.response.status, 201);

  result = await admin.request(`/api/v1/admin/projects/${projectId}/goals`, {
    method: 'POST',
    headers,
    body: { title: 'Launch line', weight: 100, status: 'active' },
  });
  const goalId = result.data.goal.id;
  await admin.request(
    `/api/v1/admin/projects/${projectId}/goals/${goalId}/milestones`,
    {
      method: 'POST',
      headers,
      body: { title: 'Install', weight: 40, completed: true },
    },
  );
  await admin.request(
    `/api/v1/admin/projects/${projectId}/goals/${goalId}/milestones`,
    {
      method: 'POST',
      headers,
      body: { title: 'Commission', weight: 60, completed: false },
    },
  );

  const invalidVisibility = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Must not be created',
        scheduledAt: '2026-02-28T08:00:00.000Z',
        minutes: 'PRIVATE_STRING_BOOLEAN_MINUTES',
        publicVisible: 'false',
      },
    },
  );
  assert.equal(invalidVisibility.response.status, 400);
  const privateMeeting = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Private board meeting',
        scheduledAt: '2026-02-28T09:00:00.000Z',
        minutes: 'PRIVATE_BOOLEAN_MINUTES',
        publicVisible: false,
      },
    },
  );
  assert.equal(privateMeeting.response.status, 201);

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Board meeting',
        scheduledAt: '2026-03-01T08:00:00.000Z',
        status: 'held',
        publicVisible: true,
      },
    },
  );
  assert.equal(result.response.status, 201);
  const meetingId = result.data.meeting.id;
  const invalidResolutionVisibility = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${meetingId}/resolutions`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Must not be public',
        status: 'draft',
        publicVisible: 'false',
      },
    },
  );
  assert.equal(invalidResolutionVisibility.response.status, 400);
  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${meetingId}/resolutions`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Approve launch',
        status: 'open',
        publicVisible: true,
      },
    },
  );
  const resolutionId = result.data.resolution.id;
  const otherMeeting = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings`,
    {
      method: 'POST',
      headers,
      body: {
        title: 'Other meeting',
        scheduledAt: '2026-03-02T08:00:00.000Z',
      },
    },
  );
  const wrongMeetingVote = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${otherMeeting.data.meeting.id}/resolutions/${resolutionId}/votes`,
    {
      method: 'POST',
      headers,
      body: { stakeholderId: ownerId, choice: 'yes' },
    },
  );
  assert.equal(wrongMeetingVote.response.status, 409);
  assert.equal(wrongMeetingVote.data.error.code, 'RESOLUTION_NOT_OPEN');
  const firstVote = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${meetingId}/resolutions/${resolutionId}/votes`,
    {
      method: 'PUT',
      headers,
      body: { stakeholderId: ownerId, choice: 'yes' },
    },
  );
  assert.equal(firstVote.response.status, 200);
  await admin.request(
    `/api/v1/admin/projects/${projectId}/share-classes/${shareClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      },
      body: { stakeholderId: ownerId, units: 20 },
    },
  );
  const changedVote = await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${meetingId}/resolutions/${resolutionId}/votes`,
    {
      method: 'PUT',
      headers,
      body: { stakeholderId: ownerId, choice: 'no' },
    },
  );
  assert.equal(changedVote.data.votingPower, firstVote.data.votingPower);
  await admin.request(
    `/api/v1/admin/projects/${projectId}/meetings/${meetingId}/resolutions/${resolutionId}`,
    {
      method: 'PATCH',
      headers,
      body: {
        status: 'closed',
        publicVisible: true,
        decision: 'Launch approved with the recorded conditions.',
      },
    },
  );

  result = await admin.request(`/api/v1/admin/projects/${projectId}/dashboard`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.financial.netProfit, 600);
  assert.equal(result.data.financial.roiPercent, 60);
  assert.equal(result.data.goalProgressPercent, 40);
  assert.equal(result.data.overallProgressSource, 'goals');
  assert.ok(Array.isArray(result.data.stakeholderReturns));
  const adminPortfolio = await admin.request('/api/v1/admin/projects');
  assert.ok(adminPortfolio.data.summary.totalRevenue > 12_000_000_000);
  assert.equal(adminPortfolio.data.summary.baseCurrency, 'IRR');
  assert.equal(
    adminPortfolio.data.summary.totalRevenue,
    adminPortfolio.data.summary.byCurrency.IRR.totalRevenue,
  );
  assert.equal(
    adminPortfolio.data.projects.find((project) => project.id === projectId)
      .metrics.financial.revenue,
    600,
  );
  const publicProject = await fixture.client().request('/api/v1/projects/factory-alpha');
  assert.equal(
    JSON.stringify(publicProject.data).includes('PRIVATE_BOOLEAN_MINUTES'),
    false,
  );
  assert.equal(
    publicProject.data.project.governance.meetings[0].resolutions[0].decision,
    'Launch approved with the recorded conditions.',
  );
  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { isDefault: true },
  });
  assert.equal(result.data.project.isDefault, true);
  assert.equal(
    (await admin.request('/api/v1/admin/session')).data.projectSlug,
    'factory-alpha',
  );
  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(result.data.archived, true);
  assert.equal(
    (await fixture.client().request('/api/v1/projects/factory-alpha')).response.status,
    404,
  );
});

test('cross-project capital references are rejected before SQLite and amounts are safe integers', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);

  let result = await admin.request(
    '/api/v1/admin/projects/digital-supply-network/share-transfers',
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': '20000000-0000-4000-8000-000000000001',
      },
      body: {
        shareClassId: 'digital-common',
        fromStakeholderId: 'digital-owner',
        toStakeholderId: 'solar-owner',
        units: 1,
      },
    },
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'INVALID_STAKEHOLDER');

  result = await admin.request(
    '/api/v1/admin/projects/digital-supply-network/financial-entries',
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      body: {
        type: 'revenue',
        amount: 1.5,
        occurredOn: '2026-01-01',
      },
    },
  );
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'VALIDATION_FAILED');

  result = await admin.request(
    '/api/v1/admin/projects/digital-supply-network/financial-entries',
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
      body: {
        type: 'revenue',
        amount: 10,
        occurredOn: '2026-02-30',
      },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.occurredOn);

  const usdProject = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'usd-project',
      title: 'USD Project',
      status: 'published',
      stage: 'idea',
      currency: 'USD',
      budgetAmount: 1_000,
      valuationAmount: 2_000,
    },
  });
  assert.equal(usdProject.response.status, 201);
  const usdProjectId = usdProject.data.project.id;
  const usdRevenue = await admin.request(
    `/api/v1/admin/projects/${usdProjectId}/financial-entries`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
      body: {
        type: 'revenue',
        amount: 100,
        occurredOn: '2026-01-01',
      },
    },
  );
  assert.equal(usdRevenue.response.status, 201);
  const mixedCurrencyPortfolio = await admin.request('/api/v1/admin/projects');
  assert.equal(mixedCurrencyPortfolio.data.summary.baseCurrency, null);
  assert.equal(mixedCurrencyPortfolio.data.summary.totalRevenue, null);
  assert.equal(
    mixedCurrencyPortfolio.data.summary.byCurrency.USD.totalRevenue,
    100,
  );
  assert.ok(
    mixedCurrencyPortfolio.data.summary.byCurrency.IRR.totalRevenue > 0,
  );
});

test('expired share offers are rejected or hidden while same-day offers remain available', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      // Still July 23 in UTC, but already July 24 in Tehran.
      clock: () => new Date('2026-07-23T20:45:00.000Z'),
    },
  });
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);
  const basePath = '/api/v1/admin/projects/digital-supply-network';

  let result = await admin.request(`${basePath}/share-offers`, {
    method: 'POST',
    headers,
    body: {
      shareClassId: 'digital-common',
      side: 'sell',
      sellerStakeholderId: 'digital-owner',
      units: 1,
      unitPrice: 1,
      availableUntil: '2026-07-24',
    },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'INVALID_IDEMPOTENCY_KEY');

  result = await admin.request(`${basePath}/share-offers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '30000000-0000-4000-8000-000000000001',
    },
    body: {
      shareClassId: 'digital-common',
      side: 'sell',
      sellerStakeholderId: 'digital-owner',
      units: 1,
      unitPrice: 1,
      availableUntil: '2026-07-23',
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.availableUntil);

  result = await admin.request(
    `${basePath}/share-offers/digital-open-offer`,
    {
      method: 'PATCH',
      headers,
      body: { availableUntil: '2026-07-23' },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.availableUntil);

  fixture.application.db.prepare(`
    UPDATE share_offers
    SET available_until='2026-07-23'
    WHERE id='digital-open-offer'
  `).run();

  result = await admin.request(`${basePath}/share-offers`);
  const expiredAdminOffer = result.data.shareOffers.find(
    (offer) => offer.id === 'digital-open-offer',
  );
  assert.equal(expiredAdminOffer.expired, true);
  assert.equal(expiredAdminOffer.effectiveStatus, 'expired');

  result = await fixture.client().request(
    '/api/v1/projects/digital-supply-network',
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.project.capital.shareOffers.some(
      (offer) => offer.id === 'digital-open-offer',
    ),
    false,
  );
  const publicPortfolio = await fixture.client().request('/api/v1/projects');
  assert.equal(
    publicPortfolio.data.projects.find(
      (project) => project.id === 'digital-supply-network',
    ).metrics.counts.openShareOffers,
    0,
  );

  result = await admin.request(`${basePath}/share-transfers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '30000000-0000-4000-8000-000000000002',
    },
    body: {
      offerId: 'digital-open-offer',
      shareClassId: 'digital-common',
      fromStakeholderId: 'digital-owner',
      toStakeholderId: 'digital-investor',
      units: 1,
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'SHARE_OFFER_EXPIRED');

  result = await admin.request(`${basePath}/share-offers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '30000000-0000-4000-8000-000000000003',
    },
    body: {
      shareClassId: 'digital-common',
      side: 'sell',
      sellerStakeholderId: 'digital-owner',
      units: 1,
      unitPrice: 1,
      availableUntil: '2026-07-24',
    },
  });
  assert.equal(result.response.status, 201);
  const sameDayOfferId = result.data.shareOffer.id;
  result = await fixture.client().request(
    '/api/v1/projects/digital-supply-network',
  );
  assert.ok(result.data.project.capital.shareOffers.some(
    (offer) => offer.id === sameDayOfferId,
  ));
});

test('capital, voting, and weighted progress stay within JSON-safe aggregates', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);

  let result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'numeric-bounds',
      title: 'Numeric Bounds',
      status: 'published',
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;
  const basePath = `/api/v1/admin/projects/${projectId}`;

  const createStakeholder = async (name, role = 'investor') => {
    const created = await admin.request(`${basePath}/stakeholders`, {
      method: 'POST',
      headers,
      body: { name, kind: 'person', role },
    });
    assert.equal(created.response.status, 201);
    return created.data.stakeholder.id;
  };
  const ownerId = await createStakeholder('Maximum Owner', 'owner');
  const boardId = await createStakeholder('Independent Board', 'board');

  result = await admin.request(`${basePath}/share-classes`, {
    method: 'POST',
    headers,
    body: {
      name: 'Unsafe voting class',
      symbol: 'BAD',
      authorizedUnits: 1,
      votingWeight: Number.MAX_VALUE,
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.votingWeight);

  const createClass = async (name, symbol) => {
    const created = await admin.request(`${basePath}/share-classes`, {
      method: 'POST',
      headers,
      body: {
        name,
        symbol,
        authorizedUnits: Number.MAX_SAFE_INTEGER,
        votingWeight: 1,
      },
    });
    assert.equal(created.response.status, 201);
    return created.data.shareClass.id;
  };
  const firstClassId = await createClass('Maximum Common', 'MAX');
  const secondClassId = await createClass('Second Common', 'MAX2');

  result = await admin.request(
    `${basePath}/share-classes/${firstClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': '70000000-0000-4000-8000-000000000001',
      },
      body: {
        stakeholderId: ownerId,
        units: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  assert.equal(result.response.status, 201);
  assert.equal(result.data.capTable.totalUnits, Number.MAX_SAFE_INTEGER);

  result = await admin.request(
    `${basePath}/share-classes/${secondClassId}/issuances`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': '70000000-0000-4000-8000-000000000002',
      },
      body: { stakeholderId: ownerId, units: 1 },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.units);

  result = await admin.request(
    `${basePath}/share-classes/${firstClassId}`,
    {
      method: 'PATCH',
      headers,
      body: { votingWeight: 2 },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.votingWeight);

  result = await admin.request(`${basePath}/goals`, {
    method: 'POST',
    headers,
    body: { title: 'Unsafe goal', weight: Number.MAX_VALUE },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.weight);

  result = await admin.request(`${basePath}/goals`, {
    method: 'POST',
    headers,
    body: { title: 'Bounded goal', weight: 600_000, status: 'active' },
  });
  assert.equal(result.response.status, 201);
  const goalId = result.data.goal.id;
  result = await admin.request(`${basePath}/goals`, {
    method: 'POST',
    headers,
    body: { title: 'Aggregate overflow', weight: 500_000 },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.weight);

  result = await admin.request(`${basePath}/goals/${goalId}/milestones`, {
    method: 'POST',
    headers,
    body: { title: 'Bounded milestone', weight: 600_000, completed: false },
  });
  assert.equal(result.response.status, 201);
  result = await admin.request(`${basePath}/goals/${goalId}/milestones`, {
    method: 'POST',
    headers,
    body: { title: 'Unsafe milestone', weight: Number.MAX_VALUE },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.weight);
  result = await admin.request(`${basePath}/goals/${goalId}/milestones`, {
    method: 'POST',
    headers,
    body: { title: 'Milestone aggregate overflow', weight: 500_000 },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.weight);

  result = await admin.request(`${basePath}/meetings`, {
    method: 'POST',
    headers,
    body: {
      title: 'Maximum power meeting',
      scheduledAt: '2027-01-01T08:00:00.000Z',
    },
  });
  assert.equal(result.response.status, 201);
  const meetingId = result.data.meeting.id;
  result = await admin.request(
    `${basePath}/meetings/${meetingId}/resolutions`,
    {
      method: 'POST',
      headers,
      body: { title: 'Maximum power resolution', status: 'open' },
    },
  );
  assert.equal(result.response.status, 201);
  const resolutionId = result.data.resolution.id;
  const votePath =
    `${basePath}/meetings/${meetingId}/resolutions/${resolutionId}/votes`;
  result = await admin.request(votePath, {
    method: 'PUT',
    headers,
    body: { stakeholderId: ownerId, choice: 'yes' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.votingPower, Number.MAX_SAFE_INTEGER);
  assert.equal(result.data.tally.yes.votingPower, Number.MAX_SAFE_INTEGER);

  result = await admin.request(votePath, {
    method: 'PUT',
    headers,
    body: { stakeholderId: boardId, choice: 'yes' },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'VOTING_POWER_LIMIT_EXCEEDED');

  const dashboard = await admin.request(`${basePath}/dashboard`);
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.data.capital.totalUnits, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isFinite(dashboard.data.goalProgressPercent));
  const portfolio = await admin.request('/api/v1/admin/projects');
  assert.equal(portfolio.response.status, 200);
  assert.equal(
    portfolio.data.projects.find((project) => project.id === projectId)
      .metrics.capital.totalIssuedUnits,
    Number.MAX_SAFE_INTEGER,
  );
  const publicDetail = await fixture.client().request(
    '/api/v1/projects/numeric-bounds',
  );
  assert.equal(publicDetail.response.status, 200);
  assert.equal(
    publicDetail.data.project.capital.totalIssuedUnits,
    Number.MAX_SAFE_INTEGER,
  );
});

test('open resolutions freeze voting supply and ownership until they close', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);

  let result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'record-date-lock',
      title: 'Record Date Lock',
      status: 'published',
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;
  const basePath = `/api/v1/admin/projects/${projectId}`;
  const createStakeholder = async (name, role = 'investor') => {
    const created = await admin.request(`${basePath}/stakeholders`, {
      method: 'POST',
      headers,
      body: { name, kind: 'person', role },
    });
    assert.equal(created.response.status, 201);
    return created.data.stakeholder.id;
  };
  const ownerA = await createStakeholder('Record owner A');
  const ownerB = await createStakeholder('Record owner B');
  const zeroEquityInvestor = await createStakeholder('Zero equity investor');
  const boardMember = await createStakeholder('Independent board member', 'board');

  result = await admin.request(`${basePath}/share-classes`, {
    method: 'POST',
    headers,
    body: {
      name: 'Record Common',
      symbol: 'RCD',
      authorizedUnits: 101,
      votingWeight: 1,
    },
  });
  assert.equal(result.response.status, 201);
  const shareClassId = result.data.shareClass.id;
  const issuancePath =
    `${basePath}/share-classes/${shareClassId}/issuances`;
  result = await admin.request(issuancePath, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '71000000-0000-4000-8000-000000000001',
    },
    body: { stakeholderId: ownerA, units: 100 },
  });
  assert.equal(result.response.status, 201);

  result = await admin.request(`${basePath}/meetings`, {
    method: 'POST',
    headers,
    body: {
      title: 'Record date meeting',
      scheduledAt: '2027-02-01T08:00:00.000Z',
    },
  });
  assert.equal(result.response.status, 201);
  const meetingId = result.data.meeting.id;
  const resolutionsPath = `${basePath}/meetings/${meetingId}/resolutions`;

  const directClose = await admin.request(resolutionsPath, {
    method: 'POST',
    headers,
    body: { title: 'Cannot start closed', status: 'closed' },
  });
  assert.equal(directClose.response.status, 409);
  assert.equal(directClose.data.error.code, 'INVALID_STATUS_TRANSITION');

  result = await admin.request(resolutionsPath, {
    method: 'POST',
    headers,
    body: { title: 'Locked ownership vote', status: 'open' },
  });
  assert.equal(result.response.status, 201);
  const resolutionId = result.data.resolution.id;
  const resolutionPath = `${resolutionsPath}/${resolutionId}`;
  const votePath = `${resolutionPath}/votes`;
  result = await admin.request(votePath, {
    method: 'PUT',
    headers,
    body: { stakeholderId: ownerA, choice: 'yes' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.votingPower, 100);
  assert.equal(result.data.tally.yes.votingPower, 100);

  const blockedStakeholder = await admin.request(`${basePath}/stakeholders`, {
    method: 'POST',
    headers,
    body: {
      name: 'Late roster member',
      kind: 'person',
      role: 'board',
    },
  });
  assert.equal(blockedStakeholder.response.status, 409);
  assert.equal(
    blockedStakeholder.data.error.code,
    'VOTING_RECORD_DATE_LOCKED',
  );

  const contactPatch = await admin.request(
    `${basePath}/stakeholders/${zeroEquityInvestor}`,
    {
      method: 'PATCH',
      headers,
      body: {
        email: 'contact-only@example.com',
        mobile: '09123456789',
        kind: 'organization',
      },
    },
  );
  assert.equal(contactPatch.response.status, 200);
  assert.equal(contactPatch.data.stakeholder.email, 'contact-only@example.com');
  assert.equal(contactPatch.data.stakeholder.kind, 'organization');

  const blockedRole = await admin.request(
    `${basePath}/stakeholders/${zeroEquityInvestor}`,
    {
      method: 'PATCH',
      headers,
      body: { role: 'board' },
    },
  );
  assert.equal(blockedRole.response.status, 409);
  assert.equal(blockedRole.data.error.code, 'VOTING_RECORD_DATE_LOCKED');

  const blockedArchive = await admin.request(
    `${basePath}/stakeholders/${zeroEquityInvestor}`,
    {
      method: 'PATCH',
      headers,
      body: { archived: true },
    },
  );
  assert.equal(blockedArchive.response.status, 409);
  assert.equal(blockedArchive.data.error.code, 'VOTING_RECORD_DATE_LOCKED');

  const investorVote = await admin.request(votePath, {
    method: 'PUT',
    headers,
    body: { stakeholderId: zeroEquityInvestor, choice: 'yes' },
  });
  assert.equal(investorVote.response.status, 409);
  assert.equal(investorVote.data.error.code, 'NO_VOTING_POWER');

  const boardVote = await admin.request(votePath, {
    method: 'PUT',
    headers,
    body: { stakeholderId: boardMember, choice: 'abstain' },
  });
  assert.equal(boardVote.response.status, 200);
  assert.equal(boardVote.data.votingPower, 1);
  assert.equal(boardVote.data.tally.abstain.votingPower, 1);

  const backward = await admin.request(resolutionPath, {
    method: 'PATCH',
    headers,
    body: { status: 'draft' },
  });
  assert.equal(backward.response.status, 409);
  assert.equal(backward.data.error.code, 'INVALID_STATUS_TRANSITION');

  const weightPatch = await admin.request(
    `${basePath}/share-classes/${shareClassId}`,
    {
      method: 'PATCH',
      headers,
      body: { votingWeight: 2 },
    },
  );
  assert.equal(weightPatch.response.status, 409);
  assert.equal(weightPatch.data.error.code, 'VOTING_RECORD_DATE_LOCKED');

  const blockedIssuance = await admin.request(issuancePath, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '71000000-0000-4000-8000-000000000002',
    },
    body: { stakeholderId: ownerB, units: 1 },
  });
  assert.equal(blockedIssuance.response.status, 409);
  assert.equal(
    blockedIssuance.data.error.code,
    'VOTING_RECORD_DATE_LOCKED',
  );

  result = await admin.request(`${basePath}/share-transfers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '71000000-0000-4000-8000-000000000003',
    },
    body: {
      shareClassId,
      fromStakeholderId: ownerA,
      toStakeholderId: ownerB,
      units: 100,
      status: 'pending',
    },
  });
  assert.equal(result.response.status, 201);
  const transferId = result.data.shareTransfer.id;
  const transferPath = `${basePath}/share-transfers/${transferId}`;
  const blockedApproval = await admin.request(transferPath, {
    method: 'PATCH',
    headers,
    body: { status: 'approved' },
  });
  assert.equal(blockedApproval.response.status, 409);
  assert.equal(
    blockedApproval.data.error.code,
    'VOTING_RECORD_DATE_LOCKED',
  );
  assert.equal(
    fixture.application.db.prepare(
      'SELECT status FROM share_transfers WHERE id=?',
    ).get(transferId).status,
    'pending',
  );

  result = await admin.request(resolutionPath, {
    method: 'PATCH',
    headers,
    body: { status: 'closed', decision: 'Recorded with the original cap table.' },
  });
  assert.equal(result.response.status, 200);

  const reopen = await admin.request(resolutionPath, {
    method: 'PATCH',
    headers,
    body: { status: 'open' },
  });
  assert.equal(reopen.response.status, 409);
  assert.equal(reopen.data.error.code, 'INVALID_STATUS_TRANSITION');

  result = await admin.request(
    `${basePath}/stakeholders/${zeroEquityInvestor}`,
    {
      method: 'PATCH',
      headers,
      body: { role: 'board' },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.data.stakeholder.role, 'board');
  result = await admin.request(
    `${basePath}/stakeholders/${zeroEquityInvestor}`,
    {
      method: 'PATCH',
      headers,
      body: { archived: true },
    },
  );
  assert.equal(result.response.status, 200);
  assert.ok(result.data.stakeholder.archivedAt);
  result = await admin.request(`${basePath}/stakeholders`, {
    method: 'POST',
    headers,
    body: {
      name: 'Post-close roster member',
      kind: 'person',
      role: 'board',
    },
  });
  assert.equal(result.response.status, 201);

  result = await admin.request(transferPath, {
    method: 'PATCH',
    headers,
    body: { status: 'approved' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.shareTransfer.status, 'approved');
  assert.equal(
    result.data.capTable.holdings.find(
      (holding) => holding.stakeholderId === ownerB,
    ).units,
    100,
  );
  assert.equal(
    result.data.capTable.holdings.some(
      (holding) => holding.stakeholderId === ownerA,
    ),
    false,
  );

  const storedVote = fixture.application.db.prepare(`
    SELECT voting_power
    FROM resolution_votes
    WHERE resolution_id=? AND stakeholder_id=?
  `).get(resolutionId, ownerA);
  assert.equal(storedVote.voting_power, 100);
});

test('share offer and transfer writes roll back when their audit event fails', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);
  const basePath = '/api/v1/admin/projects/digital-supply-network';

  const offerCount = () => fixture.application.db.prepare(`
    SELECT COUNT(*) AS count
    FROM share_offers
    WHERE project_id='digital-supply-network'
  `).get().count;
  const transferCount = () => fixture.application.db.prepare(`
    SELECT COUNT(*) AS count
    FROM share_transfers
    WHERE project_id='digital-supply-network'
  `).get().count;

  const beforeOfferCreate = offerCount();
  fixture.application.db.exec(`
    CREATE TRIGGER test_reject_offer_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.resource_type='share_offer'
    BEGIN SELECT RAISE(ABORT, 'forced offer audit failure'); END;
  `);
  let result = await admin.request(`${basePath}/share-offers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '40000000-0000-4000-8000-000000000001',
    },
    body: {
      shareClassId: 'digital-common',
      side: 'sell',
      sellerStakeholderId: 'digital-owner',
      units: 5,
      unitPrice: 10,
      availableUntil: '2027-01-01',
    },
  });
  assert.equal(result.response.status, 500);
  assert.equal(offerCount(), beforeOfferCreate);
  fixture.application.db.exec('DROP TRIGGER test_reject_offer_audit');

  result = await admin.request(`${basePath}/share-offers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '40000000-0000-4000-8000-000000000002',
    },
    body: {
      shareClassId: 'digital-common',
      side: 'sell',
      sellerStakeholderId: 'digital-owner',
      units: 5,
      unitPrice: 10,
      availableUntil: '2027-01-01',
    },
  });
  assert.equal(result.response.status, 201);
  const offerId = result.data.shareOffer.id;
  fixture.application.db.exec(`
    CREATE TRIGGER test_reject_offer_patch_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.resource_type='share_offer'
    BEGIN SELECT RAISE(ABORT, 'forced offer patch audit failure'); END;
  `);
  result = await admin.request(`${basePath}/share-offers/${offerId}`, {
    method: 'PATCH',
    headers,
    body: { unitPrice: 99 },
  });
  assert.equal(result.response.status, 500);
  assert.equal(
    fixture.application.db.prepare(
      'SELECT unit_price FROM share_offers WHERE id=?',
    ).get(offerId).unit_price,
    10,
  );
  fixture.application.db.exec('DROP TRIGGER test_reject_offer_patch_audit');

  const beforeTransferCreate = transferCount();
  fixture.application.db.exec(`
    CREATE TRIGGER test_reject_transfer_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.resource_type='share_transfer'
    BEGIN SELECT RAISE(ABORT, 'forced transfer audit failure'); END;
  `);
  result = await admin.request(`${basePath}/share-transfers`, {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': '40000000-0000-4000-8000-000000000003',
    },
    body: {
      offerId,
      shareClassId: 'digital-common',
      fromStakeholderId: 'digital-owner',
      toStakeholderId: 'digital-investor',
      units: 1,
      status: 'pending',
    },
  });
  assert.equal(result.response.status, 500);
  assert.equal(transferCount(), beforeTransferCreate);
  fixture.application.db.exec('DROP TRIGGER test_reject_transfer_audit');
});

test('financial bounds stay exact, permit reversals, and report unavailable ROI', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date('2026-07-24T12:00:00.000Z'),
    },
  });
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);
  let result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'financial-bounds',
      title: 'Financial Bounds',
      status: 'published',
      currency: 'XTS',
    },
  });
  const projectId = result.data.project.id;
  const financialPath =
    `/api/v1/admin/projects/${projectId}/financial-entries`;
  const postRevenue = (amount, occurredOn, key) => admin.request(financialPath, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': key },
    body: { type: 'revenue', amount, occurredOn },
  });

  result = await postRevenue(
    Number.MAX_SAFE_INTEGER,
    '2026-01-01',
    '50000000-0000-4000-8000-000000000001',
  );
  assert.equal(result.response.status, 201);
  const firstId = result.data.financialEntry.id;

  const rejectedOverflow = await postRevenue(
    1,
    '2026-01-02',
    '50000000-0000-4000-8000-000000000002',
  );
  assert.equal(rejectedOverflow.response.status, 400);
  assert.ok(rejectedOverflow.data.error.fields.amount);

  result = await admin.request(`${financialPath}/${firstId}/reversal`, {
    method: 'POST',
    headers,
    body: { occurredOn: '2026-02-01' },
  });
  assert.equal(result.response.status, 201);

  result = await postRevenue(
    Number.MAX_SAFE_INTEGER,
    '2026-01-03',
    '50000000-0000-4000-8000-000000000003',
  );
  assert.equal(result.response.status, 201);
  const secondId = result.data.financialEntry.id;
  result = await admin.request(`${financialPath}/${secondId}/reversal`, {
    method: 'POST',
    headers,
    body: { occurredOn: '2026-02-02' },
  });
  assert.equal(result.response.status, 201);

  result = await postRevenue(
    1,
    '2026-01-04',
    '50000000-0000-4000-8000-000000000004',
  );
  assert.equal(result.response.status, 201);

  const dashboard = await admin.request(
    `/api/v1/admin/projects/${projectId}/dashboard`,
  );
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.data.financial.revenue, 1);
  assert.equal(dashboard.data.financial.roi, null);
  assert.equal(dashboard.data.financial.roiPercent, null);
  const january = dashboard.data.financial.periods.find(
    (period) => period.period === '2026-01',
  );
  assert.equal(january.revenue, null);
  assert.equal(january.overflow, true);
  assert.equal(january.exact.revenue, '18014398509481983');

  const publicDetail = await fixture.client().request(
    '/api/v1/projects/financial-bounds',
  );
  assert.equal(publicDetail.response.status, 200);
  assert.equal(publicDetail.data.project.financial.revenue, 1);
  assert.equal(publicDetail.data.project.financial.roiPercent, null);
  const publicPortfolio = await fixture.client().request('/api/v1/projects');
  const project = publicPortfolio.data.projects.find(
    (item) => item.id === projectId,
  );
  assert.equal(project.metrics.financial.revenue, 1);
  assert.equal(project.metrics.financial.roiPercent, null);
});

test('platform contracts reject coerced booleans and invalid calendar values', async (t) => {
  const fixture = await startTestApplication({
    applicationOptions: {
      clock: () => new Date('2026-07-24T12:00:00.000Z'),
    },
  });
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);

  let result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'coerced-default',
      title: 'Coerced Default',
      isDefault: 'false',
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.isDefault);

  result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'invalid-project-date',
      title: 'Invalid Project Date',
      startDate: '2026-02-30',
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.startDate);

  result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'contract-validation',
      title: 'Contract Validation',
      startDate: '2026-02-28',
      targetDate: '2026-12-31',
      isDefault: false,
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;
  assert.equal(result.data.project.startDate, '2026-02-28');

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { isDefault: 'false' },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.isDefault);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { archived: 'false' },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.archived);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { archived: true, isDefault: true },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.isDefault);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { archived: true },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.status, 'draft');
  assert.equal(result.data.project.isDefault, false);
  assert.ok(result.data.project.archivedAt);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { isDefault: true },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'ARCHIVED_PROJECT_DEFAULT');

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { archived: false },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.archivedAt, null);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { targetDate: '2026-04-31' },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.targetDate);

  result = await admin.request(`/api/v1/admin/projects/${projectId}/goals`, {
    method: 'POST',
    headers,
    body: {
      title: 'Invalid due date',
      dueDate: '2026-02-30',
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.dueDate);

  result = await admin.request(`/api/v1/admin/projects/${projectId}/goals`, {
    method: 'POST',
    headers,
    body: {
      title: 'Valid goal',
      dueDate: '2026-08-01',
    },
  });
  assert.equal(result.response.status, 201);
  const goalId = result.data.goal.id;

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/goals/${goalId}/milestones`,
    {
      method: 'POST',
      headers,
      body: { title: 'Coerced milestone', completed: 'false' },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.completed);

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/goals/${goalId}/milestones`,
    {
      method: 'POST',
      headers,
      body: { title: 'Valid milestone', completed: false },
    },
  );
  assert.equal(result.response.status, 201);
  const milestoneId = result.data.milestone.id;
  assert.equal(result.data.milestone.completed, false);

  result = await admin.request(
    `/api/v1/admin/projects/${projectId}/goals/${goalId}/milestones/${milestoneId}`,
    {
      method: 'PATCH',
      headers,
      body: { completed: 'false' },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.completed);

  result = await admin.request(`/api/v1/admin/projects/${projectId}/meetings`, {
    method: 'POST',
    headers,
    body: {
      title: 'Impossible meeting',
      scheduledAt: '2026-02-30T08:00:00.000Z',
    },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.scheduledAt);

  result = await admin.request(`/api/v1/admin/projects/${projectId}/meetings`, {
    method: 'POST',
    headers,
    body: {
      title: 'Canonical meeting',
      scheduledAt: '2026-07-24T15:30:00+03:30',
    },
  });
  assert.equal(result.response.status, 201);
  assert.equal(
    result.data.meeting.scheduledAt,
    '2026-07-24T12:00:00.000Z',
  );

  result = await admin.request(
    '/api/v1/admin/projects/digital-supply-network/stakeholders/digital-owner',
    {
      method: 'PATCH',
      headers,
      body: { archived: 'false' },
    },
  );
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.archived);

  const portfolio = await admin.request('/api/v1/admin/projects');
  const defaultProject = portfolio.data.projects.find(
    (project) => project.isDefault,
  );
  const peerProject = portfolio.data.projects.find(
    (project) => project.id !== defaultProject.id && !project.archivedAt,
  );
  fixture.application.db.exec('DROP INDEX projects_single_active');
  fixture.application.db.prepare(
    'UPDATE projects SET active=1 WHERE id IN (?,?)',
  ).run(defaultProject.id, peerProject.id);
  result = await admin.request(
    `/api/v1/admin/projects/${defaultProject.id}`,
    {
      method: 'PATCH',
      headers,
      body: { isDefault: true },
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(
    fixture.application.db.prepare(
      'SELECT COUNT(*) AS count FROM projects WHERE active=1',
    ).get().count,
    1,
  );
  assert.equal(result.data.project.isDefault, true);
});

test('admin session survives an empty portfolio and reserved current slugs are rejected', async (t) => {
  const fixture = await startTestApplication({ seed: false });
  t.after(fixture.close);
  const admin = fixture.client();

  let result = await admin.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.projectSlug, null);
  const headers = { 'X-CSRF-Token': result.data.csrfToken };

  result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: { slug: 'current', title: 'Reserved Current' },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.slug);

  result = await admin.request('/api/v1/admin/projects', {
    method: 'POST',
    headers,
    body: {
      slug: 'restorable-project',
      title: 'Restorable Project',
      status: 'published',
      isDefault: true,
    },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.data.project.id;

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { slug: 'current' },
  });
  assert.equal(result.response.status, 400);
  assert.ok(result.data.error.fields.slug);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(result.response.status, 200);

  result = await admin.request('/api/v1/admin/session');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.projectSlug, null);

  result = await admin.request('/api/v1/admin/projects?includeArchived=true');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.projects.length, 1);
  assert.ok(result.data.projects[0].archivedAt);

  result = await admin.request(`/api/v1/admin/projects/${projectId}`, {
    method: 'PATCH',
    headers,
    body: { archived: false },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.archivedAt, null);

  result = await admin.request('/api/v1/admin/session');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.projectSlug, 'restorable-project');
});

test('project rename, unpublish, and archive notify the relevant SSE room', async (t) => {
  const events = [];
  const broker = {
    publish(slug, event, data) {
      events.push({ slug, event, data });
      return 0;
    },
    close() {},
  };
  const fixture = await startTestApplication({
    applicationOptions: { broker },
  });
  t.after(fixture.close);
  const admin = fixture.client();
  const headers = await login(admin);
  const portfolio = await admin.request('/api/v1/admin/projects');
  const project = portfolio.data.projects.find(
    (item) => item.slug === 'digital-supply-network',
  );

  let result = await admin.request(`/api/v1/admin/projects/${project.id}`, {
    method: 'PATCH',
    headers,
    body: { slug: 'digital-network-renamed' },
  });
  assert.equal(result.response.status, 200);
  assert.ok(events.some(
    (entry) =>
      entry.slug === 'digital-supply-network' &&
      entry.data.reason === 'project-renamed' &&
      entry.data.movedTo === 'digital-network-renamed',
  ));
  assert.ok(events.some(
    (entry) =>
      entry.slug === 'digital-network-renamed' &&
      entry.data.reason === 'project-updated',
  ));

  result = await admin.request(`/api/v1/admin/projects/${project.id}`, {
    method: 'PATCH',
    headers,
    body: { status: 'draft' },
  });
  assert.equal(result.response.status, 200);
  assert.ok(events.some(
    (entry) =>
      entry.slug === 'digital-network-renamed' &&
      entry.data.reason === 'project-unpublished' &&
      entry.data.unavailable === true,
  ));

  result = await admin.request(`/api/v1/admin/projects/${project.id}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(result.response.status, 200);
  assert.ok(events.some(
    (entry) =>
      entry.slug === 'digital-network-renamed' &&
      entry.data.reason === 'project-archived' &&
      entry.data.unavailable === true,
  ));
});

test('schema 7 databases upgrade incrementally to the latest schema without losing rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-v7-'));
  const databasePath = join(directory, 'v7.db');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects(
        id TEXT PRIMARY KEY, slug TEXT, title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', leader_name TEXT NOT NULL DEFAULT '',
        leader_description TEXT NOT NULL DEFAULT '', timeline TEXT NOT NULL DEFAULT '',
        process_description TEXT NOT NULL DEFAULT '', target_date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'published', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE project_stakeholders(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, role TEXT NOT NULL, mobile TEXT, email TEXT,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE share_classes(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        symbol TEXT NOT NULL, authorized_units INTEGER NOT NULL,
        voting_weight REAL NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE share_ledger(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_class_id TEXT NOT NULL,
        stakeholder_id TEXT NOT NULL, entry_type TEXT NOT NULL, units INTEGER NOT NULL,
        related_transfer_id TEXT, note TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE share_transfers(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_class_id TEXT NOT NULL,
        from_stakeholder_id TEXT NOT NULL, to_stakeholder_id TEXT NOT NULL,
        units INTEGER NOT NULL, price_amount INTEGER, status TEXT NOT NULL,
        note TEXT, decision_note TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE TABLE financial_entries(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL,
        amount INTEGER NOT NULL, occurred_on TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', stakeholder_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE project_goals(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', weight REAL NOT NULL,
        status TEXT NOT NULL, due_date TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE goal_milestones(
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, title TEXT NOT NULL,
        weight REAL NOT NULL, completed_at TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_meetings(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        scheduled_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
        minutes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE meeting_attendees(
        meeting_id TEXT NOT NULL, stakeholder_id TEXT NOT NULL,
        attendance TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(meeting_id,stakeholder_id)
      );
      CREATE TABLE meeting_resolutions(
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE resolution_votes(
        id TEXT PRIMARY KEY, resolution_id TEXT NOT NULL, stakeholder_id TEXT NOT NULL,
        choice TEXT NOT NULL, voting_power REAL NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(resolution_id,stakeholder_id)
      );
      INSERT INTO projects(
        id,slug,title,created_at,updated_at
      ) VALUES('kept','kept','Kept project','2026-01-01','2026-01-01');
      INSERT INTO projects(
        id,slug,title,created_at,updated_at
      ) VALUES('duplicate-default','duplicate-default','Second project','2026-02-01','2026-02-01');
      PRAGMA user_version=7;
    `);
  } finally {
    legacy.close();
  }

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  const upgraded = openDatabase(config, { seed: false, bootstrap: false });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(upgraded.prepare('SELECT title FROM projects WHERE id=?').get('kept').title, 'Kept project');
    assert.equal(
      upgraded.prepare('SELECT COUNT(*) AS count FROM projects WHERE active=1').get().count,
      1,
    );
    assert.ok(
      upgraded.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name='currency'`).get(),
    );
    assert.ok(
      upgraded.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name='industry'`).get(),
    );
    assert.ok(
      upgraded.prepare(`SELECT 1 FROM pragma_table_info('projects') WHERE name='archived_at'`).get(),
    );
    assert.ok(
      upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='share_offers'`).get(),
    );
    assert.ok(
      upgraded.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='operation_receipts'
      `).get(),
    );
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('latest schema repairs defaults, ledgers, reversals, and immutable guards from schema 8', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-v8-repair-'));
  const databasePath = join(directory, 'v8.db');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects(
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE share_ledger(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        share_class_id TEXT NOT NULL,
        stakeholder_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        units INTEGER NOT NULL,
        related_transfer_id TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE share_transfers(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        share_class_id TEXT NOT NULL,
        from_stakeholder_id TEXT NOT NULL,
        to_stakeholder_id TEXT NOT NULL,
        units INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE share_offers(
        id TEXT PRIMARY KEY,
        available_until TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE financial_entries(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        occurred_on TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        stakeholder_id TEXT,
        created_at TEXT NOT NULL,
        reversal_of_entry_id TEXT
      );
      CREATE TABLE audit_events(
        id INTEGER PRIMARY KEY,
        details TEXT
      );
      INSERT INTO projects(id,slug,title,active,archived_at,created_at)
      VALUES
        ('active-old','active-old','Old active',1,NULL,'2026-01-01'),
        ('active-new','active-new','New active',1,NULL,'2026-02-01'),
        ('archived-active','archived-active','Archived active',1,'2026-03-01','2025-01-01'),
        ('reserved-current','current','Reserved slug',0,NULL,'2026-04-01');
      INSERT INTO share_ledger(
        id,project_id,share_class_id,stakeholder_id,entry_type,units,
        related_transfer_id,note,created_at
      ) VALUES
        ('issue','active-old','common','owner','issuance',100,NULL,NULL,'2026-01-01'),
        ('out-a','active-new','wrong-class','owner','transfer_out',-20,'transfer-1',NULL,'2026-02-01'),
        ('out-b','active-old','common','wrong-party','transfer_out',-30,'transfer-1',NULL,'2026-02-02'),
        ('pending-out','active-old','common','owner','transfer_out',-50,'transfer-2',NULL,'2026-03-01'),
        ('pending-in','active-old','common','buyer','transfer_in',50,'transfer-2',NULL,'2026-03-01'),
        ('orphan-related','active-old','common','owner','transfer_out',-5,'missing-transfer',NULL,'2026-03-02');
      INSERT INTO share_transfers(
        id,project_id,share_class_id,from_stakeholder_id,to_stakeholder_id,
        units,status,note,decision_note,created_at,updated_at,decided_at
      ) VALUES
        ('transfer-1','active-old','common','owner','buyer',30,'approved',NULL,'approved','2026-02-01','2026-02-03','2026-02-03'),
        ('transfer-2','active-old','common','owner','buyer',50,'pending',NULL,NULL,'2026-03-01','2026-03-01',NULL),
        ('transfer-3','active-old','common','buyer','third',10,'approved',NULL,'approved','2026-04-01','2026-04-02','2026-04-02');
      INSERT INTO share_offers(id,available_until,status)
      VALUES
        ('legacy-offer','2027-12-31T23:59:59.000Z','open'),
        ('invalid-legacy-offer','not-a-date','open'),
        ('impossible-legacy-offer','2026-02-30','open'),
        ('filled-invalid-offer','not-a-date','filled');
      INSERT INTO financial_entries(
        id,project_id,type,amount,occurred_on,description,stakeholder_id,
        created_at,reversal_of_entry_id
      ) VALUES
        ('finance-original','active-old','revenue',100,'2026-01-01','original','owner','2026-01-01',NULL),
        ('reversal-a','active-new','expense',999,'2026-02-01','first reversal','buyer','2026-02-01','finance-original'),
        ('reversal-b','active-old','investment',777,'2026-02-02','duplicate reversal','third','2026-02-02','finance-original'),
        ('orphan-reversal','active-old','revenue',50,'2026-02-03','orphan','owner','2026-02-03','missing-original');
      INSERT INTO audit_events(id,details) VALUES(1,'kept');
      CREATE TRIGGER share_ledger_no_update
        BEFORE UPDATE ON share_ledger
        BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;
      CREATE TRIGGER share_ledger_no_delete
        BEFORE DELETE ON share_ledger
        BEGIN SELECT RAISE(ABORT, 'share ledger is immutable'); END;
      CREATE TRIGGER financial_entries_no_update
        BEFORE UPDATE ON financial_entries
        BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
      CREATE TRIGGER financial_entries_no_delete
        BEFORE DELETE ON financial_entries
        BEGIN SELECT RAISE(ABORT, 'financial entries are immutable'); END;
      PRAGMA user_version=8;
    `);
  } finally {
    legacy.close();
  }

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  const upgraded = openDatabase(config, { seed: false, bootstrap: false });
  try {
    assert.equal(
      upgraded.prepare('PRAGMA user_version').get().user_version,
      SCHEMA_VERSION,
    );
    assert.deepEqual(
      upgraded.prepare(`
        SELECT id
        FROM projects
        WHERE active=1
        ORDER BY id
      `).all().map((row) => row.id),
      ['active-old'],
    );
    assert.equal(
      upgraded.prepare(
        `SELECT active FROM projects WHERE id='archived-active'`,
      ).get().active,
      0,
    );
    assert.equal(
      upgraded.prepare(`SELECT COUNT(*) AS count FROM projects WHERE slug='current'`)
        .get().count,
      0,
    );
    assert.equal(
      upgraded.prepare(`SELECT slug FROM projects WHERE id='reserved-current'`)
        .get().slug,
      'current-project',
    );
    assert.equal(
      upgraded.prepare(`
        SELECT COUNT(*) AS count
        FROM share_ledger
        WHERE related_transfer_id='transfer-1'
      `).get().count,
      2,
    );
    assert.deepEqual(
      upgraded.prepare(`
        SELECT
          project_id,
          share_class_id,
          stakeholder_id,
          entry_type,
          units
        FROM share_ledger
        WHERE related_transfer_id='transfer-1'
        ORDER BY entry_type
      `).all().map((row) => ({ ...row })),
      [
        {
          project_id: 'active-old',
          share_class_id: 'common',
          stakeholder_id: 'buyer',
          entry_type: 'transfer_in',
          units: 30,
        },
        {
          project_id: 'active-old',
          share_class_id: 'common',
          stakeholder_id: 'owner',
          entry_type: 'transfer_out',
          units: -30,
        },
      ],
    );
    assert.equal(
      upgraded.prepare(`
        SELECT COUNT(*) AS count
        FROM share_ledger
        WHERE related_transfer_id IN ('transfer-2','missing-transfer')
      `).get().count,
      0,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT COUNT(*) AS count
        FROM share_ledger
        WHERE related_transfer_id='transfer-3'
      `).get().count,
      2,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT SUM(units) AS units
        FROM share_ledger
        WHERE stakeholder_id='owner'
      `).get().units,
      70,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT SUM(units) AS units
        FROM share_ledger
        WHERE stakeholder_id='buyer'
      `).get().units,
      20,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT SUM(units) AS units
        FROM share_ledger
        WHERE stakeholder_id='third'
      `).get().units,
      10,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT SUM(units) AS units
        FROM share_ledger
      `).get().units,
      100,
    );
    assert.equal(
      upgraded.prepare(`
        SELECT available_until
        FROM share_offers
        WHERE id='legacy-offer'
      `).get().available_until,
      '2027-12-31',
    );
    assert.deepEqual(
      upgraded.prepare(`
        SELECT id, available_until, status
        FROM share_offers
        WHERE id IN (
          'invalid-legacy-offer',
          'impossible-legacy-offer',
          'filled-invalid-offer'
        )
        ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        {
          id: 'filled-invalid-offer',
          available_until: null,
          status: 'filled',
        },
        {
          id: 'impossible-legacy-offer',
          available_until: null,
          status: 'cancelled',
        },
        {
          id: 'invalid-legacy-offer',
          available_until: null,
          status: 'cancelled',
        },
      ],
    );
    assert.equal(
      upgraded.prepare(`PRAGMA index_list('projects')`).all().find(
        (index) => index.name === 'projects_single_active',
      ).unique,
      1,
    );
    assert.equal(
      upgraded.prepare(`PRAGMA index_list('share_ledger')`).all().find(
        (index) => index.name === 'share_ledger_transfer_entry_once',
      ).unique,
      1,
    );
    assert.equal(
      upgraded.prepare(`PRAGMA index_list('financial_entries')`).all().find(
        (index) => index.name === 'financial_reversal_once',
      ).unique,
      1,
    );
    assert.deepEqual(
      {
        ...upgraded.prepare(`
          SELECT
            id,
            project_id,
            type,
            amount,
            stakeholder_id,
            reversal_of_entry_id
          FROM financial_entries
          WHERE reversal_of_entry_id='finance-original'
        `).get(),
      },
      {
        id: 'reversal-a',
        project_id: 'active-old',
        type: 'revenue',
        amount: 100,
        stakeholder_id: 'owner',
        reversal_of_entry_id: 'finance-original',
      },
    );
    assert.equal(
      upgraded.prepare(`
        SELECT COUNT(*) AS count
        FROM financial_entries
        WHERE id IN ('reversal-b','orphan-reversal')
      `).get().count,
      0,
    );
    assert.ok(
      upgraded.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='operation_receipts'
      `).get(),
    );
    assert.throws(
      () => upgraded.prepare(`
        UPDATE share_ledger SET note='changed' WHERE id='issue'
      `).run(),
      /immutable/,
    );
    assert.throws(
      () => upgraded.prepare(`
        INSERT INTO share_ledger(
          id,project_id,share_class_id,stakeholder_id,entry_type,units,
          related_transfer_id,note,created_at
        ) VALUES(
          'out-c','active-old','common','owner','transfer_out',-30,
          'transfer-1',NULL,'2026-02-03'
        )
      `).run(),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => upgraded.prepare(`
        UPDATE financial_entries SET amount=1 WHERE id='finance-original'
      `).run(),
      /immutable/,
    );
    assert.throws(
      () => upgraded.prepare(`
        DELETE FROM audit_events WHERE id=1
      `).run(),
      /immutable/,
    );
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 10 installations receive the authoritative schema 11 repair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-v10-repair-'));
  const databasePath = join(directory, 'v10.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  openDatabase(config, { seed: true, bootstrap: false }).close();

  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      DROP TRIGGER share_ledger_no_update;
      DROP TRIGGER share_ledger_no_delete;
      DROP INDEX share_ledger_transfer_entry_once;
      UPDATE share_transfers
      SET status='approved', decided_at='2026-07-01T00:00:00.000Z'
      WHERE id='digital-pending-transfer';
      INSERT INTO share_ledger(
        id,project_id,share_class_id,stakeholder_id,entry_type,units,
        related_transfer_id,note,created_at
      ) VALUES(
        'v10-wrong-ledger','solar-industrial-park','solar-common',
        'solar-owner','transfer_out',-1,'digital-pending-transfer',
        NULL,'2026-07-01'
      );

      DROP TRIGGER financial_entries_no_update;
      DROP TRIGGER financial_entries_no_delete;
      DROP INDEX financial_reversal_once;
      INSERT INTO financial_entries(
        id,project_id,type,amount,occurred_on,description,stakeholder_id,
        created_at,reversal_of_entry_id
      ) VALUES
        ('v10-reversal-a','solar-industrial-park','expense',1,'2026-07-01',
         'wrong first',NULL,'2026-07-01','digital-revenue-seed'),
        ('v10-reversal-b','digital-supply-network','investment',2,'2026-07-02',
         'duplicate',NULL,'2026-07-02','digital-revenue-seed');
      PRAGMA user_version=10;
    `);
  } finally {
    legacy.close();
  }

  const upgraded = openDatabase(config, { seed: false, bootstrap: false });
  try {
    assert.equal(
      upgraded.prepare('PRAGMA user_version').get().user_version,
      SCHEMA_VERSION,
    );
    assert.deepEqual(
      upgraded.prepare(`
        SELECT
          project_id,share_class_id,stakeholder_id,entry_type,units
        FROM share_ledger
        WHERE related_transfer_id='digital-pending-transfer'
        ORDER BY entry_type
      `).all().map((row) => ({ ...row })),
      [
        {
          project_id: 'digital-supply-network',
          share_class_id: 'digital-common',
          stakeholder_id: 'digital-investor',
          entry_type: 'transfer_in',
          units: 10000,
        },
        {
          project_id: 'digital-supply-network',
          share_class_id: 'digital-common',
          stakeholder_id: 'digital-owner',
          entry_type: 'transfer_out',
          units: -10000,
        },
      ],
    );
    assert.deepEqual(
      {
        ...upgraded.prepare(`
          SELECT id,project_id,type,amount,reversal_of_entry_id
          FROM financial_entries
          WHERE reversal_of_entry_id='digital-revenue-seed'
        `).get(),
      },
      {
        id: 'v10-reversal-a',
        project_id: 'digital-supply-network',
        type: 'revenue',
        amount: 12_000_000_000,
        reversal_of_entry_id: 'digital-revenue-seed',
      },
    );
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 11 blocks unsafe legacy financial aggregates deterministically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hamkari-v10-overflow-'));
  const databasePath = join(directory, 'v10-overflow.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: databasePath,
    SESSION_SECRET: 'test-session-secret-that-is-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'test-admin-password',
  });
  openDatabase(config, { seed: true, bootstrap: false }).close();

  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      DROP TRIGGER financial_entries_no_update;
      DROP TRIGGER financial_entries_no_delete;
      INSERT INTO financial_entries(
        id,project_id,type,amount,occurred_on,description,stakeholder_id,
        created_at,reversal_of_entry_id
      ) VALUES
        ('overflow-a','digital-supply-network','revenue',9007199254740991,
         '2026-08-01','legacy overflow',NULL,'2026-08-01',NULL),
        ('overflow-b','digital-supply-network','revenue',9007199254740991,
         '2026-08-02','legacy overflow',NULL,'2026-08-02',NULL);
      PRAGMA user_version=10;
    `);
    assert.throws(
      () => databaseInternals.applyMigrations(legacy),
      /Migration 11 blocked: project digital-supply-network .*safe integer range/,
    );
    assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 10);
  } finally {
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 11 blocks unsafe legacy capital, voting, and weight aggregates', () => {
  const cases = [
    {
      name: 'capital',
      mutate: `
        DROP TRIGGER share_ledger_no_update;
        DROP TRIGGER share_ledger_no_delete;
        INSERT INTO share_classes(
          id,project_id,name,symbol,authorized_units,voting_weight,created_at
        ) VALUES(
          'legacy-max-class','digital-supply-network','Legacy maximum','LMX',
          9007199254740991,1,'2026-08-01'
        );
        INSERT INTO share_ledger(
          id,project_id,share_class_id,stakeholder_id,entry_type,units,
          related_transfer_id,note,created_at
        ) VALUES(
          'legacy-max-issuance','digital-supply-network','legacy-max-class',
          'digital-owner','issuance',9007199254740991,NULL,NULL,'2026-08-01'
        );
      `,
      expected: /Migration 11 blocked: project digital-supply-network .*safe integer range/,
    },
    {
      name: 'voting',
      mutate: `
        UPDATE share_classes
        SET voting_weight=1.7976931348623157e308
        WHERE id='digital-common';
      `,
      expected: /Migration 11 blocked: share class digital-common .*voting weight/,
    },
    {
      name: 'goal-weight',
      mutate: `
        UPDATE project_goals
        SET weight=1.7976931348623157e308
        WHERE id='digital-pilot-goal';
      `,
      expected: /Migration 11 blocked: goal digital-pilot-goal .*weight/,
    },
    {
      name: 'vote-power',
      mutate: `
        UPDATE resolution_votes
        SET voting_power=1.7976931348623157e308
        WHERE id=(
          SELECT id FROM resolution_votes ORDER BY id LIMIT 1
        );
      `,
      expected: /Migration 11 blocked: resolution .*voting power/,
    },
  ];

  for (const scenario of cases) {
    const directory = mkdtempSync(
      join(tmpdir(), `hamkari-v10-${scenario.name}-overflow-`),
    );
    const databasePath = join(directory, 'legacy.db');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: databasePath,
      SESSION_SECRET:
        'test-session-secret-that-is-longer-than-thirty-two-characters',
      ADMIN_DEV_PASSWORD: 'test-admin-password',
    });
    openDatabase(config, { seed: true, bootstrap: false }).close();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`${scenario.mutate} PRAGMA user_version=10;`);
      assert.throws(
        () => databaseInternals.applyMigrations(legacy),
        scenario.expected,
      );
      assert.equal(
        legacy.prepare('PRAGMA user_version').get().user_version,
        10,
      );
    } finally {
      legacy.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
