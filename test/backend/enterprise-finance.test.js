import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/database.js';
import { loadConfig } from '../../src/config.js';
import { createPasswordHash, hashToken } from '../../src/security.js';
import { createEnterpriseFinanceStore } from '../../src/enterprise-finance-store.js';
import { routeEnterpriseFinanceApi } from '../../src/enterprise-finance-routes.js';
import { createOperationsStore } from '../../src/operations-store.js';
import { createPlatformStore } from '../../src/platform-store.js';

const CLOCK_VALUE = new Date('2026-07-24T12:00:00.000Z');
const actor = Object.freeze({
  userId: null,
  organizationId: 'default-organization',
  permissions: ['*'],
  legacy: true,
});

function fixture({ holders = [['holder-a', 2], ['holder-b', 1]], audit } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'enterprise-finance-test-secret-that-is-long-enough',
    ADMIN_PASSWORD_HASH: createPasswordHash('enterprise-test-password', {
      salt: Buffer.from('0123456789abcdef').toString('base64url'),
    }),
  });
  const db = openDatabase(config, { seed: false, bootstrap: true });
  const project = db.prepare(`
    SELECT id, organization_id, currency FROM projects LIMIT 1
  `).get();
  const createdAt = '2026-01-01T00:00:00.000Z';
  const insertStakeholder = db.prepare(`
    INSERT INTO project_stakeholders(
      id, project_id, name, kind, role, mobile, email,
      archived_at, created_at, updated_at
    ) VALUES(?,?,?,'person','owner',NULL,NULL,NULL,?,?)
  `);
  const insertLedger = db.prepare(`
    INSERT INTO share_ledger(
      id, project_id, share_class_id, stakeholder_id, entry_type,
      units, related_transfer_id, note, created_at
    ) VALUES(?,?,?,?, 'issuance', ?,NULL,NULL,?)
  `);
  db.prepare(`
    INSERT INTO share_classes(
      id, project_id, name, symbol, authorized_units, voting_weight, created_at
    ) VALUES('common-class',?,'Common','COM',1000,1,?)
  `).run(project.id, createdAt);
  for (const [holderId, units] of holders) {
    insertStakeholder.run(
      holderId,
      project.id,
      holderId,
      createdAt,
      createdAt,
    );
    insertLedger.run(
      `ledger-${holderId}`,
      project.id,
      'common-class',
      holderId,
      units,
      createdAt,
    );
  }
  const auditEvents = [];
  const store = createEnterpriseFinanceStore(db, {
    clock: () => new Date(CLOCK_VALUE),
    audit: audit || ((event) => auditEvents.push(event)),
  });
  const operationsStore = createOperationsStore(db, {
    clock: () => new Date(CLOCK_VALUE),
    audit: audit || ((event) => auditEvents.push(event)),
  });
  const platformStore = createPlatformStore(db, {
    clock: () => new Date(CLOCK_VALUE),
    financeStore: store,
    operationsStore,
  });
  return {
    db,
    projectId: project.id,
    organizationId: project.organization_id,
    store,
    operationsStore,
    platformStore,
    auditEvents,
    close: () => db.close(),
  };
}

function enableCorporateGovernancePolicy(f) {
  const createdAt = '2026-07-01T00:00:00.000Z';
  const users = [
    { id: 'capital-creator', email: 'capital-creator@example.test', role: 'owner' },
    { id: 'capital-approver', email: 'capital-approver@example.test', role: 'admin' },
  ];
  const insertUser = f.db.prepare(`
    INSERT INTO users(
      id, email, password_hash, full_name, status,
      password_changed_at, created_at, updated_at
    ) VALUES(?,?,? ,?,'active',?,?,?)
  `);
  const insertMembership = f.db.prepare(`
    INSERT INTO organization_memberships(
      id, organization_id, user_id, role_key, status,
      joined_at, created_at, updated_at
    ) VALUES(?,?,?,?,'active',?,?,?)
  `);
  for (const user of users) {
    insertUser.run(
      user.id,
      user.email,
      'test-password-hash',
      user.id,
      createdAt,
      createdAt,
      createdAt,
    );
    insertMembership.run(
      `membership-${user.id}`,
      f.organizationId,
      user.id,
      user.role,
      createdAt,
      createdAt,
      createdAt,
    );
  }
  return {
    creator: {
      actorType: 'user',
      userId: 'capital-creator',
      organizationId: f.organizationId,
      permissions: ['*'],
    },
    approver: {
      actorType: 'user',
      userId: 'capital-approver',
      organizationId: f.organizationId,
      permissions: ['*'],
    },
  };
}

function insertGovernanceResolution(
  f,
  {
    id,
    projectId = f.projectId,
    meetingStatus = 'held',
    resolutionStatus = 'closed',
    outcome = 'approved',
    quorumMet = true,
    operationScope,
  },
) {
  const createdAt = '2026-07-01T00:00:00.000Z';
  const meetingId = `meeting-${id}`;
  f.db.prepare(`
    INSERT INTO project_meetings(
      id, project_id, title, scheduled_at, location, minutes, status,
      created_at, updated_at, public_visible, record_date,
      quorum_percent, quorum_met
    ) VALUES(?,?,?,'2026-07-01T10:00:00.000Z','','',?,?,?,0,
             '2026-07-01',50,?)
  `).run(
    meetingId,
    projectId,
    meetingId,
    meetingStatus,
    createdAt,
    createdAt,
    quorumMet ? 1 : 0,
  );
  const result = {
    outcome,
    quorumMet,
    quorum: { quorumMet },
  };
  const scope = operationScope || {
    version: 1,
    operationType: 'corporate_action',
    actionType: 'split',
    projectId,
    shareClassId: 'common-class',
    fromStakeholderId: null,
    toStakeholderId: null,
    stakeholderId: null,
    destinationShareClassId: null,
    units: null,
    amount: null,
    currency: 'IRR',
    ratioNumerator: 2,
    ratioDenominator: 1,
    recordDate: null,
    effectiveDate: null,
  };
  f.db.prepare(`
    INSERT INTO meeting_resolutions(
      id, meeting_id, title, description, status, created_at, updated_at,
      public_visible, result_json, operation_type, operation_scope_json,
      operation_request_hash
    ) VALUES(?,?,?,'',?,?,?,0,?,'corporate_action',?,?)
  `).run(
    id,
    meetingId,
    id,
    resolutionStatus,
    createdAt,
    createdAt,
    JSON.stringify(result),
    JSON.stringify(scope),
    hashToken(JSON.stringify(scope)),
  );
  return id;
}

