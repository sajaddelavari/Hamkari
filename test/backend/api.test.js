import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApplication, TEST_PASSWORD } from './helpers.js';

const validProposal = {
  applicantName: 'شرکت توسعه آزمون',
  mobile: '۰۹۱۲ ۳۴۵ ۶۷۸۹',
  email: 'team@example.com',
  contribution: 'توان تأمین کامل این بخش همراه با تیم اجرایی و برنامه زمان‌بندی را داریم.',
  availability: 'از ابتدای ماه آینده',
  notes: 'برای جلسه اولیه در روزهای کاری آماده‌ایم.',
  consent: true,
  website: '',
};

test('public flow is idempotent, private, and derives progress only from acceptance', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const publicClient = fixture.client();

  let result = await publicClient.request('/api/v1/projects/greenhouse-20ha');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.stats.completionPercent, 0);
  assert.equal(result.data.project.needs.length, 8);
  assert.ok(publicClient.cookie('hamkari_visitor'));

  result = await publicClient.request('/api/v1/needs/land/viewer-state', {
    method: 'PUT',
    body: { following: true, interested: true, actorId: 'forged' },
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.need.viewerState, { following: true, interested: true });
  await publicClient.request('/api/v1/needs/land/viewer-state', {
    method: 'PUT',
    body: { following: true, interested: true },
  });
  result = await publicClient.request('/api/v1/projects/greenhouse-20ha');
  assert.equal(result.data.project.needs[0].stats.followers, 1);
  assert.equal(result.data.project.stats.completionPercent, 0);

  result = await publicClient.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    body: { ...validProposal, actorId: 'forged' },
  });
  assert.equal(result.response.status, 201);
  const { trackingToken, id: proposalId } = result.data.proposal;
  assert.match(trackingToken, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    fixture.application.db.prepare(
      'SELECT tracking_token_hash FROM proposals WHERE id=?',
    ).get(proposalId).tracking_token_hash.includes(trackingToken),
    false,
  );

  const replay = await publicClient.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    body: validProposal,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.idempotentReplay, true);
  assert.equal(replay.data.proposal.id, proposalId);
  assert.equal(replay.data.proposal.trackingToken, trackingToken);
  assert.equal(
    fixture.application.db.prepare('SELECT COUNT(*) AS c FROM proposals').get().c,
    1,
  );

  const conflict = await publicClient.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
    body: { ...validProposal, contribution: `${validProposal.contribution} تغییر` },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');

  const tracking = await publicClient.request('/api/v1/proposals/track', {
    headers: { Authorization: `Bearer ${trackingToken}` },
  });
  assert.equal(tracking.response.status, 200);
  assert.equal(tracking.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(tracking.data.proposal.statusKey, 'new');
  assert.equal(tracking.data.proposal.mobile, undefined);

  result = await publicClient.request('/api/v1/projects/greenhouse-20ha');
  const publicJson = JSON.stringify(result.data);
  assert.equal(publicJson.includes('09123456789'), false);
  assert.equal(publicJson.includes(validProposal.contribution), false);
  assert.equal(publicJson.includes('شرکت توسعه آزمون'), false);
  assert.equal(result.data.project.stats.completionPercent, 0);
  assert.equal(result.data.project.needs[0].statusKey, 'under_review');

  const admin = fixture.client();
  result = await admin.request('/api/v1/admin/session');
  assert.deepEqual(result.data, { authenticated: false });
  result = await admin.request('/api/v1/admin/proposals');
  assert.equal(result.response.status, 401);

  result = await admin.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
  assert.equal(result.data.projectSlug, 'greenhouse-20ha');
  const csrfToken = result.data.csrfToken;
  const rawSession = admin.cookie('hamkari_admin');
  assert.ok(rawSession);
  assert.equal(
    fixture.application.db.prepare(
      'SELECT COUNT(*) AS c FROM admin_sessions WHERE token_hash=?',
    ).get(rawSession).c,
    0,
  );

  result = await admin.request(`/api/v1/admin/proposals/${proposalId}`, {
    method: 'PATCH',
    headers: { 'X-CSRF-Token': 'incorrect-token' },
    body: { status: 'contacted' },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INVALID_CSRF_TOKEN');

  result = await admin.request('/api/v1/admin/proposals');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.summary.new, 1);
  assert.equal(result.data.proposals.length, 1);
  assert.equal(result.data.proposals[0].status, 'new');
  assert.equal(result.data.proposals[0].mobile, '09123456789');
  assert.equal(result.data.pagination.hasMore, false);

  const updateStatus = async (body) =>
    admin.request(`/api/v1/admin/proposals/${proposalId}`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrfToken },
      body,
    });
  assert.equal((await updateStatus({ status: 'contacted' })).response.status, 200);
  assert.equal(
    (await updateStatus({ internalNote: 'یادداشت داخلی محرمانه' })).response.status,
    200,
  );
  assert.equal((await updateStatus({ status: 'negotiating' })).response.status, 200);
  result = await updateStatus({
    status: 'accepted',
    decisionMessage: 'پیشنهاد شما برای ادامه همکاری پذیرفته شد.',
  });
  assert.equal(result.response.status, 200);

  result = await publicClient.request('/api/v1/projects/greenhouse-20ha');
  assert.equal(result.data.project.stats.committedNeeds, 1);
  assert.equal(result.data.project.stats.completionPercent, 13);
  assert.equal(result.data.project.needs[0].statusKey, 'committed');

  const secondApplicant = fixture.client();
  result = await secondApplicant.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '22222222-2222-4222-8222-222222222222' },
    body: { ...validProposal, applicantName: 'متقاضی دوم' },
  });
  const secondId = result.data.proposal.id;
  const secondUpdate = async (body) =>
    admin.request(`/api/v1/admin/proposals/${secondId}`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrfToken },
      body,
    });
  await secondUpdate({ status: 'contacted' });
  await secondUpdate({ status: 'negotiating' });
  result = await secondUpdate({ status: 'accepted' });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'NEED_ALREADY_COMMITTED');
  assert.equal(
    (await secondUpdate({
      status: 'rejected',
      decisionMessage: 'در شرایط فعلی امکان ادامه این پیشنهاد وجود ندارد.',
    })).response.status,
    200,
  );
  result = await secondUpdate({ decisionMessage: 'x' });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'DECISION_MESSAGE_REQUIRED');
  assert.equal((await secondUpdate({ status: 'new' })).response.status, 200);

  result = await updateStatus({ status: 'negotiating' });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error.code, 'INVALID_STATUS_TRANSITION');
  result = await updateStatus({
    status: 'negotiating',
    confirmUnaccept: true,
    decisionMessage: 'پیشنهاد شما برای ادامه همکاری پذیرفته شد.',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.proposal.decisionMessage, null);
  result = await publicClient.request('/api/v1/projects/greenhouse-20ha');
  assert.equal(result.data.project.stats.completionPercent, 0);
  assert.equal(result.data.project.needs[0].statusKey, 'negotiating');

  const trackedAfterDecision = await publicClient.request('/api/v1/proposals/track', {
    headers: { Authorization: `Bearer ${trackingToken}` },
  });
  assert.equal(
    trackedAfterDecision.data.proposal.events.some(
      (event) => event.toStatus === 'accepted',
    ),
    true,
  );
  assert.equal(
    JSON.stringify(trackedAfterDecision.data).includes('یادداشت داخلی محرمانه'),
    false,
  );
  assert.equal(
    (await publicClient.request(`/api/v1/proposals/track/${trackingToken}`)).response.status,
    404,
  );
  await admin.request('/api/v1/admin/needs/land', {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  const replayAfterArchive = await publicClient.request(
    '/api/v1/needs/land/proposals',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': '11111111-1111-4111-8111-111111111111' },
      body: validProposal,
    },
  );
  assert.equal(replayAfterArchive.response.status, 200);
  assert.equal(replayAfterArchive.data.proposal.trackingToken, trackingToken);
});

