import { unsealData } from './secure-data.js';
import { withTransaction } from './database.js';

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function retryDelay(attempt) {
  return Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(attempt, 8)));
}

/**
 * Durable, single-process outbox worker. Manual mode intentionally never claims
 * delivery. Sandbox mode is explicit and live mode only runs a configured
 * adapter supplied by the deployment.
 */
export function createNotificationWorker(db, options = {}) {
  const clock = options.clock || (() => new Date());
  const encryptionKey = String(options.encryptionKey || '');
  const adapters = options.adapters || {};
  const leaseMs = Number.isFinite(options.leaseMs)
    ? Math.max(30_000, Number(options.leaseMs))
    : 5 * 60 * 1000;
  let timer = null;
  let running = false;

  function claimOne() {
    const nowDate = clock();
    const now = nowDate.toISOString();
    const staleBefore = new Date(nowDate.getTime() - leaseMs).toISOString();
    return withTransaction(db, () => {
      // Older builds briefly claimed manual rows before deferring them. Recover
      // an abandoned legacy lease, but never claim a manual row for delivery:
      // only the explicit local operator CLI may reveal its sealed payload.
      db.prepare(`
        UPDATE notification_outbox
        SET status='pending',
            next_attempt_at=?,
            last_error='در انتظار تحویل دستی اپراتور',
            updated_at=?
        WHERE provider='manual'
          AND status='processing'
          AND updated_at<=?
      `).run(now, now, staleBefore);
      const row = db.prepare(`
        SELECT *
        FROM notification_outbox
        WHERE provider<>'manual'
          AND (
            (
              status='pending'
              AND (next_attempt_at IS NULL OR next_attempt_at<=?)
            ) OR (
              status='processing' AND updated_at<=?
            )
          )
        ORDER BY created_at,id
        LIMIT 1
      `).get(now, staleBefore);
      if (!row) return null;
      const claimed = db.prepare(`
        UPDATE notification_outbox
        SET status='processing',attempts=attempts+1,
            last_error=CASE
              WHEN status='processing' THEN 'بازیابی پس از پایان lease پردازش'
              ELSE last_error
            END,
            updated_at=?
        WHERE id=?
          AND provider<>'manual'
          AND (
            (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
            OR (status='processing' AND updated_at<=?)
          )
      `).run(now, row.id, now, staleBefore);
      return Number(claimed.changes) === 1
        ? {
          ...row,
          attempts: Number(row.attempts) + 1,
          claimUpdatedAt: now,
        }
        : null;
    }, 'IMMEDIATE');
  }

  function payload(row) {
    const envelope = parseJson(row.payload_json, {});
    if (!envelope.sealed) throw new Error('Outbox payload is not sealed.');
    return parseJson(
      unsealData(
        envelope.sealed,
        encryptionKey,
        `notification-outbox:${row.id}`,
      ),
      {},
    );
  }

  function markSent(row) {
    const now = clock().toISOString();
    db.prepare(`
      UPDATE notification_outbox
      SET status='sent',sent_at=?,next_attempt_at=NULL,last_error='',updated_at=?
      WHERE id=? AND status='processing' AND attempts=? AND updated_at=?
    `).run(now, now, row.id, row.attempts, row.claimUpdatedAt);
  }

  function markFailed(row, error) {
    const now = clock();
    const terminal = row.attempts >= 8;
    db.prepare(`
      UPDATE notification_outbox
      SET status=?,next_attempt_at=?,last_error=?,updated_at=?
      WHERE id=? AND status='processing' AND attempts=? AND updated_at=?
    `).run(
      terminal ? 'failed' : 'pending',
      terminal
        ? null
        : new Date(now.getTime() + retryDelay(row.attempts)).toISOString(),
      String(error?.message || error || 'ارسال ناموفق بود.').slice(0, 1000),
      now.toISOString(),
      row.id,
      row.attempts,
      row.claimUpdatedAt,
    );
  }

  async function deliver(row) {
    const provider = String(row.provider || '');
    if (provider === 'manual') {
      // Defensive invariant: claimOne excludes these rows. Do not decrypt one
      // even if a future caller invokes deliver with a forged/manual record.
      throw new Error('Manual notifications require the local operator CLI.');
    }
    if (provider === 'sandbox') {
      // Sandbox is never presented as a real external delivery.
      payload(row);
      markSent(row);
      return { id: row.id, delivered: true, sandbox: true };
    }
    const adapter = adapters[provider];
    if (!adapter || typeof adapter.send !== 'function') {
      throw new Error(`Provider adapter "${provider}" is not configured.`);
    }
    const result = await adapter.send({
      id: row.id,
      channel: row.channel,
      destination: row.destination,
      templateKey: row.template_key,
      payload: payload(row),
    });
    if (!result?.accepted) {
      throw new Error(result?.message || 'Provider rejected the notification.');
    }
    markSent(row);
    return { id: row.id, delivered: true, providerReference: result.reference || null };
  }

  async function runOnce() {
    if (running) return { processed: false, reason: 'BUSY' };
    running = true;
    try {
      const row = claimOne();
      if (!row) return { processed: false, reason: 'EMPTY' };
      try {
        return { processed: true, ...(await deliver(row)) };
      } catch (error) {
        markFailed(row, error);
        return {
          processed: true,
          delivered: false,
          id: row.id,
          error: String(error?.message || error),
        };
      }
    } finally {
      running = false;
    }
  }

  function start(intervalMs = 15_000) {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch(() => {
        // Durable row state captures delivery errors; the application logger
        // can observe metrics without leaking destinations or payloads.
      });
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ runOnce, start, stop });
}