function insertSecondProject(f, id = 'other-capital-project') {
  const createdAt = '2026-07-01T00:00:00.000Z';
  f.db.prepare(`
    INSERT INTO projects(
      id, slug, title, status, active, created_at, updated_at,
      organization_id, currency, code
    ) VALUES(?,?,?,'draft',0,?,?,?,?,?)
  `).run(
    id,
    id,
    id,
    createdAt,
    createdAt,
    f.organizationId,
    'IRR',
    id,
  );
  return id;
}

function splitCorporateActionInput(resolutionId, extra = {}) {
  return {
    actionType: 'split',
    title: 'Two for one governed split',
    shareClassId: 'common-class',
    ratioNumerator: 2,
    ratioDenominator: 1,
    resolutionId,
    ...extra,
  };
}

function accountingSetup(f) {
  const fiscalPeriod = f.store.createFiscalPeriod(f.projectId, {
    name: 'FY 2026',
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
  }, { actor }).fiscalPeriod;
  const create = (code, name, accountType, extra = {}) => f.store.createAccount(
    f.projectId,
    { code, name, accountType, ...extra },
    { actor },
  ).account;
  return {
    fiscalPeriod,
    cash: create('1000', 'Cash', 'asset'),
    receivable: create('1100', 'Receivable', 'asset'),
    payable: create('2100', 'Payable', 'liability'),
    equity: create('3000', 'Equity', 'equity', { systemKey: 'capital' }),
    retained: create('3100', 'Retained earnings', 'equity', {
      systemKey: 'retained',
    }),
    revenue: create('4000', 'Revenue', 'revenue'),
    expense: create('5000', 'Expense', 'expense'),
  };
}

