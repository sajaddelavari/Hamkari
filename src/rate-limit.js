import { AppError } from './errors.js';

export class MemoryRateLimiter {
  constructor({ now = () => Date.now(), sweepIntervalMs = 60_000 } = {}) {
    this.now = now;
    this.entries = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  consume(bucket, key, { limit, windowMs }) {
    const now = this.now();
    const mapKey = `${bucket}:${key}`;
    let entry = this.entries.get(mapKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(mapKey, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      const error = new AppError(
        429,
        'RATE_LIMITED',
        'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.',
      );
      error.retryAfter = retryAfter;
      throw error;
    }
    return {
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  sweep() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }

  close() {
    clearInterval(this.sweepTimer);
    this.entries.clear();
  }
}

