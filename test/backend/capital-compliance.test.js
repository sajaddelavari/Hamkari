import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/database.js';
import { createEnterpriseFinanceStore } from '../../src/enterprise-finance-store.js';
import { createPlatformStore } from '../../src/platform-store.js';
import { hashToken } from '../../src/security.js';

const NOW = '2026-07-24T10:00:00.000Z';
const ORGANIZATION_ID = 'default-organization';

function fixture(t) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    SESSION_SECRET: 'capital-compliance-secret-longer-than-thirty-two-characters',
    ADMIN_DEV_PASSWORD: 'capital-compliance-admin',
  });
  const db = openDatabase(config, { seed: false });
  t.after(() => db.close());
  const financeStore = createEnterpriseFinanceStore(db, {
    clock: () => new Date(NOW),
  });
  const store = createPlatformStore(db, {
    clock: () => new Date(NOW),
    financeStore,
  });
  const project = store.createProject({
    organizationId: ORGANIZATION_ID,
    slug: 'capital-compliance',
    title: 'Capital Compliance',
    status: 'published',
    currency: 'IRR',
  }).project;
  const seller = store.createStakeholder(project.id, {
    name: 'Seller',
    kind: 'person',
    role: 'owner',
  }).stakeholder;
  const buyer = store.createStakeholder(project.id, {
    name: 'Buyer',
    kind: 'person',
    role: 'investor',
  }).stakeholder;
  const shareClass = store.createShareClass(project.id, {
    name: 'Common',
    symbol: 'CMP',
    authorizedUnits: 100,
    votingWeight: 1,
  }).shareClass;
  store.issueShares(project.id, {
    shareClassId: shareClass.id,
    stakeholderId: seller.id,
    units: 10,
  }, 'capital-compliance-initial-issuance');

  const insertUser = db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,status,password_changed_at,
      created_at,updated_at
    ) VALUES(?,?,? ,?,'active',?,?,?)
  `);
  const insertMembership = db.prepare(`
    INSERT INTO organization_memberships(
      id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
    ) VALUES(?,?,?,?,'active',?,?,?)
  `);
  insertUser.run(
    'capital-maker',
    'maker@example.test',
    'not-used',
    'Capital Maker',
    NOW,
    NOW,
    NOW,
  );
  insertUser.run(
    'capital-checker',
    'checker@example.test',
    'not-used',
    'Capital Checker',
    NOW,
    NOW,
    NOW,
  );
  insertMembership.run(
    'capital-maker-membership',
    ORGANIZATION_ID,
    'capital-maker',
    'owner',
    NOW,
    NOW,
    NOW,
  );
  db.prepare(`
    UPDATE project_stakeholders SET user_id=?
    WHERE id=? AND project_id=?
  `).run('capital-maker', seller.id, project.id);
  db.prepare(`
    UPDATE project_stakeholders SET user_id=?
    WHERE id=? AND project_id=?
  `).run('capital-checker', buyer.id, project.id);
  insertMembership.run(
    'capital-checker-membership',
    ORGANIZATION_ID,
    'capital-checker',
    'admin',
    NOW,
    NOW,
    NOW,
  );

  db.prepare(`
    INSERT INTO project_meetings(
      id,project_id,title,scheduled_at,status,record_date,quorum_percent,
      quorum_met,created_at,updated_at
    ) VALUES('transfer-meeting',?,'Transfer approval',?,'held','2026-07-24',
      50,1,?,?)
  `).run(project.id, NOW, NOW, NOW);
  const transferScope = (units) => ({
    version: 1,
    operationType: 'share_transfer',
    actionType: 'share_transfer',
    projectId: project.id,
    shareClassId: shareClass.id,
    fromStakeholderId: seller.id,
    toStakeholderId: buyer.id,
    stakeholderId: null,
    destinationShareClassId: null,
    units,
    amount: 1_000,
    currency: 'IRR',
    ratioNumerator: null,
    ratioDenominator: null,
    recordDate: null,
    effectiveDate: null,
  });
  const insertResolution = db.prepare(`
    INSERT INTO meeting_resolutions(
      id,meeting_id,title,status,result_json,operation_type,
      operation_scope_json,operation_request_hash,created_at,updated_at
    ) VALUES(?,'transfer-meeting',?,'closed',?,'share_transfer',?,?,?,?)
  `);
  for (const [resolutionId, units] of [
    ['transfer-resolution', 2],
    ['transfer-resolution-two', 1],
  ]) {
    const scope = transferScope(units);
    insertResolution.run(
      resolutionId,
      `Approve transfer ${units}`,
      JSON.stringify({
      outcome: 'approved',
      quorum: { quorumMet: true },
      }),
      JSON.stringify(scope),
      hashToken(JSON.stringify(scope)),
      NOW,
      NOW,
    );
  }

  const insertKyc = db.prepare(`
    INSERT INTO kyc_cases(
      id,organization_id,project_id,subject_type,subject_id,level,provider,
      status,risk_rating,requested_at,reviewed_at,expires_at,created_at,updated_at
    ) VALUES(?,?,?,'stakeholder',?,'basic','manual','verified','low',?,?,?,?,?)
  `);
  insertKyc.run(
    'seller-kyc',
    ORGANIZATION_ID,
    project.id,
    seller.id,
    NOW,
    NOW,
    '2027-07-24',
    NOW,
    NOW,
  );
  insertKyc.run(
    'buyer-kyc',
    ORGANIZATION_ID,
    project.id,
    buyer.id,
    NOW,
    NOW,
    '2027-07-24',
    NOW,
    NOW,
  );

  db.prepare(`
    INSERT INTO contracts(
      id,organization_id,project_id,title,contract_type,status,effective_on,
      expires_on,value_amount,currency,created_at,updated_at
    ) VALUES('transfer-contract',?,?,'Signed share transfer','share_transfer',
      'active','2026-07-01','2027-07-01',1000,'IRR',?,?)
  `).run(ORGANIZATION_ID, project.id, NOW, NOW);
  const insertParty = db.prepare(`
    INSERT INTO contract_parties(
      id,contract_id,party_type,party_id,display_name,role,created_at
    ) VALUES(?,'transfer-contract','stakeholder',?,?,?,?)
  `);
  insertParty.run('seller-party', seller.id, 'Seller', 'seller', NOW);
  insertParty.run('buyer-party', buyer.id, 'Buyer', 'buyer', NOW);

  db.prepare(`
    INSERT INTO payment_intents(
      id,organization_id,project_id,direction,provider,idempotency_key_hash,
      amount,currency,status,completed_at,created_at,updated_at
    ) VALUES('transfer-payment',?,?,'incoming','manual','transfer-payment-key',
      1000,'IRR','succeeded',?,?,?)
  `).run(ORGANIZATION_ID, project.id, NOW, NOW, NOW);

  return {
    db,
    store,
    financeStore,
    project,
    seller,
    buyer,
    shareClass,
  };
}

test('enterprise share transfer requires evidence, KYC and four-eyes approval', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.store.createShareTransfer(
      f.project.id,
      {
        shareClassId: f.shareClass.id,
        fromStakeholderId: f.seller.id,
        toStakeholderId: f.buyer.id,
        units: 2,
        priceAmount: 1_000,
        status: 'draft',
      },
      'capital-compliance-api-key-rejected',
      {
        user: { id: 'capital-maker' },
        apiKey: { id: 'capital-api-key' },
        actorType: 'api_key',
      },
    ),
    (error) => error.code === 'CAPITAL_INTERACTIVE_USER_REQUIRED',
  );
  assert.throws(
    () => f.store.createShareTransfer(
      f.project.id,
      {
        shareClassId: f.shareClass.id,
        fromStakeholderId: f.seller.id,
        toStakeholderId: f.buyer.id,
        units: 2,
        priceAmount: 1_000,
        status: 'pending',
        resolutionId: 'transfer-resolution',
      },
      'capital-compliance-incomplete-pending',
      { user: { id: 'capital-maker' } },
    ),
    (error) => error.code === 'SHARE_TRANSFER_EVIDENCE_REQUIRED',
  );

  const draft = f.store.createShareTransfer(
    f.project.id,
    {
      shareClassId: f.shareClass.id,
      fromStakeholderId: f.seller.id,
      toStakeholderId: f.buyer.id,
      units: 2,
      priceAmount: 1_000,
      status: 'draft',
    },
    'capital-compliance-transfer-one',
    { user: { id: 'capital-maker' } },
  ).shareTransfer;
  const transfer = f.store.patchShareTransfer(
    f.project.id,
    draft.id,
    {
      status: 'pending',
      resolutionId: 'transfer-resolution',
      contractId: 'transfer-contract',
      paymentIntentId: 'transfer-payment',
    },
    { user: { id: 'capital-maker' } },
  ).shareTransfer;
  assert.equal(transfer.status, 'pending');

  assert.throws(
    () => f.store.patchShareTransfer(
      f.project.id,
      transfer.id,
      { status: 'approved', decisionNote: 'self approval' },
      { user: { id: 'capital-maker' } },
    ),
    (error) => error.code === 'SHARE_TRANSFER_FOUR_EYES_REQUIRED',
  );

  const approved = f.store.patchShareTransfer(
    f.project.id,
    transfer.id,
    { status: 'approved', decisionNote: 'evidence checked' },
    { user: { id: 'capital-checker' } },
  ).shareTransfer;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.createdByUserId, 'capital-maker');
  assert.equal(approved.approvedByUserId, 'capital-checker');
  assert.equal(approved.paymentIntentId, 'transfer-payment');
  assert.equal(
    f.store.capTable(f.project.id).holdings.find(
      (holding) => holding.stakeholderId === f.buyer.id,
    ).units,
    2,
  );

  assert.throws(
    () => f.store.createShareTransfer(
      f.project.id,
      {
        shareClassId: f.shareClass.id,
        fromStakeholderId: f.seller.id,
        toStakeholderId: f.buyer.id,
        units: 1,
        priceAmount: 1_000,
        status: 'pending',
        resolutionId: 'transfer-resolution-two',
        contractId: 'transfer-contract',
        paymentIntentId: 'transfer-payment',
      },
      'capital-compliance-transfer-two',
      { user: { id: 'capital-maker' } },
    ),
    (error) => error.code === 'SHARE_TRANSFER_PAYMENT_ALREADY_BOUND',
  );

  assert.throws(
    () => f.store.createShareTransfer(
      f.project.id,
      {
        shareClassId: f.shareClass.id,
        fromStakeholderId: f.seller.id,
        toStakeholderId: f.buyer.id,
        units: 2,
        priceAmount: 1_000,
        status: 'pending',
        resolutionId: 'transfer-resolution',
        contractId: 'transfer-contract',
        paymentIntentId: 'transfer-payment',
      },
      'capital-compliance-resolution-reuse',
      { user: { id: 'capital-maker' } },
    ),
    (error) => error.code === 'RESOLUTION_ALREADY_BOUND',
  );
});

test('enterprise share transfer rejection and cancellation reject API keys', (t) => {
  const f = fixture(t);
  const insertPendingTransfer = f.db.prepare(`
    INSERT INTO share_transfers(
      id,project_id,share_class_id,from_stakeholder_id,to_stakeholder_id,
      units,price_amount,status,note,decision_note,created_at,updated_at,
      decided_at,created_by_user_id
    ) VALUES(?,?,?,?,?,?,0,'pending',NULL,NULL,?,?,NULL,'capital-maker')
  `);
  for (const targetStatus of ['rejected', 'cancelled']) {
    const transferId = `api-key-${targetStatus}-transfer`;
    insertPendingTransfer.run(
      transferId,
      f.project.id,
      f.shareClass.id,
      f.seller.id,
      f.buyer.id,
      1,
      NOW,
      NOW,
    );
    assert.throws(
      () => f.store.patchShareTransfer(
        f.project.id,
        transferId,
        {
          status: targetStatus,
          decisionNote: `API key attempted ${targetStatus}`,
        },
        {
          user: { id: 'capital-checker' },
          apiKey: { id: `capital-${targetStatus}-api-key` },
          actorType: 'api_key',
        },
      ),
      (error) => error.code === 'CAPITAL_INTERACTIVE_USER_REQUIRED',
    );
    const unchanged = f.db.prepare(`
      SELECT status,decision_note,decided_at
      FROM share_transfers
      WHERE id=? AND project_id=?
    `).get(transferId, f.project.id);
    assert.equal(unchanged.status, 'pending');
    assert.equal(unchanged.decision_note, null);
    assert.equal(unchanged.decided_at, null);

    const changed = f.store.patchShareTransfer(
      f.project.id,
      transferId,
      {
        status: targetStatus,
        decisionNote: `Interactive ${targetStatus}`,
      },
      { user: { id: 'capital-checker' } },
    ).shareTransfer;
    assert.equal(changed.status, targetStatus);
    assert.equal(changed.decisionNote, `Interactive ${targetStatus}`);
  }
});

test('enterprise voting requires the linked user or a valid scoped proxy', (t) => {
  const f = fixture(t);
  f.db.prepare(`
    INSERT INTO project_meetings(
      id,project_id,title,scheduled_at,status,created_at,updated_at
    ) VALUES('identity-meeting',?,'Identity vote',?,'held',?,?)
  `).run(f.project.id, NOW, NOW, NOW);
  const insertResolution = f.db.prepare(`
    INSERT INTO meeting_resolutions(
      id,meeting_id,title,status,created_at,updated_at
    ) VALUES(?,'identity-meeting',?,'open',?,?)
  `);
  insertResolution.run(
    'identity-resolution-direct',
    'Direct identity vote',
    NOW,
    NOW,
  );
  insertResolution.run(
    'identity-resolution-proxy',
    'Proxy identity vote',
    NOW,
    NOW,
  );

  assert.throws(
    () => f.store.vote(
      f.project.id,
      'identity-meeting',
      'identity-resolution-direct',
      { stakeholderId: f.seller.id, choice: 'yes' },
      { user: { id: 'capital-checker' } },
    ),
    (error) => error.code === 'VOTE_STAKEHOLDER_IDENTITY_REQUIRED',
  );
  assert.throws(
    () => f.store.vote(
      f.project.id,
      'identity-meeting',
      'identity-resolution-direct',
      { stakeholderId: f.seller.id, choice: 'yes' },
      {
        user: { id: 'capital-maker' },
        apiKey: { id: 'vote-api-key' },
        actorType: 'api_key',
      },
    ),
    (error) => error.code === 'CAPITAL_INTERACTIVE_USER_REQUIRED',
  );
  const direct = f.store.vote(
    f.project.id,
    'identity-meeting',
    'identity-resolution-direct',
    { stakeholderId: f.seller.id, choice: 'yes' },
    { user: { id: 'capital-maker' } },
  );
  assert.equal(direct.castByUserId, 'capital-maker');
  assert.equal(direct.proxyId, null);
  assert.equal(direct.votingPower, 10);

  f.db.prepare(`
    INSERT INTO governance_proxies(
      id,project_id,meeting_id,grantor_stakeholder_id,
      proxy_stakeholder_id,scope,resolution_id,voting_power,status,
      granted_at,expires_at,created_at,updated_at
    ) VALUES(
      'seller-proxy',?,'identity-meeting',?,?,'resolution',
      'identity-resolution-proxy',10,'active',?,'2027-07-24T10:00:00.000Z',?,?
    )
  `).run(
    f.project.id,
    f.seller.id,
    f.buyer.id,
    NOW,
    NOW,
    NOW,
  );
  const proxied = f.store.vote(
    f.project.id,
    'identity-meeting',
    'identity-resolution-proxy',
    { stakeholderId: f.seller.id, choice: 'no' },
    { user: { id: 'capital-checker' } },
  );
  assert.equal(proxied.castByUserId, 'capital-checker');
  assert.equal(proxied.proxyId, 'seller-proxy');
  assert.equal(proxied.votingPower, 10);
  const storedVote = f.db.prepare(`
    SELECT cast_by_user_id,proxy_id
    FROM resolution_votes
    WHERE resolution_id='identity-resolution-proxy'
      AND stakeholder_id=?
  `).get(f.seller.id);
  assert.equal(storedVote.cast_by_user_id, 'capital-checker');
  assert.equal(storedVote.proxy_id, 'seller-proxy');
});

test('resolution finalization closes atomically and generic close cannot preserve a stale outcome', (t) => {
  const f = fixture(t);
  f.store.setAttendance(
    f.project.id,
    'transfer-meeting',
    f.seller.id,
    { attendance: 'present' },
  );
  const finalizedResolution = f.store.createResolution(
    f.project.id,
    'transfer-meeting',
    {
      title: 'Atomic finalization',
      status: 'open',
    },
  ).resolution;
  f.store.vote(
    f.project.id,
    'transfer-meeting',
    finalizedResolution.id,
    { stakeholderId: f.seller.id, choice: 'yes' },
    { user: { id: 'capital-maker' } },
  );
  const finalized = f.financeStore.finalizeResolutionOutcome(
    f.project.id,
    'transfer-meeting',
    finalizedResolution.id,
    {
      actor: {
        actorType: 'user',
        userId: 'capital-maker',
      },
    },
  ).outcome;
  assert.equal(finalized.outcome, 'approved');
  const storedFinalized = f.db.prepare(`
    SELECT status,result_json
    FROM meeting_resolutions
    WHERE id=?
  `).get(finalizedResolution.id);
  assert.equal(storedFinalized.status, 'closed');
  assert.equal(JSON.parse(storedFinalized.result_json).outcome, 'approved');
  assert.throws(
    () => f.store.vote(
      f.project.id,
      'transfer-meeting',
      finalizedResolution.id,
      { stakeholderId: f.seller.id, choice: 'no' },
      { user: { id: 'capital-maker' } },
    ),
    (error) => error.code === 'RESOLUTION_NOT_OPEN',
  );

  const genericallyClosed = f.store.createResolution(
    f.project.id,
    'transfer-meeting',
    {
      title: 'Canonical generic close',
      status: 'open',
    },
  ).resolution;
  f.store.vote(
    f.project.id,
    'transfer-meeting',
    genericallyClosed.id,
    { stakeholderId: f.seller.id, choice: 'no' },
    { user: { id: 'capital-maker' } },
  );
  f.store.patchResolution(
    f.project.id,
    'transfer-meeting',
    genericallyClosed.id,
    {
      status: 'closed',
      decision: 'Rejected by the canonical tally.',
    },
  );
  const storedGeneric = f.db.prepare(`
    SELECT status,result_json,decision
    FROM meeting_resolutions
    WHERE id=?
  `).get(genericallyClosed.id);
  assert.equal(storedGeneric.status, 'closed');
  assert.equal(JSON.parse(storedGeneric.result_json).outcome, 'rejected');
  assert.equal(storedGeneric.decision, 'Rejected by the canonical tally.');
});

test('proxy lifecycle requires the grantor interactive identity and full voting power', (t) => {
  const f = fixture(t);
  const resolution = f.store.createResolution(
    f.project.id,
    'transfer-meeting',
    {
      title: 'Identity-bound proxy',
      status: 'open',
    },
  ).resolution;
  const proxyInput = {
    meetingId: 'transfer-meeting',
    scope: 'resolution',
    resolutionId: resolution.id,
    grantorStakeholderId: f.seller.id,
    proxyStakeholderId: f.buyer.id,
  };
  assert.throws(
    () => f.financeStore.createGovernanceProxy(
      f.project.id,
      proxyInput,
      {
        actor: {
          actorType: 'api_key',
          userId: 'capital-maker',
          apiKey: { id: 'proxy-api-key' },
        },
      },
    ),
    (error) => error.code === 'GOVERNANCE_PROXY_INTERACTIVE_USER_REQUIRED',
  );
  assert.throws(
    () => f.financeStore.createGovernanceProxy(
      f.project.id,
      proxyInput,
      {
        actor: {
          actorType: 'user',
          userId: 'capital-checker',
        },
      },
    ),
    (error) => error.code === 'GOVERNANCE_PROXY_GRANTOR_IDENTITY_REQUIRED',
  );
  assert.throws(
    () => f.financeStore.createGovernanceProxy(
      f.project.id,
      { ...proxyInput, votingPower: 1 },
      {
        actor: {
          actorType: 'user',
          userId: 'capital-maker',
        },
      },
    ),
    (error) => error.code === 'PARTIAL_PROXY_NOT_SUPPORTED',
  );
  f.store.vote(
    f.project.id,
    'transfer-meeting',
    resolution.id,
    { stakeholderId: f.seller.id, choice: 'yes' },
    { user: { id: 'capital-maker' } },
  );
  const proxy = f.financeStore.createGovernanceProxy(
    f.project.id,
    proxyInput,
    {
      actor: {
        actorType: 'user',
        userId: 'capital-maker',
      },
    },
  ).governanceProxy;
  assert.equal(proxy.votingPower, 10);
  f.db.prepare(`
    UPDATE resolution_votes
    SET voting_power=20
    WHERE resolution_id=? AND stakeholder_id=?
  `).run(resolution.id, f.seller.id);
  const proxyVote = f.store.vote(
    f.project.id,
    'transfer-meeting',
    resolution.id,
    { stakeholderId: f.seller.id, choice: 'no' },
    { user: { id: 'capital-checker' } },
  );
  assert.equal(proxyVote.votingPower, 10);
  assert.equal(proxyVote.proxyId, proxy.id);
  assert.equal(
    Number(f.db.prepare(`
      SELECT voting_power
      FROM resolution_votes
      WHERE resolution_id=? AND stakeholder_id=?
    `).get(resolution.id, f.seller.id).voting_power),
    10,
  );
  assert.throws(
    () => f.financeStore.revokeGovernanceProxy(
      f.project.id,
      proxy.id,
      {
        actor: {
          actorType: 'api_key',
          userId: 'capital-maker',
          apiKey: { id: 'proxy-api-key' },
        },
      },
    ),
    (error) => error.code === 'GOVERNANCE_PROXY_INTERACTIVE_USER_REQUIRED',
  );
  assert.throws(
    () => f.financeStore.revokeGovernanceProxy(
      f.project.id,
      proxy.id,
      {
        actor: {
          actorType: 'user',
          userId: 'capital-checker',
        },
      },
    ),
    (error) => error.code === 'GOVERNANCE_PROXY_GRANTOR_IDENTITY_REQUIRED',
  );
  const revoked = f.financeStore.revokeGovernanceProxy(
    f.project.id,
    proxy.id,
    {
      actor: {
        actorType: 'user',
        userId: 'capital-maker',
      },
    },
  ).governanceProxy;
  assert.equal(revoked.status, 'revoked');

  const legacyPartialResolution = f.store.createResolution(
    f.project.id,
    'transfer-meeting',
    {
      title: 'Legacy partial proxy cannot escalate',
      status: 'open',
    },
  ).resolution;
  f.store.vote(
    f.project.id,
    'transfer-meeting',
    legacyPartialResolution.id,
    { stakeholderId: f.seller.id, choice: 'yes' },
    { user: { id: 'capital-maker' } },
  );
  f.db.prepare(`
    INSERT INTO governance_proxies(
      id,project_id,meeting_id,grantor_stakeholder_id,
      proxy_stakeholder_id,scope,resolution_id,voting_power,status,
      granted_at,expires_at,created_at,updated_at
    ) VALUES(
      'legacy-partial-proxy',?,'transfer-meeting',?,?,'resolution',?,
      1,'active',?,'2027-07-24T10:00:00.000Z',?,?
    )
  `).run(
    f.project.id,
    f.seller.id,
    f.buyer.id,
    legacyPartialResolution.id,
    NOW,
    NOW,
    NOW,
  );
  assert.throws(
    () => f.store.vote(
      f.project.id,
      'transfer-meeting',
      legacyPartialResolution.id,
      { stakeholderId: f.seller.id, choice: 'no' },
      { user: { id: 'capital-checker' } },
    ),
    (error) => error.code === 'PARTIAL_PROXY_NOT_SUPPORTED',
  );
  const unchangedVote = f.db.prepare(`
    SELECT choice,voting_power
    FROM resolution_votes
    WHERE resolution_id=? AND stakeholder_id=?
  `).get(legacyPartialResolution.id, f.seller.id);
  assert.equal(unchangedVote.choice, 'yes');
  assert.equal(Number(unchangedVote.voting_power), 10);
});

test('resolution operation scope is API-visible and immutable after voting opens', (t) => {
  const f = fixture(t);
  const scope = {
    operationType: 'share_transfer',
    shareClassId: f.shareClass.id,
    fromStakeholderId: f.seller.id,
    toStakeholderId: f.buyer.id,
    units: 1,
    amount: 500,
    currency: 'IRR',
  };
  const created = f.store.createResolution(
    f.project.id,
    'transfer-meeting',
    {
      title: 'Scoped transfer approval',
      status: 'draft',
      operationScope: scope,
    },
  ).resolution;
  assert.equal(created.operationType, 'share_transfer');
  assert.equal(created.operationScope.projectId, f.project.id);
  assert.equal(created.operationScope.units, 1);
  assert.match(created.operationRequestHash, /^[A-Za-z0-9_-]{43}$/);
  f.store.patchResolution(
    f.project.id,
    'transfer-meeting',
    created.id,
    { status: 'open' },
  );
  assert.throws(
    () => f.store.patchResolution(
      f.project.id,
      'transfer-meeting',
      created.id,
      {
        operationScope: {
          ...scope,
          units: 2,
        },
      },
    ),
    (error) => error.code === 'RESOLUTION_SCOPE_IMMUTABLE',
  );
  assert.throws(
    () => f.db.prepare(`
      UPDATE meeting_resolutions
      SET operation_scope_json='{}'
      WHERE id=?
    `).run(created.id),
    /resolution operation scope is immutable/,
  );
});

test('stakeholder API links one active organization user per project', (t) => {
  const f = fixture(t);
  f.db.prepare(`
    INSERT INTO users(
      id,email,password_hash,full_name,status,password_changed_at,
      created_at,updated_at
    ) VALUES(
      'linked-stakeholder-user','linked-stakeholder@example.test','unused',
      'Linked Stakeholder','active',?,?,?
    )
  `).run(NOW, NOW, NOW);
  f.db.prepare(`
    INSERT INTO organization_memberships(
      id,organization_id,user_id,role_key,status,joined_at,created_at,updated_at
    ) VALUES(
      'linked-stakeholder-membership',?,'linked-stakeholder-user',
      'viewer','active',?,?,?
    )
  `).run(ORGANIZATION_ID, NOW, NOW, NOW);
  const stakeholder = f.store.createStakeholder(f.project.id, {
    name: 'Linked Stakeholder',
    kind: 'person',
    role: 'investor',
    userId: 'linked-stakeholder-user',
  }).stakeholder;
  assert.equal(stakeholder.userId, 'linked-stakeholder-user');
  assert.throws(
    () => f.store.createStakeholder(f.project.id, {
      name: 'Duplicate User Stakeholder',
      kind: 'person',
      role: 'investor',
      userId: 'linked-stakeholder-user',
    }),
    (error) => error.code === 'STAKEHOLDER_USER_ALREADY_LINKED',
  );
});

test('legacy single-entry finance is read-only after owner bootstrap', (t) => {
  const f = fixture(t);
  f.db.prepare(`
    INSERT INTO financial_entries(
      id,project_id,type,amount,occurred_on,description,
      stakeholder_id,created_at,reversal_of_entry_id
    ) VALUES(
      'legacy-finance-before-owner',?,'revenue',10,'2026-07-01',
      'legacy',NULL,?,NULL
    )
  `).run(f.project.id, NOW);
  assert.throws(
    () => f.store.createFinancialEntry(
      f.project.id,
      {
        type: 'expense',
        amount: 5,
        occurredOn: '2026-07-24',
        description: 'must use a journal',
      },
      'legacy-finance-blocked',
    ),
    (error) => error.code === 'DOUBLE_ENTRY_FINANCE_REQUIRED',
  );
  assert.throws(
    () => f.store.reverseFinancialEntry(
      f.project.id,
      'legacy-finance-before-owner',
      { occurredOn: '2026-07-24' },
    ),
    (error) => error.code === 'DOUBLE_ENTRY_FINANCE_REQUIRED',
  );
});