test('double-entry journals enforce balance, period locks, immutability and idempotent reversal', () => {
  const f = fixture();
  try {
    const a = accountingSetup(f);
    assert.throws(
      () => f.store.createJournalDraft(f.projectId, {
        occurredOn: '2026-07-01',
        fiscalPeriodId: a.fiscalPeriod.id,
        description: 'unbalanced',
        lines: [
          { accountId: a.cash.id, debit: 100, credit: 0 },
          { accountId: a.revenue.id, debit: 0, credit: 99 },
        ],
      }, { actor, idempotencyKey: 'journal-unbalanced-key' }),
      (error) => error.code === 'UNBALANCED_JOURNAL',
    );

    const input = {
      occurredOn: '2026-07-01',
      fiscalPeriodId: a.fiscalPeriod.id,
      description: 'sale',
      lines: [
        { accountId: a.cash.id, debit: 600, credit: 0 },
        { accountId: a.revenue.id, debit: 0, credit: 600 },
      ],
    };
    let result = f.store.createJournalDraft(
      f.projectId,
      input,
      { actor, idempotencyKey: 'journal-sale-key' },
    );
    const journalId = result.journalEntry.id;
    result = f.store.createJournalDraft(
      f.projectId,
      input,
      { actor, idempotencyKey: 'journal-sale-key' },
    );
    assert.equal(result.idempotentReplay, true);
    assert.equal(result.journalEntry.id, journalId);
    assert.throws(
      () => f.store.createJournalDraft(f.projectId, {
        ...input,
        description: 'different',
      }, { actor, idempotencyKey: 'journal-sale-key' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );

    const posted = f.store.postJournal(f.projectId, journalId, { actor });
    assert.equal(posted.journalEntry.status, 'posted');
    assert.throws(
      () => f.db.prepare(`
        UPDATE journal_lines SET debit=1 WHERE journal_entry_id=? AND debit>0
      `).run(journalId),
      /posted journal is immutable/,
    );
    const trial = f.store.trialBalance(f.projectId);
    assert.equal(trial.totalDebit, 600);
    assert.equal(trial.totalCredit, 600);
    assert.equal(trial.balanced, true);
    assert.equal(f.store.profitAndLoss(f.projectId).netIncome, 600);

    const reversal = f.store.reverseJournal(f.projectId, journalId, {
      occurredOn: '2026-07-02',
      fiscalPeriodId: a.fiscalPeriod.id,
      description: 'reverse sale',
    }, { actor, idempotencyKey: 'journal-reversal-key' });
    assert.equal(reversal.journalEntry.status, 'posted');
    assert.equal(reversal.journalEntry.reversalOfId, journalId);
    assert.equal(f.store.profitAndLoss(f.projectId).netIncome, 0);
    assert.equal(f.store.trialBalance(f.projectId).totalDebit, 1200);
    assert.equal(
      f.store.reverseJournal(f.projectId, journalId, {
        occurredOn: '2026-07-02',
        fiscalPeriodId: a.fiscalPeriod.id,
        description: 'reverse sale',
      }, { actor, idempotencyKey: 'journal-reversal-key' }).idempotentReplay,
      true,
    );

    f.store.setFiscalPeriodStatus(
      f.projectId,
      a.fiscalPeriod.id,
      'closed',
      { actor },
    );
    const draft = f.store.createJournalDraft(f.projectId, {
      occurredOn: '2026-08-01',
      fiscalPeriodId: a.fiscalPeriod.id,
      description: 'cannot post',
      lines: [
        { accountId: a.cash.id, debit: 1, credit: 0 },
        { accountId: a.revenue.id, debit: 0, credit: 1 },
      ],
    }, { actor, idempotencyKey: 'closed-period-draft' });
    assert.throws(
      () => f.store.postJournal(f.projectId, draft.journalEntry.id, { actor }),
      (error) => error.code === 'FISCAL_PERIOD_CLOSED',
    );
  } finally {
    f.close();
  }
});

test('audit failure rolls the financial mutation back atomically', () => {
  let shouldFail = true;
  const f = fixture({
    audit: () => {
      if (shouldFail) throw new Error('forced audit failure');
    },
  });
  try {
    assert.throws(
      () => f.store.createAccount(f.projectId, {
        code: '1000',
        name: 'Cash',
        accountType: 'asset',
      }, { actor }),
      /forced audit failure/,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM accounting_accounts').get().count,
      0,
    );
    shouldFail = false;
    assert.equal(
      f.store.createAccount(f.projectId, {
        code: '1000',
        name: 'Cash',
        accountType: 'asset',
      }, { actor }).account.code,
      '1000',
    );
  } finally {
    f.close();
  }
});

test('invoice and manual payment post exactly once and reject forged provider verification', () => {
  const f = fixture();
  try {
    const a = accountingSetup(f);
    const input = {
      kind: 'receivable',
      invoiceNo: 'INV-001',
      counterpartyName: 'Buyer',
      issuedOn: '2026-07-01',
      dueOn: '2026-07-15',
      subtotal: 1000,
      taxAmount: 100,
      discountAmount: 50,
      debitAccountId: a.receivable.id,
      creditAccountId: a.revenue.id,
      fiscalPeriodId: a.fiscalPeriod.id,
    };
    const issued = f.store.issueInvoice(
      f.projectId,
      input,
      { actor, idempotencyKey: 'invoice-001-key' },
    );
    assert.equal(issued.invoice.totalAmount, 1050);
    assert.equal(issued.invoice.status, 'issued');
    assert.equal(
      f.store.issueInvoice(
        f.projectId,
        input,
        { actor, idempotencyKey: 'invoice-001-key' },
      ).idempotentReplay,
      true,
    );
    assert.throws(
      () => f.store.createPaymentIntent(f.projectId, {
        invoiceId: issued.invoice.id,
        amount: 1050,
        provider: 'manual',
        providerVerified: true,
      }, { actor, idempotencyKey: 'forged-payment-key' }),
      (error) => error.code === 'PROVIDER_VERIFICATION_NOT_ACCEPTED',
    );
    assert.throws(
      () => f.store.createPaymentIntent(f.projectId, {
        invoiceId: issued.invoice.id,
        amount: 1050,
        provider: 'sandbox',
      }, { actor, idempotencyKey: 'disabled-sandbox-payment-key' }),
      (error) => error.code === 'PAYMENT_PROVIDER_DISABLED',
    );
    const payment = f.store.createPaymentIntent(f.projectId, {
      invoiceId: issued.invoice.id,
      amount: 1050,
      provider: 'manual',
    }, { actor, idempotencyKey: 'payment-001-key' });
    assert.equal(payment.paymentIntent.purposeType, 'invoice');
    assert.equal(payment.paymentIntent.purposeId, issued.invoice.id);
    const confirmation = {
      providerEventId: 'manual-bank-event-001',
      manualReference: 'BANK-REFERENCE-001',
      cashAccountId: a.cash.id,
      occurredOn: '2026-07-02',
      fiscalPeriodId: a.fiscalPeriod.id,
    };
    let confirmed = f.store.confirmPayment(
      f.projectId,
      payment.paymentIntent.id,
      confirmation,
      { actor },
    );
    assert.equal(confirmed.paymentIntent.status, 'succeeded');
    assert.equal(confirmed.invoice.status, 'paid');
    assert.equal(confirmed.invoice.paidAmount, 1050);
    assert.throws(
      () => f.db.prepare(`
        UPDATE payment_intents
        SET purpose_type='share_transfer',purpose_id='forged-transfer'
        WHERE id=?
      `).run(payment.paymentIntent.id),
      /payment purpose is immutable/,
    );
    assert.throws(
      () => f.platformStore.createShareTransfer(
        f.projectId,
        {
          shareClassId: 'common-class',
          fromStakeholderId: 'holder-a',
          toStakeholderId: 'holder-b',
          units: 1,
          priceAmount: 1_050,
          status: 'draft',
          paymentIntentId: payment.paymentIntent.id,
        },
        'invoice-payment-cannot-fund-transfer',
      ),
      (error) => error.code === 'SHARE_TRANSFER_PAYMENT_INVALID',
    );
    confirmed = f.store.confirmPayment(
      f.projectId,
      payment.paymentIntent.id,
      confirmation,
      { actor },
    );
    assert.equal(confirmed.idempotentReplay, true);
    assert.equal(
      f.db.prepare(`
        SELECT COUNT(*) AS count
        FROM journal_entries
        WHERE project_id=? AND source_type='payment'
      `).get(f.projectId).count,
      1,
    );
  } finally {
    f.close();
  }
});

test('share-transfer payment purpose is immutable and source-bound at creation', () => {
  const f = fixture();
  try {
    const transfer = f.platformStore.createShareTransfer(
      f.projectId,
      {
        shareClassId: 'common-class',
        fromStakeholderId: 'holder-a',
        toStakeholderId: 'holder-b',
        units: 1,
        priceAmount: 250,
        status: 'draft',
      },
      'purpose-bound-transfer',
    ).shareTransfer;
    const payment = f.store.createPaymentIntent(f.projectId, {
      direction: 'incoming',
      amount: 250,
      provider: 'manual',
      purposeType: 'share_transfer',
      purposeId: transfer.id,
    }, { actor, idempotencyKey: 'purpose-bound-payment' }).paymentIntent;
    assert.equal(payment.purposeType, 'share_transfer');
    assert.equal(payment.purposeId, transfer.id);
    assert.match(payment.purposeHash, /^[A-Za-z0-9_-]{43}$/);
    assert.throws(
      () => f.db.prepare(`
        UPDATE payment_intents SET purpose_id='another-transfer' WHERE id=?
      `).run(payment.id),
      /payment purpose is immutable/,
    );
  } finally {
    f.close();
  }
});

test('distribution preview uses deterministic largest remainder and pays allocations atomically', () => {
  const f = fixture();
  try {
    const a = accountingSetup(f);
    const preview = f.store.createDistributionPreview(f.projectId, {
      title: 'Dividend',
      recordDate: '2026-01-02',
      totalAmount: 10,
    }, { actor }).distribution;
    assert.deepEqual(
      preview.allocations.map((item) => [item.stakeholderId, item.eligibleUnits, item.amount]),
      [
        ['holder-a', 2, 7],
        ['holder-b', 1, 3],
      ],
    );
    assert.equal(
      preview.allocations.reduce((sum, item) => sum + item.amount, 0),
      preview.totalAmount,
    );
    const approved = f.store.approveDistribution(f.projectId, preview.id, {
      retainedEarningsAccountId: a.retained.id,
      payableAccountId: a.payable.id,
      occurredOn: '2026-07-01',
      fiscalPeriodId: a.fiscalPeriod.id,
    }, { actor });
    assert.equal(approved.distribution.status, 'approved');
    for (const stakeholderId of ['holder-a', 'holder-b']) {
      let kyc = f.store.createKycCase(f.projectId, {
        subjectType: 'stakeholder',
        subjectId: stakeholderId,
        level: 'enhanced',
        provider: 'manual',
      }, { actor }).kycCase;
      kyc = f.store.addKycCheck(f.projectId, kyc.id, {
        checkType: 'identity-document',
        status: 'passed',
        result: { matched: true },
      }, { actor }).kycCase;
      f.store.reviewKycCase(f.projectId, kyc.id, {
        status: 'verified',
        riskRating: 'low',
        expiresAt: '2027-07-24',
      }, { actor });
    }
    assert.throws(
      () => f.store.payDistribution(f.projectId, preview.id, {
        provider: 'manual',
        manualReference: 'DIVIDEND-BATCH-OVERRIDE',
        requireVerifiedKyc: false,
        payableAccountId: a.payable.id,
        cashAccountId: a.cash.id,
        paidOn: '2026-07-02',
        fiscalPeriodId: a.fiscalPeriod.id,
      }, { actor }),
      (error) => error.code === 'PAYMENT_POLICY_MANAGED',
    );
    const paid = f.store.payDistribution(f.projectId, preview.id, {
      provider: 'manual',
      manualReference: 'DIVIDEND-BATCH-001',
      payableAccountId: a.payable.id,
      cashAccountId: a.cash.id,
      paidOn: '2026-07-02',
      fiscalPeriodId: a.fiscalPeriod.id,
    }, { actor });
    assert.equal(paid.distribution.status, 'paid');
    assert.ok(paid.distribution.allocations.every((item) => item.status === 'paid'));
    assert.equal(
      f.db.prepare(`
        SELECT COUNT(*) AS count FROM payment_intents
        WHERE project_id=? AND status='succeeded'
      `).get(f.projectId).count,
      2,
    );
  } finally {
    f.close();
  }
});

test('manual KYC and signatures derive status and cannot impersonate a provider', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.store.createKycCase(f.projectId, {
        subjectType: 'stakeholder',
        subjectId: 'holder-a',
        provider: 'external-provider',
        providerVerified: true,
      }, { actor }),
      (error) => error.code === 'PROVIDER_VERIFICATION_NOT_ACCEPTED',
    );
    let kyc = f.store.createKycCase(f.projectId, {
      subjectType: 'stakeholder',
      subjectId: 'holder-a',
      level: 'enhanced',
      provider: 'manual',
    }, { actor }).kycCase;
    kyc = f.store.addKycCheck(f.projectId, kyc.id, {
      checkType: 'identity-document',
      status: 'passed',
      result: { matched: true },
    }, { actor }).kycCase;
    assert.equal(kyc.status, 'in_review');
    kyc = f.store.reviewKycCase(f.projectId, kyc.id, {
      status: 'verified',
      riskRating: 'low',
      expiresAt: '2027-07-24',
    }, { actor }).kycCase;
    assert.equal(kyc.status, 'verified');

    const createdAt = CLOCK_VALUE.toISOString();
    f.db.prepare(`
      INSERT INTO documents(
        id, organization_id, project_id, title, category, visibility,
        status, current_version_no, created_at, updated_at
      ) VALUES('contract-document',?,?, 'Share contract','contract','private',
               'active',0,?,?)
    `).run(f.organizationId, f.projectId, createdAt, createdAt);
    let contract = f.store.createContract(f.projectId, {
      title: 'Share agreement',
      contractType: 'share_subscription',
      documentId: 'contract-document',
    }, { actor }).contract;
    contract = f.store.addContractParty(f.projectId, contract.id, {
      partyType: 'stakeholder',
      partyId: 'holder-a',
      displayName: 'Holder A',
      role: 'subscriber',
    }, { actor }).contract;
    contract = f.store.requestContractSignatures(
      f.projectId,
      contract.id,
      {},
      { actor },
    ).contract;
    assert.equal(contract.status, 'awaiting_signatures');
    const partyId = contract.parties[0].id;
    assert.throws(
      () => f.store.recordManualSignature(f.projectId, contract.id, partyId, {
        signatureHash: 'a'.repeat(64),
        providerVerified: true,
      }, { actor }),
      (error) => error.code === 'PROVIDER_VERIFICATION_NOT_ACCEPTED',
    );
    contract = f.store.recordManualSignature(f.projectId, contract.id, partyId, {
      signatureHash: 'a'.repeat(64),
      signedDocumentId: 'contract-document',
    }, { actor }).contract;
    assert.equal(contract.status, 'active');
    assert.equal(contract.signatures[0].status, 'signed');
  } finally {
    f.close();
  }
});

