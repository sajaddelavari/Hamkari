import { createHash, randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.js';
import { withTransaction } from './database.js';
import { hashToken } from './security.js';

const PROPOSAL_STATUSES = ['new', 'contacted', 'negotiating', 'accepted', 'rejected'];

function isoNow(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asNumber(value) {
  return Number(value || 0);
}

function nullable(value) {
  return value === undefined || value === '' ? null : value;
}

function proposalMutationActor(value) {
  if (
    value &&
    typeof value === 'object' &&
    value.actorType === 'api_key' &&
    typeof value.actorId === 'string' &&
    value.actorId
  ) {
    return {
      eventActorType: 'api_key',
      auditActorType: 'api_key',
      actorId: value.actorId,
      actorUserId:
        typeof value.actorUserId === 'string' ? value.actorUserId : null,
    };
  }
  return {
    eventActorType: 'admin',
    auditActorType: 'legacy_admin',
    actorId: String(value || ''),
    actorUserId: null,
  };
}

function publicProjectRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    industry: row.industry || '',
    sector: row.sector || '',
    kind: row.kind || '',
    stage: row.stage || 'idea',
    currency: row.currency || 'IRR',
    budgetAmount: row.budget_amount,
    valuationAmount: row.valuation_amount,
    startDate: row.start_date || null,
    isDefault: Boolean(row.active),
    leader: {
      name: row.leader_name,
      description: row.leader_description,
    },
    location: row.location,
    timeline: row.timeline,
    targetDate: row.target_date || null,
    deadline: row.target_date || null,
    processDescription: row.process_description,
    updatedAt: row.updated_at,
  };
}

function derivedStatus(row) {
  if (asNumber(row.accepted_count) > 0) return 'committed';
  if (asNumber(row.negotiating_count) > 0) return 'negotiating';
  if (asNumber(row.review_count) > 0) return 'under_review';
  return 'open';
}

function mapPublicNeed(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    targetValue: row.target_value,
    expectations: row.expectations,
    order: asNumber(row.order_no),
    statusKey: derivedStatus(row),
    stats: {
      followers: asNumber(row.followers),
      interests: asNumber(row.interests),
      proposals: asNumber(row.proposal_count),
    },
    viewerState: {
      following: Boolean(row.viewer_following),
      interested: Boolean(row.viewer_interested),
    },
    updatedAt: row.latest_proposal_at > row.updated_at
      ? row.latest_proposal_at
      : row.updated_at,
  };
}

function mapAdminNeed(row) {
  return {
    ...mapPublicNeed(row),
    projectId: row.project_id,
    requirements: row.expectations,
    orderNo: asNumber(row.order_no),
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at,
  };
}

function projectStats(needs) {
  const active = needs.filter((need) => !need.archivedAt);
  const committed = active.filter((need) => need.statusKey === 'committed').length;
  return {
    activeNeeds: active.length,
    committedNeeds: committed,
    completionPercent: active.length ? Math.round((committed / active.length) * 100) : 0,
    followers: active.reduce((sum, need) => sum + need.stats.followers, 0),
    interests: active.reduce((sum, need) => sum + need.stats.interests, 0),
    proposals: active.reduce((sum, need) => sum + need.stats.proposals, 0),
  };
}

function needQuery(includeArchived) {
  return `
    SELECT n.*,
           COALESCE(vi.followers, 0) AS followers,
           COALESCE(vi.interests, 0) AS interests,
           COALESCE(ps.proposal_count, 0) AS proposal_count,
           COALESCE(ps.accepted_count, 0) AS accepted_count,
           COALESCE(ps.negotiating_count, 0) AS negotiating_count,
           COALESCE(ps.review_count, 0) AS review_count,
           COALESCE(ps.latest_proposal_at, '') AS latest_proposal_at,
           COALESCE(mine.following, 0) AS viewer_following,
           COALESCE(mine.interested, 0) AS viewer_interested
    FROM needs n
    LEFT JOIN (
      SELECT need_id,
             SUM(following) AS followers,
             SUM(interested) AS interests
      FROM viewer_interactions
      GROUP BY need_id
    ) vi ON vi.need_id = n.id
    LEFT JOIN (
      SELECT need_id,
             COUNT(*) AS proposal_count,
             SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted_count,
             SUM(CASE WHEN status='negotiating' THEN 1 ELSE 0 END) AS negotiating_count,
             SUM(CASE WHEN status IN ('new','contacted') THEN 1 ELSE 0 END) AS review_count,
             MAX(updated_at) AS latest_proposal_at
      FROM proposals
      GROUP BY need_id
    ) ps ON ps.need_id = n.id
    LEFT JOIN viewer_interactions mine
      ON mine.need_id = n.id AND mine.visitor_id = ?
    WHERE n.project_id = ?
      ${includeArchived ? '' : 'AND n.archived_at IS NULL'}
    ORDER BY n.archived_at IS NOT NULL, n.order_no, n.created_at, n.id
  `;
}