test('validation, honeypot, payload cap, origin and login limits use standard errors', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const client = fixture.client();

  let result = await client.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '33333333-3333-4333-8333-333333333333' },
    body: { ...validProposal, mobile: '123', consent: false },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'VALIDATION_FAILED');
  assert.ok(result.data.error.fields.mobile);
  assert.ok(result.data.requestId);

  result = await client.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: { 'Idempotency-Key': '44444444-4444-4444-8444-444444444444' },
    body: { ...validProposal, website: 'https://spam.example' },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error.code, 'SPAM_DETECTED');
  assert.equal(
    fixture.application.db.prepare('SELECT COUNT(*) AS c FROM proposals').get().c,
    0,
  );

  result = await client.request('/api/v1/needs/land/viewer-state', {
    method: 'PUT',
    origin: 'https://evil.example',
    body: { following: true, interested: false },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.data.error.code, 'INVALID_ORIGIN');

  result = await client.request('/api/v1/needs/land/viewer-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ following: true, interested: false }),
  });
  assert.equal(result.response.status, 415);
  assert.equal(result.data.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  result = await client.request('/api/v1/needs/land/proposals', {
    method: 'POST',
    headers: {
      'Idempotency-Key': '55555555-5555-4555-8555-555555555555',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...validProposal,
      notes: 'x'.repeat(70 * 1024),
    }),
  });
  assert.equal(result.response.status, 413);
  assert.equal(result.data.error.code, 'PAYLOAD_TOO_LARGE');

  for (let index = 0; index < 5; index += 1) {
    result = await client.request('/api/v1/admin/session', {
      method: 'POST',
      body: { password: 'wrong-password' },
    });
    assert.equal(result.response.status, 401);
  }
  result = await client.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: 'wrong-password' },
  });
  assert.equal(result.response.status, 429);
  assert.equal(result.data.error.code, 'RATE_LIMITED');
  assert.ok(Number(result.response.headers.get('retry-after')) >= 1);
});