test('corporate split rejects fractions, executes atomically, and certificates cannot exceed holdings', () => {
  const fractional = fixture();
  try {
    const reverse = fractional.store.createCorporateAction(fractional.projectId, {
      actionType: 'reverse_split',
      title: 'One for two',
      shareClassId: 'common-class',
      ratioNumerator: 1,
      ratioDenominator: 2,
      recordDate: '2026-01-02',
      effectiveDate: '2026-07-24',
    }, { actor }).corporateAction;
    assert.throws(
      () => fractional.store.previewCorporateAction(fractional.projectId, reverse.id),
      (error) => error.code === 'FRACTIONAL_SHARES_NOT_SUPPORTED',
    );
  } finally {
    fractional.close();
  }

  const f = fixture({ holders: [['holder-a', 2], ['holder-b', 2]] });
  try {
    const action = f.store.createCorporateAction(f.projectId, {
      actionType: 'split',
      title: 'Two for one',
      shareClassId: 'common-class',
      ratioNumerator: 2,
      ratioDenominator: 1,
      recordDate: '2026-01-02',
      effectiveDate: '2026-07-24',
    }, { actor }).corporateAction;
    const preview = f.store.previewCorporateAction(f.projectId, action.id);
    assert.equal(preview.shareClass.issuedUnitsBefore, 4);
    assert.equal(preview.shareClass.issuedUnitsAfter, 8);
    f.store.approveCorporateAction(f.projectId, action.id, { actor });
    const executed = f.store.executeCorporateAction(f.projectId, action.id, { actor });
    assert.equal(executed.corporateAction.status, 'completed');
    assert.deepEqual(
      f.db.prepare(`
        SELECT stakeholder_id, SUM(units) AS units
        FROM share_ledger
        WHERE project_id=? AND share_class_id='common-class'
        GROUP BY stakeholder_id ORDER BY stakeholder_id
      `).all(f.projectId).map((row) => [row.stakeholder_id, Number(row.units)]),
      [['holder-a', 4], ['holder-b', 4]],
    );
    const certificate = f.store.issueCertificate(f.projectId, {
      shareClassId: 'common-class',
      stakeholderId: 'holder-a',
      units: 4,
      issuedOn: '2026-07-24',
    }, { actor }).shareCertificate;
    assert.equal(certificate.status, 'active');
    assert.throws(
      () => f.store.issueCertificate(f.projectId, {
        shareClassId: 'common-class',
        stakeholderId: 'holder-a',
        units: 1,
        issuedOn: '2026-07-24',
      }, { actor }),
      (error) => error.code === 'CERTIFICATE_EXCEEDS_HOLDING',
    );
  } finally {
    f.close();
  }
});

