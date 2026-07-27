import { assertMutationOrigin, decodeSegment, sendJson } from './http.js';

const PREFIX = '/api/v2/admin/projects';

function segments(pathname) {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  return pathname
    .slice(PREFIX.length + 1)
    .split('/')
    .filter(Boolean)
    .map(decodeSegment);
}

function storeFrom(context) {
  return context.enterpriseFinanceStore || context.financeStore;
}

function idempotencyKey(request) {
  return request.headers['idempotency-key'];
}

async function readAccess(context, authorize, projectId, permission) {
  return authorize(context, {
    projectId,
    permission,
    mutation: false,
  });
}

async function mutation(context, authorize, projectId, permission, { body = true } = {}) {
  assertMutationOrigin(context.request, context.config);
  const actor = await authorize(context, {
    projectId,
    permission,
    mutation: true,
  });
  return {
    actor,
    input: body ? await context.readJson() : {},
  };
}

/**
 * Routes enterprise finance/legal/capital/governance operations.
 *
 * Authorization contract:
 * authorize(context, { projectId, organizationId?, permission, mutation })
 * -> { userId, organizationId, permissions, legacy }
 */
export async function routeEnterpriseFinanceApi(context, authorize) {
  const { request, response, url } = context;
  const parts = segments(url.pathname);
  if (parts === null) return false;
  const finance = storeFrom(context);
  if (!finance) return false;

  const [
    projectId,
    resource,
    resourceId,
    nested,
    nestedId,
    action,
  ] = parts;
  if (!projectId || !resource) return false;

  if (resource === 'accounts' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.accounts(projectId, {
      includeInactive: url.searchParams.get('includeInactive') === 'true',
    }));
    return true;
  }
  if (resource === 'accounts' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(response, 201, finance.createAccount(projectId, input, { actor }));
    return true;
  }
  if (resource === 'accounts' && parts.length === 3 && request.method === 'PATCH') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(response, 200, finance.patchAccount(projectId, resourceId, input, { actor }));
    return true;
  }

  if (resource === 'fiscal-periods' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.fiscalPeriods(projectId));
    return true;
  }
  if (resource === 'fiscal-periods' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(response, 201, finance.createFiscalPeriod(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'fiscal-periods' &&
    parts.length === 4 &&
    request.method === 'POST' &&
    ['open', 'closing', 'close', 'reopen'].includes(nested)
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
      { body: false },
    );
    const status = nested === 'close'
      ? 'closed'
      : nested === 'reopen'
        ? 'open'
        : nested;
    sendJson(
      response,
      200,
      finance.setFiscalPeriodStatus(projectId, resourceId, status, { actor }),
    );
    return true;
  }

  if (resource === 'journal-entries' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.journals(projectId, {
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 200,
    }));
    return true;
  }
  if (resource === 'journal-entries' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    const result = finance.createJournalDraft(projectId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    });
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (resource === 'journal-entries' && parts.length === 3 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.getJournal(projectId, resourceId));
    return true;
  }
  if (
    resource === 'journal-entries' &&
    parts.length === 4 &&
    nested === 'lines' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(
      response,
      201,
      finance.addJournalLine(projectId, resourceId, input, { actor }),
    );
    return true;
  }
  if (
    resource === 'journal-entries' &&
    parts.length === 4 &&
    nested === 'post' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
      { body: false },
    );
    sendJson(response, 200, finance.postJournal(projectId, resourceId, { actor }));
    return true;
  }
  if (
    resource === 'journal-entries' &&
    parts.length === 4 &&
    nested === 'reverse' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    const result = finance.reverseJournal(projectId, resourceId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    });
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }

  if (resource === 'valuations' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.valuations(projectId, {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (resource === 'valuations' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    const result = finance.createValuation(projectId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    });
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }

  if (resource === 'reports' && parts.length === 3 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    const filters = {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    };
    const reports = {
      'trial-balance': () => finance.trialBalance(projectId, filters),
      'profit-loss': () => finance.profitAndLoss(projectId, filters),
      'balance-sheet': () => finance.balanceSheet(projectId, {
        to: filters.to,
      }),
      returns: () => finance.returnsReport(projectId, {
        asOf: filters.to,
      }),
    };
    if (!reports[resourceId]) return false;
    sendJson(response, 200, reports[resourceId]());
    return true;
  }

  if (resource === 'invoices' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.invoices(projectId, {
      kind: url.searchParams.get('kind') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 200,
    }));
    return true;
  }
  if (
    resource === 'invoices' &&
    ((parts.length === 2 && request.method === 'POST') ||
      (parts.length === 3 && resourceId === 'issue' && request.method === 'POST'))
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    const result = finance.issueInvoice(projectId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    });
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (
    resource === 'invoices' &&
    parts.length === 4 &&
    nested === 'void' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(response, 200, finance.voidInvoice(projectId, resourceId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    }));
    return true;
  }

  if (resource === 'payment-intents' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.payments(projectId, {
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 200,
    }));
    return true;
  }
  if (resource === 'payment-intents' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    const result = finance.createPaymentIntent(projectId, input, {
      actor,
      idempotencyKey: idempotencyKey(request),
    });
    sendJson(response, result.idempotentReplay ? 200 : 201, result);
    return true;
  }
  if (
    resource === 'payment-intents' &&
    parts.length === 4 &&
    nested === 'confirm' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(
      response,
      200,
      finance.confirmPayment(projectId, resourceId, input, { actor }),
    );
    return true;
  }

  if (resource === 'distributions' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'finance.read');
    sendJson(response, 200, finance.distributions(projectId, {
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (
    resource === 'distributions' &&
    parts.length === 3 &&
    resourceId === 'preview' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(
      response,
      201,
      finance.createDistributionPreview(projectId, input, { actor }),
    );
    return true;
  }
  if (
    resource === 'distributions' &&
    parts.length === 4 &&
    nested === 'approve' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(
      response,
      200,
      finance.approveDistribution(projectId, resourceId, input, { actor }),
    );
    return true;
  }
  if (
    resource === 'distributions' &&
    parts.length === 4 &&
    nested === 'pay' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'finance.manage',
    );
    sendJson(response, 200, finance.payDistribution(projectId, resourceId, input, { actor }));
    return true;
  }

  if (resource === 'kyc-cases' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'compliance.read');
    sendJson(response, 200, finance.kycCases(projectId, {
      subjectType: url.searchParams.get('subjectType') || undefined,
      subjectId: url.searchParams.get('subjectId') || undefined,
      status: url.searchParams.get('status') || undefined,
    }));
    return true;
  }
  if (resource === 'kyc-cases' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'compliance.manage',
    );
    sendJson(response, 201, finance.createKycCase(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'kyc-cases' &&
    parts.length === 4 &&
    nested === 'checks' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'compliance.manage',
    );
    sendJson(response, 201, finance.addKycCheck(projectId, resourceId, input, { actor }));
    return true;
  }
  if (
    resource === 'kyc-cases' &&
    parts.length === 4 &&
    nested === 'review' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'compliance.manage',
    );
    sendJson(response, 200, finance.reviewKycCase(projectId, resourceId, input, { actor }));
    return true;
  }

  if (resource === 'contracts' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'contracts.read');
    sendJson(response, 200, finance.contracts(projectId, {
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (resource === 'contracts' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'contracts.manage',
    );
    sendJson(response, 201, finance.createContract(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'contracts' &&
    parts.length === 4 &&
    nested === 'parties' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'contracts.manage',
    );
    sendJson(response, 201, finance.addContractParty(projectId, resourceId, input, { actor }));
    return true;
  }
  if (
    resource === 'contracts' &&
    parts.length === 4 &&
    nested === 'request-signatures' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'contracts.manage',
    );
    sendJson(
      response,
      200,
      finance.requestContractSignatures(projectId, resourceId, input, { actor }),
    );
    return true;
  }
  if (
    resource === 'contracts' &&
    parts.length === 6 &&
    nested === 'signatures' &&
    action === 'manual' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'contracts.manage',
    );
    sendJson(
      response,
      200,
      finance.recordManualSignature(
        projectId,
        resourceId,
        nestedId,
        input,
        { actor },
      ),
    );
    return true;
  }

  if (resource === 'corporate-actions' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'capital.read');
    sendJson(response, 200, finance.corporateActions(projectId, {
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') || 100,
    }));
    return true;
  }
  if (resource === 'corporate-actions' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
    );
    sendJson(response, 201, finance.createCorporateAction(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'corporate-actions' &&
    parts.length === 4 &&
    nested === 'preview' &&
    request.method === 'GET'
  ) {
    await readAccess(context, authorize, projectId, 'capital.read');
    sendJson(response, 200, finance.previewCorporateAction(projectId, resourceId));
    return true;
  }
  if (
    resource === 'corporate-actions' &&
    parts.length === 4 &&
    nested === 'approve' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
      { body: false },
    );
    sendJson(
      response,
      200,
      finance.approveCorporateAction(projectId, resourceId, { actor }),
    );
    return true;
  }
  if (
    resource === 'corporate-actions' &&
    parts.length === 4 &&
    nested === 'execute' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
      { body: false },
    );
    sendJson(
      response,
      200,
      finance.executeCorporateAction(projectId, resourceId, { actor }),
    );
    return true;
  }

  if (resource === 'preemptive-rights' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'capital.read');
    sendJson(response, 200, finance.preemptiveRights(projectId, {
      actionId: url.searchParams.get('actionId') || undefined,
    }));
    return true;
  }
  if (
    resource === 'preemptive-rights' &&
    parts.length === 4 &&
    nested === 'exercise' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
    );
    sendJson(
      response,
      200,
      finance.exercisePreemptiveRight(projectId, resourceId, input, { actor }),
    );
    return true;
  }
  if (
    resource === 'preemptive-rights' &&
    parts.length === 4 &&
    nested === 'waive' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
      { body: false },
    );
    sendJson(
      response,
      200,
      finance.waivePreemptiveRight(projectId, resourceId, { actor }),
    );
    return true;
  }

  if (resource === 'share-certificates' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'capital.read');
    sendJson(response, 200, finance.certificates(projectId, {
      stakeholderId: url.searchParams.get('stakeholderId') || undefined,
      shareClassId: url.searchParams.get('shareClassId') || undefined,
      status: url.searchParams.get('status') || undefined,
    }));
    return true;
  }
  if (resource === 'share-certificates' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
    );
    sendJson(response, 201, finance.issueCertificate(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'share-certificates' &&
    parts.length === 4 &&
    nested === 'cancel' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
      { body: false },
    );
    sendJson(response, 200, finance.cancelCertificate(projectId, resourceId, { actor }));
    return true;
  }
  if (
    resource === 'share-certificates' &&
    parts.length === 4 &&
    nested === 'replace' &&
    request.method === 'POST'
  ) {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'capital.manage',
    );
    sendJson(
      response,
      200,
      finance.replaceCertificate(projectId, resourceId, input, { actor }),
    );
    return true;
  }

  if (resource === 'governance-proxies' && parts.length === 2 && request.method === 'GET') {
    await readAccess(context, authorize, projectId, 'governance.read');
    sendJson(response, 200, finance.governanceProxies(projectId, {
      meetingId: url.searchParams.get('meetingId') || undefined,
      resolutionId: url.searchParams.get('resolutionId') || undefined,
      status: url.searchParams.get('status') || undefined,
    }));
    return true;
  }
  if (resource === 'governance-proxies' && parts.length === 2 && request.method === 'POST') {
    const { actor, input } = await mutation(
      context,
      authorize,
      projectId,
      'governance.manage',
    );
    sendJson(response, 201, finance.createGovernanceProxy(projectId, input, { actor }));
    return true;
  }
  if (
    resource === 'governance-proxies' &&
    parts.length === 4 &&
    nested === 'revoke' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'governance.manage',
      { body: false },
    );
    sendJson(
      response,
      200,
      finance.revokeGovernanceProxy(projectId, resourceId, { actor }),
    );
    return true;
  }

  if (
    resource === 'meetings' &&
    parts.length === 4 &&
    nested === 'quorum' &&
    request.method === 'GET'
  ) {
    await readAccess(context, authorize, projectId, 'governance.read');
    sendJson(response, 200, finance.calculateQuorum(projectId, resourceId, {
      resolutionId: url.searchParams.get('resolutionId') || undefined,
    }));
    return true;
  }
  if (
    resource === 'meetings' &&
    parts.length === 6 &&
    nested === 'resolutions' &&
    action === 'outcome' &&
    request.method === 'GET'
  ) {
    await readAccess(context, authorize, projectId, 'governance.read');
    sendJson(
      response,
      200,
      finance.calculateResolutionOutcome(projectId, resourceId, nestedId),
    );
    return true;
  }
  if (
    resource === 'meetings' &&
    parts.length === 6 &&
    nested === 'resolutions' &&
    action === 'finalize-outcome' &&
    request.method === 'POST'
  ) {
    const { actor } = await mutation(
      context,
      authorize,
      projectId,
      'governance.manage',
      { body: false },
    );
    sendJson(
      response,
      200,
      finance.finalizeResolutionOutcome(projectId, resourceId, nestedId, { actor }),
    );
    return true;
  }

  return false;
}