test('admin can edit project and create, patch, reorder, then archive needs', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const admin = fixture.client();
  let result = await admin.request('/api/v1/admin/session', {
    method: 'POST',
    body: { password: TEST_PASSWORD },
  });
  const csrf = result.data.csrfToken;
  const headers = { 'X-CSRF-Token': csrf };

  result = await admin.request('/api/v1/admin/project');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.needs.length, 8);
  const project = result.data.project;
  result = await admin.request('/api/v1/admin/project', {
    method: 'PUT',
    headers,
    body: {
      title: 'پروژه ویرایش‌شده',
      subtitle: project.subtitle,
      summary: project.summary,
      location: project.location,
      timeline: project.timeline,
      leaderName: project.leader.name,
      leaderDescription: project.leader.description,
      processDescription: project.processDescription,
    },
  });
  assert.equal(result.data.project.title, 'پروژه ویرایش‌شده');

  result = await admin.request('/api/v1/admin/needs', {
    method: 'POST',
    headers,
    body: {
      title: 'نیاز تازه',
      description: 'شرح روشن و کافی برای نیاز تازه پروژه.',
      category: 'آزمون',
      targetValue: 'یک تیم',
      requirements: 'آمادگی برای شروع سریع',
    },
  });
  assert.equal(result.response.status, 201);
  const createdId = result.data.need.id;
  assert.equal(result.data.need.requirements, 'آمادگی برای شروع سریع');

  result = await admin.request(`/api/v1/admin/needs/${createdId}`, {
    method: 'PATCH',
    headers,
    body: { title: 'نیاز تازه ویرایش‌شده' },
  });
  assert.equal(result.data.need.title, 'نیاز تازه ویرایش‌شده');

  result = await admin.request('/api/v1/admin/project');
  const ids = result.data.needs
    .filter((need) => !need.archivedAt)
    .map((need) => need.id)
    .reverse();
  result = await admin.request('/api/v1/admin/needs/order', {
    method: 'PUT',
    headers,
    body: { ids },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.needs[0].id, createdId);

  result = await admin.request(`/api/v1/admin/needs/${createdId}`, {
    method: 'DELETE',
    headers,
  });
  assert.deepEqual(result.data, { archived: true, id: createdId });
  result = await admin.request('/api/v1/admin/project');
  assert.ok(result.data.needs.find((need) => need.id === createdId).archivedAt);
  result = await admin.request('/api/v1/admin/project', {
    method: 'PUT',
    headers,
    body: {
      slug: 'greenhouse-room',
      targetDate: '2028-01-15',
      status: 'draft',
    },
  });
  assert.equal(result.data.project.slug, 'greenhouse-room');
  assert.equal(result.data.project.status, 'draft');
  assert.equal(
    (await admin.request('/api/v1/admin/session')).data.projectSlug,
    'greenhouse-room',
  );
  assert.equal(
    (await fixture.client().request('/api/v1/projects/greenhouse-room')).response.status,
    404,
  );
  assert.equal(
    (await fixture.client().request('/api/v1/projects/current')).response.status,
    404,
  );
  await admin.request('/api/v1/admin/project', {
    method: 'PUT',
    headers,
    body: { status: 'published' },
  });
  result = await fixture.client().request('/api/v1/projects/greenhouse-room');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.deadline, '2028-01-15');
  result = await fixture.client().request('/api/v1/projects/current');
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project.slug, 'greenhouse-room');
  result = await admin.request('/api/v1/admin/session', {
    method: 'DELETE',
    headers,
  });
  assert.deepEqual(result.data, { authenticated: false });
  result = await admin.request('/api/v1/admin/session');
  assert.deepEqual(result.data, { authenticated: false });
});