test('governed corporate action records two-person approval, preview hash and executor', () => {
  const f = fixture({ holders: [['holder-a', 2], ['holder-b', 2]] });
  try {
    const actors = enableCorporateGovernancePolicy(f);
    const resolutionId = insertGovernanceResolution(f, {
      id: 'capital-resolution-positive',
    });
    const created = f.store.createCorporateAction(
      f.projectId,
      splitCorporateActionInput(resolutionId),
      { actor: actors.creator },
    ).corporateAction;
    assert.equal(created.createdByUserId, actors.creator.userId);
    assert.equal(created.approvedByUserId, null);
    assert.equal(created.approvedPreviewHash, null);
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        {
          ...splitCorporateActionInput(resolutionId),
          title: 'Resolution reuse must fail',
        },
        { actor: actors.creator },
      ),
      (error) => error.code === 'RESOLUTION_ALREADY_BOUND',
    );
    assert.equal(
      f.db.prepare(`
        SELECT COUNT(*) AS count
        FROM corporate_actions
        WHERE resolution_id=?
      `).get(resolutionId).count,
      1,
    );

    const approved = f.store.approveCorporateAction(
      f.projectId,
      created.id,
      { actor: actors.approver },
    ).corporateAction;
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedByUserId, actors.approver.userId);
    assert.equal(approved.approvedAt, CLOCK_VALUE.toISOString());
    assert.match(approved.approvedPreviewHash, /^[A-Za-z0-9_-]{43}$/);

    const approvalReplay = f.store.approveCorporateAction(
      f.projectId,
      created.id,
      { actor: { actorType: 'api_key', userId: actors.approver.userId } },
    );
    assert.equal(approvalReplay.idempotentReplay, true);
    assert.equal(
      approvalReplay.corporateAction.approvedPreviewHash,
      approved.approvedPreviewHash,
    );

    const executed = f.store.executeCorporateAction(
      f.projectId,
      created.id,
      { actor: actors.approver },
    ).corporateAction;
    assert.equal(executed.status, 'completed');
    assert.equal(executed.executedByUserId, actors.approver.userId);
    assert.equal(executed.executedAt, CLOCK_VALUE.toISOString());

    const executionReplay = f.store.executeCorporateAction(
      f.projectId,
      created.id,
      { actor: { actorType: 'api_key', userId: actors.approver.userId } },
    );
    assert.equal(executionReplay.idempotentReplay, true);
  } finally {
    f.close();
  }
});

test('corporate action policy rejects missing, rejected, no-quorum and cross-project resolutions', () => {
  const f = fixture({ holders: [['holder-a', 2], ['holder-b', 2]] });
  try {
    const actors = enableCorporateGovernancePolicy(f);
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(null),
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_RESOLUTION_REQUIRED'
      ),
    );

    const rejectedId = insertGovernanceResolution(f, {
      id: 'capital-resolution-rejected',
      outcome: 'rejected',
      quorumMet: true,
    });
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(rejectedId),
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_RESOLUTION_NOT_APPROVED'
      ),
    );

    const noQuorumId = insertGovernanceResolution(f, {
      id: 'capital-resolution-no-quorum',
      outcome: 'no_quorum',
      quorumMet: false,
    });
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(noQuorumId),
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_RESOLUTION_QUORUM_REQUIRED'
      ),
    );

    const unrelatedScopeId = insertGovernanceResolution(f, {
      id: 'capital-resolution-unrelated-scope',
      operationScope: {
        version: 1,
        operationType: 'corporate_action',
        actionType: 'capital_increase',
        projectId: f.projectId,
        shareClassId: 'common-class',
        fromStakeholderId: null,
        toStakeholderId: null,
        stakeholderId: null,
        destinationShareClassId: null,
        units: 100,
        amount: null,
        currency: 'IRR',
        ratioNumerator: null,
        ratioDenominator: null,
        recordDate: null,
        effectiveDate: null,
      },
    });
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(unrelatedScopeId),
        { actor: actors.creator },
      ),
      (error) => error.code === 'CORPORATE_ACTION_RESOLUTION_SCOPE_MISMATCH',
    );

    const otherProjectId = insertSecondProject(f);
    const crossProjectId = insertGovernanceResolution(f, {
      id: 'capital-resolution-other-project',
      projectId: otherProjectId,
    });
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(crossProjectId),
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_RESOLUTION_INVALID'
      ),
    );
  } finally {
    f.close();
  }
});