function mapProposalSummary(row) {
  const contributionPreview =
    row.contribution.length > 160
      ? `${row.contribution.slice(0, 157)}…`
      : row.contribution;
  return {
    id: row.id,
    referenceCode: row.id.slice(0, 8).toUpperCase(),
    need: {
      id: row.need_id,
      title: row.need_title,
    },
    applicantName: row.applicant_name,
    mobile: row.mobile,
    contribution: contributionPreview,
    contributionPreview,
    status: row.status,
    statusKey: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProposalDetail(row, events = []) {
  return {
    id: row.id,
    referenceCode: row.id.slice(0, 8).toUpperCase(),
    need: {
      id: row.need_id,
      title: row.need_title,
      projectSlug: row.project_slug,
    },
    applicantName: row.applicant_name,
    mobile: row.mobile,
    email: row.email,
    contribution: row.contribution,
    availability: row.availability,
    notes: row.notes,
    consent: Boolean(row.consent),
    status: row.status,
    statusKey: row.status,
    decisionMessage: row.decision_message,
    internalNote: row.internal_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    events: events.map((event) => ({
      id: asNumber(event.id),
      type: event.event_type,
      actorType: event.actor_type,
      fromStatus: event.from_status,
      toStatus: event.to_status,
      message: event.message,
      visibility: event.visibility,
      createdAt: event.created_at,
    })),
  };
}

export function proposalRequestHash(proposal) {
  return createHash('sha256')
    .update(JSON.stringify([
      proposal.applicantName,
      proposal.mobile,
      proposal.email || null,
      proposal.contribution,
      proposal.availability || null,
      proposal.notes || null,
      true,
    ]))
    .digest('base64url');
}

function proposalTrackingToken(proposalId, needId, idempotencyKey) {
  return createHash('sha256')
    .update('hamkari:proposal-tracking:v1')
    .update('\0')
    .update(String(proposalId))
    .update('\0')
    .update(String(needId))
    .update('\0')
    .update(String(idempotencyKey))
    .digest('base64url');
}

export function createStore(db, options) {
  const clock = options.clock || (() => new Date());
  const publicOrigin = options.publicOrigin;
  const audit = options.audit || (() => {});

  const getProject = db.prepare(`
    SELECT id, organization_id, slug, title, subtitle, summary, leader_name, leader_description,
           location, timeline, target_date, process_description, status,
           active, industry, sector, kind, stage, currency, budget_amount,
           valuation_amount, start_date, created_at, updated_at
    FROM projects
    WHERE slug = ? AND status='published' AND visibility<>'private'
      AND archived_at IS NULL
  `);
  const getManagedProject = db.prepare(`
    SELECT id, organization_id, slug, title, subtitle, summary, leader_name, leader_description,
           location, timeline, target_date, process_description, status,
           active, industry, sector, kind, stage, currency, budget_amount,
           valuation_amount, start_date, created_at, updated_at
    FROM projects
    WHERE archived_at IS NULL
    ORDER BY active DESC, created_at, id
    LIMIT 1
  `);
  const getManagedProjectById = db.prepare(`
    SELECT id, organization_id, slug, title, subtitle, summary, leader_name, leader_description,
           location, timeline, target_date, process_description, status,
           active, industry, sector, kind, stage, currency, budget_amount,
           valuation_amount, start_date, created_at, updated_at
    FROM projects
    WHERE id=? AND archived_at IS NULL
  `);
  const getCurrentPublicProject = db.prepare(`
    SELECT slug
    FROM projects
    WHERE status='published' AND visibility='public' AND archived_at IS NULL
    ORDER BY active DESC, created_at, id
    LIMIT 1
  `);
  const getPublicNeeds = db.prepare(needQuery(false));
  const getAdminNeeds = db.prepare(needQuery(true));

  function requireProjectBySlug(slug) {
    const row = getProject.get(slug);
    if (!row) throw notFound('PROJECT_NOT_FOUND', 'پروژه موردنظر پیدا نشد.');
    return row;
  }

  function requireManagedProject(projectId = null) {
    const row = projectId
      ? getManagedProjectById.get(projectId)
      : getManagedProject.get();
    if (!row) throw notFound('PROJECT_NOT_FOUND', 'پروژه‌ای برای مدیریت وجود ندارد.');
    return row;
  }

  function publicProject(slug, visitorId) {
    const row = requireProjectBySlug(slug);
    const needs = getPublicNeeds.all(visitorId, row.id).map(mapPublicNeed);
    const project = publicProjectRow(row);
    project.stats = projectStats(needs);
    project.needs = needs;
    return { project };
  }

  function publicNeedById(id, visitorId) {
    const row = db.prepare(`
      SELECT p.slug FROM needs n
      JOIN projects p ON p.id=n.project_id
      WHERE n.id=? AND n.archived_at IS NULL
    `).get(id);
    if (!row) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');
    const payload = publicProject(row.slug, visitorId);
    return payload.project.needs.find((need) => need.id === id);
  }

  function setViewerState(needId, visitorId, state) {
    const now = isoNow(clock);
    withTransaction(db, () => {
      const need = db.prepare(`
        SELECT n.id, n.project_id FROM needs n
        JOIN projects p ON p.id=n.project_id
        WHERE n.id=? AND n.archived_at IS NULL
          AND p.status='published' AND p.visibility<>'private'
          AND p.archived_at IS NULL
      `).get(needId);
      if (!need) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');
      if (!state.following && !state.interested) {
        db.prepare(`
          UPDATE viewer_interactions
          SET following=0, interested=0, updated_at=?
          WHERE need_id=? AND visitor_id=?
        `).run(now, needId, visitorId);
        db.prepare(`
          DELETE FROM viewer_interactions
          WHERE need_id=? AND visitor_id=? AND first_viewed_at IS NULL
        `).run(needId, visitorId);
      } else {
        db.prepare(`
          INSERT INTO viewer_interactions(
            need_id, visitor_id, following, interested, first_viewed_at, created_at, updated_at
          ) VALUES(?,?,?,?,NULL,?,?)
          ON CONFLICT(need_id, visitor_id) DO UPDATE SET
            following=excluded.following,
            interested=excluded.interested,
            updated_at=excluded.updated_at
        `).run(
          needId,
          visitorId,
          state.following ? 1 : 0,
          state.interested ? 1 : 0,
          now,
          now,
        );
      }
    });
    return { need: publicNeedById(needId, visitorId) };
  }

  function createProposal(needId, visitorId, idempotencyKey, input) {
    const idempotencyHash = hashToken(idempotencyKey);
    const requestHash = proposalRequestHash(input);
    let trackingToken;
    let trackingHash;
    let proposalId;
    let idempotentReplay = false;

    withTransaction(db, () => {
      const existing = db.prepare(`
        SELECT id, request_hash, tracking_token_hash FROM proposals
        WHERE need_id=? AND idempotency_key_hash=?
      `).get(needId, idempotencyHash);
      if (existing) {
        trackingToken = proposalTrackingToken(existing.id, needId, idempotencyKey);
        trackingHash = hashToken(trackingToken);
        if (existing.request_hash !== requestHash) {
          throw conflict(
            'IDEMPOTENCY_CONFLICT',
            'این کلید قبلاً برای پیشنهاد دیگری استفاده شده است.',
          );
        }
        if (existing.tracking_token_hash !== trackingHash) {
          throw conflict(
            'IDEMPOTENCY_REPLAY_UNAVAILABLE',
            'پیشنهاد قبلاً ثبت شده است، اما لینک پیگیری آن باید از همان مرورگر اولیه استفاده شود.',
          );
        }
        proposalId = existing.id;
        idempotentReplay = true;
        return;
      }

      const need = db.prepare(`
        SELECT n.id,n.project_id,p.organization_id FROM needs n
        JOIN projects p ON p.id=n.project_id
        WHERE n.id=? AND n.archived_at IS NULL
          AND p.status='published' AND p.visibility<>'private'
          AND p.archived_at IS NULL
      `).get(needId);
      if (!need) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');

      const now = isoNow(clock);
      proposalId = randomUUID();
      trackingToken = proposalTrackingToken(proposalId, needId, idempotencyKey);
      trackingHash = hashToken(trackingToken);
      db.prepare(`
        INSERT INTO proposals(
          id, need_id, visitor_id, applicant_name, mobile, email,
          contribution, availability, notes, consent, status,
          tracking_token_hash, idempotency_key_hash, request_hash,
          created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,1,'new',?,?,?,?,?)
      `).run(
        proposalId,
        needId,
        visitorId,
        input.applicantName,
        input.mobile,
        nullable(input.email),
        input.contribution,
        nullable(input.availability),
        nullable(input.notes),
        trackingHash,
        idempotencyHash,
        requestHash,
        now,
        now,
      );
      db.prepare(`
        INSERT INTO proposal_events(
          proposal_id, actor_type, actor_id, event_type,
          from_status, to_status, message, visibility, created_at
        ) VALUES(?, 'applicant', ?, 'created', NULL, 'new', NULL, 'applicant', ?)
      `).run(proposalId, visitorId, now);
      db.prepare(`
        UPDATE projects SET updated_at=?
        WHERE id=(SELECT project_id FROM needs WHERE id=?)
      `).run(now, needId);
      audit({
        organizationId: need.organization_id,
        projectId: need.project_id,
        actorType: 'system',
        actorId: visitorId,
        action: 'proposal.created',
        resourceType: 'proposal',
        resourceId: proposalId,
        after: {
          needId,
          status: 'new',
          consent: true,
        },
        metadata: {
          actorKind: 'applicant',
        },
      });
    });

    const proposal = db.prepare(`
      SELECT id, need_id, status, created_at, updated_at
      FROM proposals WHERE id=?
    `).get(proposalId);
    return {
      proposal: {
        id: proposal.id,
        needId: proposal.need_id,
        statusKey: proposal.status,
        trackingToken,
        trackingUrl: `${publicOrigin}/my-proposals#token=${encodeURIComponent(trackingToken)}`,
        createdAt: proposal.created_at,
        updatedAt: proposal.updated_at,
      },
      idempotentReplay,
    };
  }

  function trackProposal(trackingToken) {
    const row = db.prepare(`
      SELECT p.id, p.applicant_name, p.contribution, p.status, p.decision_message,
             p.created_at, p.updated_at, p.decided_at,
             n.id AS need_id, n.title AS need_title,
             pr.slug AS project_slug, pr.title AS project_title
      FROM proposals p
      JOIN needs n ON n.id=p.need_id
      JOIN projects pr ON pr.id=n.project_id
      WHERE p.tracking_token_hash=?
    `).get(hashToken(trackingToken));
    if (!row) throw notFound('PROPOSAL_NOT_FOUND', 'پیشنهادی با این کد پیگیری پیدا نشد.');
    const events = db.prepare(`
      SELECT id, event_type, from_status, to_status, message, created_at
      FROM proposal_events
      WHERE proposal_id=? AND visibility='applicant'
      ORDER BY created_at, id
    `).all(row.id);
    return {
      proposal: {
        id: row.id,
        applicantName: row.applicant_name,
        contribution: row.contribution,
        statusKey: row.status,
        decisionMessage: row.decision_message,
        need: {
          id: row.need_id,
          title: row.need_title,
        },
        project: {
          slug: row.project_slug,
          title: row.project_title,
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        decidedAt: row.decided_at,
        events: events.map((event) => ({
          id: asNumber(event.id),
          type: event.event_type,
          fromStatus: event.from_status,
          toStatus: event.to_status,
          message: event.message,
          createdAt: event.created_at,
        })),
      },
    };
  }

  function adminProject(projectId = null) {
    const row = requireManagedProject(projectId);
    const needs = getAdminNeeds.all('', row.id).map(mapAdminNeed);
    const project = {
      ...publicProjectRow(row),
      leaderName: row.leader_name,
      leaderDescription: row.leader_description,
      targetDate: row.target_date || null,
      status: row.status,
      active: Boolean(row.active),
      createdAt: row.created_at,
      stats: projectStats(needs),
    };
    return { project, needs };
  }

  function updateProject(input) {
    const current = requireManagedProject();
    const now = isoNow(clock);
    const next = {
      slug: input.slug ?? current.slug,
      title: input.title ?? current.title,
      subtitle: input.subtitle ?? current.subtitle,
      summary: input.summary ?? current.summary,
      location: input.location ?? current.location,
      timeline: input.timeline ?? current.timeline,
      targetDate: input.targetDate ?? current.target_date,
      leaderName: input.leaderName ?? current.leader_name,
      leaderDescription: input.leaderDescription ?? current.leader_description,
      processDescription: input.processDescription ?? current.process_description,
      status: input.status ?? current.status,
    };
    withTransaction(db, () => {
      const slugOwner = db.prepare('SELECT id FROM projects WHERE slug=? AND id<>?')
        .get(next.slug, current.id);
      if (slugOwner) {
        throw conflict('PROJECT_SLUG_TAKEN', 'این نشانی کوتاه قبلاً استفاده شده است.');
      }
      db.prepare(`
        UPDATE projects SET
          slug=?, title=?, subtitle=?, summary=?, location=?, timeline=?,
          target_date=?, leader_name=?, leader_description=?,
          process_description=?, status=?, active=?, updated_at=?
        WHERE id=?
      `).run(
        next.slug,
        next.title,
        next.subtitle,
        next.summary,
        next.location,
        next.timeline,
        next.targetDate,
        next.leaderName,
        next.leaderDescription,
        next.processDescription,
        next.status,
        current.active,
        now,
        current.id,
      );
      audit({
        organizationId: current.organization_id,
        projectId: current.id,
        action: 'legacy.project.updated',
        resourceType: 'project',
        resourceId: current.id,
        before: { slug: current.slug, title: current.title, status: current.status },
        after: { slug: next.slug, title: next.title, status: next.status },
      });
    });
    return adminProject();
  }

  function createNeed(input, projectId = null) {
    const project = requireManagedProject(projectId);
    const now = isoNow(clock);
    const id = randomUUID();
    withTransaction(db, () => {
      const activeCount = asNumber(db.prepare(`
        SELECT COUNT(*) AS count
        FROM needs WHERE project_id=? AND archived_at IS NULL
      `).get(project.id).count);
      if (activeCount >= 500) {
        throw conflict(
          'ACTIVE_NEED_LIMIT_REACHED',
          'حداکثر ۵۰۰ نیاز فعال برای یک پروژه قابل تعریف است؛ ابتدا نیازهای پایان‌یافته را آرشیو کنید.',
        );
      }
      const nextOrder = asNumber(db.prepare(`
        SELECT COALESCE(MAX(order_no),0)+1 AS next_order
        FROM needs WHERE project_id=? AND archived_at IS NULL
      `).get(project.id).next_order);
      const selectedOrder = Math.min(input.orderNo || nextOrder, nextOrder);
      if (selectedOrder < nextOrder) {
        db.prepare(`
          UPDATE needs SET order_no=order_no+1, updated_at=?
          WHERE project_id=? AND archived_at IS NULL AND order_no>=?
        `).run(now, project.id, selectedOrder);
      }
      db.prepare(`
        INSERT INTO needs(
          id, project_id, title, description, category, target_value,
          expectations, order_no, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        id,
        project.id,
        input.title,
        input.description,
        input.category,
        input.targetValue,
        input.expectations,
        selectedOrder,
        now,
        now,
      );
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, project.id);
      audit({
        organizationId: project.organization_id,
        projectId: project.id,
        action: 'legacy.need.created',
        resourceType: 'need',
        resourceId: id,
        after: { title: input.title, category: input.category },
      });
    });
    return {
      need: adminProject(project.id).needs.find((need) => need.id === id),
    };
  }

  function updateNeed(id, input, projectId = null) {
    const project = requireManagedProject(projectId);
    const current = db.prepare(`
      SELECT * FROM needs WHERE id=? AND project_id=?
    `).get(id, project.id);
    if (!current) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');
    const now = isoNow(clock);
    withTransaction(db, () => {
      if (
        input.orderNo !== undefined &&
        !current.archived_at &&
        input.orderNo !== asNumber(current.order_no)
      ) {
        const maximum = asNumber(db.prepare(`
          SELECT COUNT(*) AS count FROM needs
          WHERE project_id=? AND archived_at IS NULL
        `).get(current.project_id).count);
        const selectedOrder = Math.min(input.orderNo, maximum);
        if (selectedOrder < current.order_no) {
          db.prepare(`
            UPDATE needs SET order_no=order_no+1, updated_at=?
            WHERE project_id=? AND archived_at IS NULL
              AND order_no>=? AND order_no<?
          `).run(now, current.project_id, selectedOrder, current.order_no);
        } else {
          db.prepare(`
            UPDATE needs SET order_no=order_no-1, updated_at=?
            WHERE project_id=? AND archived_at IS NULL
              AND order_no>? AND order_no<=?
          `).run(now, current.project_id, current.order_no, selectedOrder);
        }
        current.order_no = selectedOrder;
      }
      db.prepare(`
        UPDATE needs SET title=?, description=?, category=?, target_value=?,
          expectations=?, order_no=?, updated_at=? WHERE id=?
      `).run(
        input.title ?? current.title,
        input.description ?? current.description,
        input.category ?? current.category,
        input.targetValue ?? current.target_value,
        input.expectations ?? current.expectations,
        current.order_no,
        now,
        id,
      );
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, current.project_id);
      audit({
        organizationId: project.organization_id,
        projectId: project.id,
        action: 'legacy.need.updated',
        resourceType: 'need',
        resourceId: id,
        before: {
          title: current.title,
          category: current.category,
          orderNo: Number(current.order_no),
        },
        after: {
          title: input.title ?? current.title,
          category: input.category ?? current.category,
          orderNo: Number(current.order_no),
        },
      });
    });
    return {
      need: adminProject(project.id).needs.find((need) => need.id === id),
    };
  }

  function archiveNeed(id, projectId = null) {
    const project = requireManagedProject(projectId);
    const current = db.prepare(`
      SELECT project_id, archived_at, order_no FROM needs
      WHERE id=? AND project_id=?
    `).get(id, project.id);
    if (!current) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');
    if (!current.archived_at) {
      const now = isoNow(clock);
      withTransaction(db, () => {
        db.prepare('UPDATE needs SET archived_at=?, updated_at=? WHERE id=?')
          .run(now, now, id);
        db.prepare(`
          UPDATE needs SET order_no=order_no-1, updated_at=?
          WHERE project_id=? AND archived_at IS NULL AND order_no>?
        `).run(now, current.project_id, current.order_no);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=?')
          .run(now, current.project_id);
        audit({
          organizationId: project.organization_id,
          projectId: project.id,
          action: 'legacy.need.archived',
          resourceType: 'need',
          resourceId: id,
        });
      });
    }
    return { archived: true, id };
  }

  function reorderNeeds(ids, projectId = null) {
    const project = requireManagedProject(projectId);
    const activeIds = db.prepare(`
      SELECT id FROM needs WHERE project_id=? AND archived_at IS NULL ORDER BY order_no, id
    `).all(project.id).map((row) => row.id);
    const unique = new Set(ids);
    const valid =
      unique.size === ids.length &&
      ids.length === activeIds.length &&
      activeIds.every((id) => unique.has(id));
    if (!valid) {
      throw conflict(
        'INVALID_NEED_ORDER',
        'فهرست ترتیب باید دقیقاً شامل تمام نیازهای فعال باشد.',
      );
    }
    const now = isoNow(clock);
    withTransaction(db, () => {
      const update = db.prepare(`
        UPDATE needs SET order_no=?, updated_at=? WHERE id=? AND project_id=?
      `);
      ids.forEach((id, index) => update.run(index + 1, now, id, project.id));
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, project.id);
      audit({
        organizationId: project.organization_id,
        projectId: project.id,
        action: 'legacy.needs.reordered',
        resourceType: 'need_order',
        resourceId: project.id,
        metadata: { ids },
      });
    });
    return {
      needs: adminProject(project.id).needs.filter((need) => !need.archivedAt),
    };
  }

  function proposalList(filters = {}) {
    const project = requireManagedProject(filters.projectId || null);
    const clauses = ['n.project_id=?'];
    const parameters = [project.id];
    if (filters.status) {
      clauses.push('p.status=?');
      parameters.push(filters.status);
    }
    if (filters.needId) {
      clauses.push('p.need_id=?');
      parameters.push(filters.needId);
    }
    if (filters.query) {
      clauses.push(`(
        p.applicant_name LIKE ? ESCAPE '\\'
        OR p.mobile LIKE ? ESCAPE '\\'
        OR p.contribution LIKE ? ESCAPE '\\'
      )`);
      const escaped = filters.query.replace(/[\\%_]/g, '\\$&');
      parameters.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters.limit || 200;
    const offset = filters.offset || 0;
    const matching = asNumber(db.prepare(`
      SELECT COUNT(*) AS count
      FROM proposals p
      JOIN needs n ON n.id=p.need_id
      ${where}
    `).get(...parameters).count);
    const rows = db.prepare(`
      SELECT p.id, p.need_id, n.title AS need_title, p.applicant_name,
             p.mobile, p.contribution, p.status, p.created_at, p.updated_at
      FROM proposals p
      JOIN needs n ON n.id=p.need_id
      ${where}
      ORDER BY
        CASE p.status
          WHEN 'new' THEN 1
          WHEN 'contacted' THEN 2
          WHEN 'negotiating' THEN 3
          WHEN 'accepted' THEN 4
          ELSE 5
        END,
        p.updated_at DESC,
        p.id
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset);
    const counts = Object.fromEntries(PROPOSAL_STATUSES.map((status) => [status, 0]));
    let total = 0;
    for (const row of db.prepare(`
      SELECT p.status, COUNT(*) AS count
      FROM proposals p
      JOIN needs n ON n.id=p.need_id
      WHERE n.project_id=?
      GROUP BY p.status
    `).all(project.id)) {
      counts[row.status] = asNumber(row.count);
      total += asNumber(row.count);
    }
    return {
      proposals: rows.map(mapProposalSummary),
      summary: { total, ...counts },
      pagination: {
        limit,
        offset,
        returned: rows.length,
        matching,
        hasMore: offset + rows.length < matching,
        nextOffset: offset + rows.length < matching ? offset + rows.length : null,
      },
    };
  }

  function proposalDetail(id, projectId = null) {
    const project = requireManagedProject(projectId);
    const row = db.prepare(`
      SELECT p.*, n.title AS need_title, pr.slug AS project_slug
      FROM proposals p
      JOIN needs n ON n.id=p.need_id
      JOIN projects pr ON pr.id=n.project_id
      WHERE p.id=? AND pr.id=?
    `).get(id, project.id);
    if (!row) throw notFound('PROPOSAL_NOT_FOUND', 'پیشنهاد موردنظر پیدا نشد.');
    const events = db.prepare(`
      SELECT id, actor_type, event_type, from_status, to_status,
             message, visibility, created_at
      FROM proposal_events WHERE proposal_id=?
      ORDER BY created_at, id
    `).all(id);
    return { proposal: mapProposalDetail(row, events) };
  }

  function updateProposal(id, patch, adminSessionId, projectId = null) {
    const managedProject = requireManagedProject(projectId);
    const mutationActor = proposalMutationActor(adminSessionId);
    withTransaction(db, () => {
      const current = db.prepare(`
        SELECT p.* FROM proposals p
        JOIN needs n ON n.id=p.need_id
        WHERE p.id=? AND n.project_id=?
      `).get(id, managedProject.id);
      if (!current) throw notFound('PROPOSAL_NOT_FOUND', 'پیشنهاد موردنظر پیدا نشد.');
      const now = isoNow(clock);
      const nextStatus = patch.status || current.status;
      const statusChanged = nextStatus !== current.status;
      if (statusChanged) {
        const allowed =
          (current.status === 'new' && ['contacted', 'rejected'].includes(nextStatus)) ||
          (current.status === 'contacted' && ['negotiating', 'rejected'].includes(nextStatus)) ||
          (current.status === 'negotiating' && ['accepted', 'rejected'].includes(nextStatus)) ||
          (current.status === 'rejected' && nextStatus === 'new') ||
          (
            current.status === 'accepted' &&
            nextStatus === 'negotiating' &&
            patch.confirmUnaccept === true
          );
        if (!allowed) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `تغییر وضعیت از ${current.status} به ${nextStatus} مجاز نیست.`,
          );
        }
        if (nextStatus === 'accepted') {
          const accepted = db.prepare(`
            SELECT id FROM proposals
            WHERE need_id=? AND status='accepted' AND id<>?
          `).get(current.need_id, id);
          if (accepted) {
            throw conflict(
              'NEED_ALREADY_COMMITTED',
              'برای این نیاز قبلاً یک پیشنهاد پذیرفته شده است.',
            );
          }
        }
      }

      const nextDecision =
        statusChanged && !['accepted', 'rejected'].includes(nextStatus)
          ? null
          : (
            patch.decisionMessage !== undefined
              ? nullable(patch.decisionMessage)
              : current.decision_message
          );
      const nextInternal = patch.internalNote !== undefined
        ? nullable(patch.internalNote)
        : current.internal_note;
      if (
        nextStatus === 'rejected' &&
        (
          typeof nextDecision !== 'string' ||
          nextDecision.trim().length < 3
        )
      ) {
        throw badRequest(
          'DECISION_MESSAGE_REQUIRED',
          'پیشنهاد ردشده باید پیام تصمیم قابل مشاهده برای متقاضی داشته باشد.',
          { decisionMessage: 'دلیل رد پیشنهاد را وارد کنید.' },
        );
      }
      const decisionChanged = nextDecision !== current.decision_message;
      const internalChanged = nextInternal !== current.internal_note;
      if (!statusChanged && !decisionChanged && !internalChanged) return;
      const decidedAt = statusChanged
        ? (['accepted', 'rejected'].includes(nextStatus) ? now : null)
        : current.decided_at;

      db.prepare(`
        UPDATE proposals SET status=?, decision_message=?, internal_note=?,
          updated_at=?, decided_at=? WHERE id=?
      `).run(nextStatus, nextDecision, nextInternal, now, decidedAt, id);

      const insertEvent = db.prepare(`
        INSERT INTO proposal_events(
          proposal_id, actor_type, actor_id, event_type,
          from_status, to_status, message, visibility, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (statusChanged) {
        insertEvent.run(
          id,
          mutationActor.eventActorType,
          mutationActor.actorId,
          'status_changed',
          current.status,
          nextStatus,
          nextDecision,
          'applicant',
          now,
        );
      } else if (
        patch.decisionMessage !== undefined &&
        decisionChanged
      ) {
        insertEvent.run(
          id,
          mutationActor.eventActorType,
          mutationActor.actorId,
          'decision_message',
          current.status,
          current.status,
          nextDecision,
          'applicant',
          now,
        );
      }
      if (
        patch.internalNote !== undefined &&
        internalChanged
      ) {
        insertEvent.run(
          id,
          mutationActor.eventActorType,
          mutationActor.actorId,
          'internal_note',
          current.status,
          nextStatus,
          nextInternal || 'یادداشت داخلی پاک شد.',
          'admin',
          now,
        );
      }
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?')
        .run(now, managedProject.id);
      audit({
        organizationId: managedProject.organization_id,
        projectId: managedProject.id,
        actorType: mutationActor.auditActorType,
        actorId: mutationActor.actorId,
        actorUserId: mutationActor.actorUserId,
        action: 'proposal.updated',
        resourceType: 'proposal',
        resourceId: id,
        before: {
          status: current.status,
          decisionMessage: current.decision_message,
        },
        after: {
          status: nextStatus,
          decisionMessage: nextDecision,
        },
        metadata: {
          statusChanged,
          internalNoteChanged: internalChanged,
        },
      });
    });
    return proposalDetail(id, managedProject.id);
  }

  function createAdminSession(tokenHash, csrfTokenHash, expiresAt) {
    const now = isoNow(clock);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO admin_sessions(
        id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at
      ) VALUES(?,?,?,?,?,?)
    `).run(id, tokenHash, csrfTokenHash, now, expiresAt, now);
    return { id, createdAt: now, expiresAt };
  }

  function adminSession(tokenHash) {
    const now = isoNow(clock);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now);
    const row = db.prepare(`
      SELECT id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at
      FROM admin_sessions WHERE token_hash=? AND expires_at>?
    `).get(tokenHash, now);
    if (!row) return null;
    db.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE id=?').run(now, row.id);
    return row;
  }

  function deleteAdminSession(tokenHash) {
    return asNumber(
      db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash).changes,
    );
  }

  function healthcheck() {
    return asNumber(db.prepare('SELECT 1 AS ok').get().ok) === 1;
  }

  return Object.freeze({
    publicProject,
    publicNeedById,
    setViewerState,
    createProposal,
    trackProposal,
    adminProject,
    updateProject,
    createNeed,
    updateNeed,
    archiveNeed,
    reorderNeeds,
    proposalList,
    proposalDetail,
    updateProposal,
    createAdminSession,
    adminSession,
    deleteAdminSession,
    healthcheck,
    activeProjectSlug: () => getManagedProject.get()?.slug ?? null,
    publicCurrentProjectSlug: () => {
      const row = getCurrentPublicProject.get();
      if (!row) {
        throw notFound('PROJECT_NOT_FOUND', 'پروژه منتشرشده‌ای وجود ندارد.');
      }
      return row.slug;
    },
    projectSlugForNeed: (id) => {
      const row = db.prepare(`
        SELECT p.slug FROM needs n JOIN projects p ON p.id=n.project_id WHERE n.id=?
      `).get(id);
      if (!row) throw notFound('NEED_NOT_FOUND', 'نیاز همکاری موردنظر پیدا نشد.');
      return row.slug;
    },
    proposalStatuses: PROPOSAL_STATUSES,
  });
}