test('SSE sends a default update event and can be closed cleanly', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const client = fixture.client();
  await client.request('/api/v1/projects/greenhouse-20ha');
  const controller = new AbortController();
  const cookie = client.cookie('hamkari_visitor');
  const streamResponse = await fetch(
    `${fixture.origin}/api/v1/projects/greenhouse-20ha/events`,
    {
      headers: { Cookie: `hamkari_visitor=${cookie}` },
      signal: controller.signal,
    },
  );
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let received = decoder.decode((await reader.read()).value, { stream: true });
  await client.request('/api/v1/needs/water/viewer-state', {
    method: 'PUT',
    body: { following: true, interested: false },
  });
  const deadline = Date.now() + 2_000;
  while (!received.includes('"reason":"viewer-state"') && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SSE update timeout')), 500),
      ),
    ]);
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /data: \{"slug":"greenhouse-20ha","reason":"viewer-state"/);
  await client.request('/api/v1/needs/water/viewer-state', {
    method: 'PUT',
    body: { following: false, interested: false },
  });
  assert.equal(
    fixture.application.db.prepare(`
      SELECT COUNT(*) AS count FROM viewer_interactions
      WHERE need_id='water'
    `).get().count,
    0,
  );
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('static assets negotiate Brotli and support ETag revalidation for HEAD', async (t) => {
  const fixture = await startTestApplication();
  t.after(fixture.close);
  const identity = await fetch(`${fixture.origin}/app.js`, {
    method: 'HEAD',
    headers: { 'Accept-Encoding': 'identity' },
  });
  const compressed = await fetch(`${fixture.origin}/app.js`, {
    method: 'HEAD',
    headers: { 'Accept-Encoding': 'br, gzip;q=0.8' },
  });
  assert.equal(identity.status, 200);
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'br');
  assert.match(compressed.headers.get('vary'), /Accept-Encoding/i);
  assert.ok(
    Number(compressed.headers.get('content-length')) <
      Number(identity.headers.get('content-length')),
  );
  const etag = compressed.headers.get('etag');
  assert.ok(etag);
  const revalidated = await fetch(`${fixture.origin}/app.js`, {
    method: 'HEAD',
    headers: {
      'Accept-Encoding': 'br',
      'If-None-Match': etag,
    },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers.get('etag'), etag);
});