test('corporate action enforces real users, four-eyes approval and creator/executor separation', () => {
  const f = fixture({ holders: [['holder-a', 2], ['holder-b', 2]] });
  try {
    const actors = enableCorporateGovernancePolicy(f);
    const resolutionId = insertGovernanceResolution(f, {
      id: 'capital-resolution-four-eyes',
    });
    assert.throws(
      () => f.store.createCorporateAction(
        f.projectId,
        splitCorporateActionInput(resolutionId),
        { actor: { actorType: 'api_key', userId: actors.creator.userId } },
      ),
      (error) => (
        error.status === 403
        && error.code === 'CORPORATE_ACTION_USER_REQUIRED'
      ),
    );

    const action = f.store.createCorporateAction(
      f.projectId,
      splitCorporateActionInput(resolutionId),
      { actor: actors.creator },
    ).corporateAction;
    assert.throws(
      () => f.store.approveCorporateAction(
        f.projectId,
        action.id,
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 403
        && error.code === 'CORPORATE_ACTION_FOUR_EYES_REQUIRED'
      ),
    );
    assert.equal(
      f.store.corporateActions(f.projectId).corporateActions
        .find((item) => item.id === action.id).status,
      'draft',
    );

    f.store.approveCorporateAction(
      f.projectId,
      action.id,
      { actor: actors.approver },
    );
    assert.throws(
      () => f.store.executeCorporateAction(
        f.projectId,
        action.id,
        { actor: { actorType: 'api_key', userId: actors.approver.userId } },
      ),
      (error) => (
        error.status === 403
        && error.code === 'CORPORATE_ACTION_USER_REQUIRED'
      ),
    );
    assert.throws(
      () => f.store.executeCorporateAction(
        f.projectId,
        action.id,
        { actor: actors.creator },
      ),
      (error) => (
        error.status === 403
        && error.code === 'CORPORATE_ACTION_EXECUTOR_SEPARATION_REQUIRED'
      ),
    );
    assert.equal(
      f.store.executeCorporateAction(
        f.projectId,
        action.id,
        { actor: actors.approver },
      ).corporateAction.status,
      'completed',
    );
  } finally {
    f.close();
  }
});

test('corporate action revalidates resolution and rejects a stale approved preview', () => {
  const f = fixture({ holders: [['holder-a', 2], ['holder-b', 2]] });
  try {
    const actors = enableCorporateGovernancePolicy(f);
    const resolutionId = insertGovernanceResolution(f, {
      id: 'capital-resolution-stale',
    });
    const action = f.store.createCorporateAction(
      f.projectId,
      splitCorporateActionInput(resolutionId),
      { actor: actors.creator },
    ).corporateAction;

    f.db.prepare(`
      UPDATE meeting_resolutions SET result_json=? WHERE id=?
    `).run(JSON.stringify({
      outcome: 'rejected',
      quorumMet: true,
      quorum: { quorumMet: true },
    }), resolutionId);
    assert.throws(
      () => f.store.approveCorporateAction(
        f.projectId,
        action.id,
        { actor: actors.approver },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_RESOLUTION_NOT_APPROVED'
      ),
    );

    f.db.prepare(`
      UPDATE meeting_resolutions SET result_json=? WHERE id=?
    `).run(JSON.stringify({
      outcome: 'approved',
      quorumMet: true,
      quorum: { quorumMet: true },
    }), resolutionId);
    f.store.approveCorporateAction(
      f.projectId,
      action.id,
      { actor: actors.approver },
    );
    f.db.prepare(`
      INSERT INTO share_ledger(
        id, project_id, share_class_id, stakeholder_id, entry_type,
        units, related_transfer_id, note, created_at
      ) VALUES('capital-after-approval',?, 'common-class','holder-a',
               'adjustment',2,NULL,'external change',
               '2026-07-24T12:00:01.000Z')
    `).run(f.projectId);
    assert.throws(
      () => f.store.executeCorporateAction(
        f.projectId,
        action.id,
        { actor: actors.approver },
      ),
      (error) => (
        error.status === 409
        && error.code === 'CORPORATE_ACTION_PREVIEW_STALE'
      ),
    );
    const current = f.store.corporateActions(f.projectId).corporateActions
      .find((item) => item.id === action.id);
    assert.equal(current.status, 'approved');
    assert.equal(current.executedByUserId, null);
    assert.equal(
      Number(f.db.prepare(`
        SELECT COUNT(*) AS count
        FROM share_ledger
        WHERE note LIKE ?
      `).get(`%${action.id}%`).count),
      0,
    );
  } finally {
    f.close();
  }
});

test('governance proxies reject cycles and quorum counts represented power once', () => {
  const f = fixture({ holders: [['holder-a', 60], ['holder-b', 40]] });
  try {
    const createdAt = '2026-07-01T09:00:00.000Z';
    const insertUser = f.db.prepare(`
      INSERT INTO users(
        id,email,password_hash,full_name,status,password_changed_at,
        created_at,updated_at
      ) VALUES(?,?,?,?,'active',?,?,?)
    `);
    const insertMembership = f.db.prepare(`
      INSERT INTO organization_memberships(
        id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
      ) VALUES(?,?,?,?,'active',?,?,?)
    `);
    for (const [userId, stakeholderId, roleKey] of [
      ['holder-a-user', 'holder-a', 'owner'],
      ['holder-b-user', 'holder-b', 'board'],
    ]) {
      insertUser.run(
        userId,
        `${userId}@example.test`,
        'test-password-hash',
        userId,
        createdAt,
        createdAt,
        createdAt,
      );
      insertMembership.run(
        `membership-${userId}`,
        f.organizationId,
        userId,
        roleKey,
        createdAt,
        createdAt,
        createdAt,
      );
      f.db.prepare(`
        UPDATE project_stakeholders
        SET user_id=?
        WHERE id=? AND project_id=?
      `).run(userId, stakeholderId, f.projectId);
    }
    const holderAActor = {
      actorType: 'user',
      userId: 'holder-a-user',
      organizationId: f.organizationId,
      permissions: ['*'],
    };
    const holderBActor = {
      actorType: 'user',
      userId: 'holder-b-user',
      organizationId: f.organizationId,
      permissions: ['*'],
    };
    f.db.prepare(`
      INSERT INTO project_meetings(
        id, project_id, title, scheduled_at, location, minutes, status,
        created_at, updated_at, public_visible, record_date, quorum_percent
      ) VALUES('meeting-1',?,'Meeting','2026-07-24T10:00:00.000Z','','',
               'scheduled',?,?,0,'2026-07-01',50)
    `).run(f.projectId, createdAt, createdAt);
    f.db.prepare(`
      INSERT INTO meeting_attendees(
        meeting_id, stakeholder_id, attendance, created_at, updated_at
      ) VALUES('meeting-1','holder-b','present',?,?)
    `).run(createdAt, createdAt);
    const proxy = f.store.createGovernanceProxy(f.projectId, {
      meetingId: 'meeting-1',
      grantorStakeholderId: 'holder-a',
      proxyStakeholderId: 'holder-b',
    }, { actor: holderAActor }).governanceProxy;
    assert.equal(proxy.votingPower, 60);
    assert.throws(
      () => f.store.createGovernanceProxy(f.projectId, {
        meetingId: 'meeting-1',
        grantorStakeholderId: 'holder-b',
        proxyStakeholderId: 'holder-a',
      }, { actor: holderBActor }),
      (error) => error.code === 'PROXY_CYCLE',
    );
    const quorum = f.store.calculateQuorum(f.projectId, 'meeting-1');
    assert.equal(quorum.eligibleVotingPower, 100);
    assert.equal(quorum.representedVotingPower, 100);
    assert.equal(quorum.quorumMet, true);
  } finally {
    f.close();
  }
});

test('manual valuations are project-scoped, idempotent, safely validated and auditable', () => {
  const f = fixture();
  try {
    const createdAt = CLOCK_VALUE.toISOString();
    f.db.prepare(`
      INSERT INTO projects(
        id, slug, title, active, created_at, updated_at,
        organization_id, currency, code
      ) VALUES(
        'other-project','other-project','Other project',0,?,?,?,'IRR','OTHER'
      )
    `).run(createdAt, createdAt, f.organizationId);
    const insertDocument = f.db.prepare(`
      INSERT INTO documents(
        id, organization_id, project_id, title, category, visibility,
        status, current_version_no, created_at, updated_at
      ) VALUES(?,?,?,'Valuation evidence','financial','private','active',0,?,?)
    `);
    insertDocument.run(
      'valuation-document',
      f.organizationId,
      f.projectId,
      createdAt,
      createdAt,
    );
    insertDocument.run(
      'other-project-document',
      f.organizationId,
      'other-project',
      createdAt,
      createdAt,
    );

    const input = {
      amount: Number.MAX_SAFE_INTEGER,
      currency: 'irr',
      valuedOn: '2026-07-23',
      description: 'Independent manual valuation',
      methodology: 'Documented income approach',
      sourceType: 'manual',
      documentId: 'valuation-document',
    };
    const created = f.store.createValuation(
      f.projectId,
      input,
      { actor, idempotencyKey: 'valuation-safe-key-001' },
    );
    assert.equal(created.idempotentReplay, false);
    assert.equal(created.valuation.amount, Number.MAX_SAFE_INTEGER);
    assert.equal(created.valuation.currency, 'IRR');
    assert.equal(created.valuation.sourceType, 'manual');
    assert.equal(created.valuation.documentId, 'valuation-document');
    assert.equal(
      f.store.createValuation(
        f.projectId,
        input,
        { actor, idempotencyKey: 'valuation-safe-key-001' },
      ).idempotentReplay,
      true,
    );
    assert.equal(
      f.db.prepare(`
        SELECT COUNT(*) AS count FROM valuation_events WHERE project_id=?
      `).get(f.projectId).count,
      1,
    );
    assert.throws(
      () => f.store.createValuation(f.projectId, {
        ...input,
        amount: 10,
      }, { actor, idempotencyKey: 'valuation-safe-key-001' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => f.store.createValuation(f.projectId, {
        ...input,
        documentId: 'other-project-document',
      }, { actor, idempotencyKey: 'valuation-cross-project-document' }),
      (error) => error.code === 'INVALID_VALUATION_DOCUMENT',
    );
    assert.throws(
      () => f.store.createValuation(f.projectId, {
        ...input,
        valuedOn: '2026-07-25',
      }, { actor, idempotencyKey: 'valuation-future-date' }),
      (error) => error.code === 'FUTURE_VALUATION_DATE',
    );
    assert.throws(
      () => f.store.createValuation(f.projectId, {
        ...input,
        sourceType: 'provider',
      }, { actor, idempotencyKey: 'valuation-forged-provider' }),
      (error) => error.code === 'VALUATION_SOURCE_NOT_SUPPORTED',
    );
    const listed = f.store.valuations(f.projectId, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    assert.equal(listed.valuations.length, 1);
    assert.equal(listed.valuations[0].id, created.valuation.id);
    assert.equal(
      f.auditEvents.filter((event) => event.resourceType === 'valuation_event').length,
      1,
    );
  } finally {
    f.close();
  }
});

test('valuation insert rolls back if its transactional audit fails', () => {
  const f = fixture({
    audit: () => {
      throw new Error('valuation audit failed');
    },
  });
  try {
    assert.throws(
      () => f.store.createValuation(f.projectId, {
        amount: 100,
        valuedOn: '2026-07-24',
        methodology: 'manual review',
      }, { actor, idempotencyKey: 'valuation-audit-rollback' }),
      /valuation audit failed/,
    );
    assert.equal(
      f.db.prepare('SELECT COUNT(*) AS count FROM valuation_events').get().count,
      0,
    );
  } finally {
    f.close();
  }
});

test('returns report uses documented ledger capital and exposes honest availability', () => {
  const f = fixture();
  try {
    const a = accountingSetup(f);
    let report = f.store.returnsReport(f.projectId, { asOf: '2026-07-24' });
    assert.equal(report.latestValuation, null);
    assert.equal(report.totalReturnRoi.available, false);
    assert.equal(report.totalReturnRoi.reason, 'NO_VALUATION');
    assert.equal(report.profitRoi.available, false);

    f.store.createValuation(f.projectId, {
      amount: 0,
      valuedOn: '2026-01-01',
      methodology: 'zero-value impairment scenario',
    }, { actor, idempotencyKey: 'valuation-zero-edge' });
    report = f.store.returnsReport(f.projectId, { asOf: '2026-07-24' });
    assert.equal(report.latestValuation.amount, 0);
    assert.equal(report.totalReturnRoi.available, false);
    assert.equal(
      report.totalReturnRoi.reason,
      'NO_DOCUMENTED_INVESTED_CAPITAL',
    );

    const capitalDraft = f.store.createJournalDraft(f.projectId, {
      occurredOn: '2026-01-01',
      fiscalPeriodId: a.fiscalPeriod.id,
      description: 'Documented paid-in capital',
      lines: [
        { accountId: a.cash.id, debit: 1000, credit: 0 },
        {
          accountId: a.equity.id,
          stakeholderId: 'holder-a',
          debit: 0,
          credit: 1000,
        },
      ],
    }, { actor, idempotencyKey: 'return-capital-journal' });
    f.store.postJournal(f.projectId, capitalDraft.journalEntry.id, { actor });
    const incomeDraft = f.store.createJournalDraft(f.projectId, {
      occurredOn: '2026-07-01',
      fiscalPeriodId: a.fiscalPeriod.id,
      description: 'Operating income',
      lines: [
        { accountId: a.cash.id, debit: 200, credit: 0 },
        { accountId: a.revenue.id, debit: 0, credit: 200 },
      ],
    }, { actor, idempotencyKey: 'return-income-journal' });
    f.store.postJournal(f.projectId, incomeDraft.journalEntry.id, { actor });
    const distribution = f.store.createDistributionPreview(f.projectId, {
      title: 'Approved dividend',
      recordDate: '2026-07-01',
      totalAmount: 100,
    }, { actor }).distribution;
    f.store.approveDistribution(f.projectId, distribution.id, {
      retainedEarningsAccountId: a.retained.id,
      payableAccountId: a.payable.id,
      occurredOn: '2026-07-24',
      fiscalPeriodId: a.fiscalPeriod.id,
    }, { actor });
    f.store.createValuation(f.projectId, {
      amount: 1500,
      valuedOn: '2026-07-24',
      methodology: 'documented terminal value',
    }, { actor, idempotencyKey: 'valuation-return-report' });

    report = f.store.returnsReport(f.projectId, { asOf: '2026-07-24' });
    assert.equal(report.latestValuation.amount, 1500);
    assert.equal(report.investedCapital, 1000);
    assert.equal(report.investedCapitalAvailability.available, true);
    assert.deepEqual(report.distributions, {
      approved: 100,
      processing: 0,
      paid: 0,
      total: 100,
    });
    assert.equal(report.netIncome, 200);
    assert.equal(report.profitRoi.available, true);
    assert.equal(report.profitRoi.value, 20);
    assert.equal(report.totalReturnRoi.available, true);
    assert.equal(report.totalReturnRoi.value, 60);
    assert.equal(report.annualizedReturn.available, true);
    assert.equal(report.annualizedReturn.estimate, true);
    const holderA = report.stakeholderReturns.find(
      (item) => item.stakeholderId === 'holder-a',
    );
    const holderB = report.stakeholderReturns.find(
      (item) => item.stakeholderId === 'holder-b',
    );
    assert.equal(holderA.investedCapital, 1000);
    assert.equal(holderA.distributions, 67);
    assert.equal(holderA.estimatedCurrentValue, 1000);
    assert.equal(holderA.totalReturnRoi.value, 6.7);
    assert.equal(holderA.estimate, true);
    assert.equal(holderB.investedCapital, 0);
    assert.equal(holderB.estimatedCurrentValue, 500);
    assert.equal(holderB.totalReturnRoi.available, false);

    f.operationsStore.createTask(f.projectId, {
      title: 'Canonical execution task',
      status: 'in_progress',
      progressPercent: 60,
      weight: 1,
    });
    f.db.prepare(`
      UPDATE projects SET status='published',visibility='public' WHERE id=?
    `).run(f.projectId);
    const dashboard = f.platformStore.dashboard(f.projectId);
    assert.equal(dashboard.financial.source, 'posted_double_entry');
    assert.equal(dashboard.financial.revenue, 200);
    assert.equal(dashboard.financial.investedCapital, 1000);
    assert.equal(dashboard.financial.netProfit, 200);
    assert.equal(dashboard.financial.roiPercent, 20);
    assert.equal(dashboard.financial.distribution, 0);
    assert.equal(dashboard.financial.distributionEntitlements, 100);
    assert.equal(dashboard.overallProgressSource, 'operations');
    assert.equal(dashboard.overallProgressPercent, 60);
    const publicSummary = f.platformStore.publicSummary(f.projectId);
    assert.equal(publicSummary.financial.revenue, 200);
    assert.equal(publicSummary.financial.investedCapital, 1000);
    assert.equal(publicSummary.overallProgressSource, 'operations');
    assert.equal(publicSummary.overallProgressPercent, 60);
  } finally {
    f.close();
  }
});

function responseRecorder() {
  return {
    statusCode: 0,
    headers: new Map(),
    writableEnded: false,
    body: '',
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(body = '') {
      this.body = body;
      this.writableEnded = true;
    },
  };
}

test('valuation and returns routes request finance read/manage permissions', async () => {
  const f = fixture();
  try {
    const calls = [];
    const authorize = async (_context, scope) => {
      calls.push(scope);
      return actor;
    };
    const baseContext = {
      config: {
        isProduction: false,
        publicOrigin: 'https://hamkari.test',
      },
      enterpriseFinanceStore: f.store,
    };

    let response = responseRecorder();
    let context = {
      ...baseContext,
      request: { method: 'GET', headers: {} },
      response,
      url: new URL(
        `/api/v2/admin/projects/${f.projectId}/valuations`,
        'https://hamkari.test',
      ),
    };
    assert.equal(await routeEnterpriseFinanceApi(context, authorize), true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      projectId: f.projectId,
      permission: 'finance.read',
      mutation: false,
    });

    response = responseRecorder();
    context = {
      ...baseContext,
      request: {
        method: 'POST',
        headers: {
          origin: 'https://hamkari.test',
          'idempotency-key': 'route-valuation-key',
        },
      },
      response,
      url: new URL(
        `/api/v2/admin/projects/${f.projectId}/valuations`,
        'https://hamkari.test',
      ),
      readJson: async () => ({
        amount: 250,
        valuedOn: '2026-07-24',
        sourceType: 'manual',
      }),
    };
    assert.equal(await routeEnterpriseFinanceApi(context, authorize), true);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(calls.at(-1), {
      projectId: f.projectId,
      permission: 'finance.manage',
      mutation: true,
    });

    response = responseRecorder();
    context = {
      ...baseContext,
      request: { method: 'GET', headers: {} },
      response,
      url: new URL(
        `/api/v2/admin/projects/${f.projectId}/reports/returns?to=2026-07-24`,
        'https://hamkari.test',
      ),
    };
    assert.equal(await routeEnterpriseFinanceApi(context, authorize), true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      projectId: f.projectId,
      permission: 'finance.read',
      mutation: false,
    });
    assert.equal(JSON.parse(response.body).latestValuation.amount, 250);
  } finally {
    f.close();
  }
});
