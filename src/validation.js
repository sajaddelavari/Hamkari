import { badRequest } from './errors.js';
import { normalizeIranMobile } from './security.js';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function text(value, options) {
  const selected = typeof value === 'string' ? value.trim() : '';
  if (selected.length < options.minimum || selected.length > options.maximum) {
    return {
      error: options.message,
      value: selected,
    };
  }
  return { value: selected };
}

function optionalText(value, maximum) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'string' || value.trim().length > maximum) {
    return { error: `حداکثر ${maximum} نویسه مجاز است.` };
  }
  return { value: value.trim() || null };
}

function fail(fields) {
  throw badRequest(
    'VALIDATION_FAILED',
    'اطلاعات واردشده را بررسی و دوباره تلاش کنید.',
    fields,
  );
}

export function validateViewerState(body) {
  const fields = {};
  if (typeof body.following !== 'boolean') {
    fields.following = 'وضعیت دنبال‌کردن باید مشخص باشد.';
  }
  if (typeof body.interested !== 'boolean') {
    fields.interested = 'وضعیت اعلام آمادگی باید مشخص باشد.';
  }
  if (Object.keys(fields).length) fail(fields);
  return {
    following: body.following,
    interested: body.interested,
  };
}

export function validateIdempotencyKey(value) {
  const selected = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{32,128}$/.test(selected)) {
    throw badRequest(
      'INVALID_IDEMPOTENCY_KEY',
      'هدر Idempotency-Key باید بین ۳۲ تا ۱۲۸ نویسه معتبر و تصادفی باشد.',
    );
  }
  return selected;
}

export function validateProposal(body) {
  if (typeof body.website === 'string' && body.website.trim()) {
    throw badRequest('SPAM_DETECTED', 'امکان ثبت این درخواست وجود ندارد.');
  }
  const fields = {};
  const applicant = text(body.applicantName, {
    minimum: 2,
    maximum: 120,
    message: 'نام فرد یا مجموعه باید بین ۲ تا ۱۲۰ نویسه باشد.',
  });
  if (applicant.error) fields.applicantName = applicant.error;

  const mobile = normalizeIranMobile(body.mobile);
  if (!mobile) fields.mobile = 'شماره موبایل ایران را با قالب درست وارد کنید.';

  let email = null;
  if (body.email !== undefined && body.email !== null && String(body.email).trim()) {
    email = String(body.email).trim().toLowerCase();
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
    ) {
      fields.email = 'نشانی ایمیل معتبر نیست.';
    }
  }

  const contribution = text(body.contribution, {
    minimum: 20,
    maximum: 1000,
    message: 'شرح آورده و ظرفیت باید بین ۲۰ تا ۱۰۰۰ نویسه باشد.',
  });
  if (contribution.error) fields.contribution = contribution.error;

  const availability = optionalText(body.availability, 200);
  if (availability.error) fields.availability = availability.error;
  const notes = optionalText(body.notes, 1000);
  if (notes.error) fields.notes = notes.error;
  if (body.consent !== true) {
    fields.consent = 'برای ادامه، رضایت تماس را تأیید کنید.';
  }
  if (Object.keys(fields).length) fail(fields);
  return {
    applicantName: applicant.value,
    mobile,
    email,
    contribution: contribution.value,
    availability: availability.value,
    notes: notes.value,
    consent: true,
  };
}

export function validateAdminLogin(body) {
  if (
    typeof body.password !== 'string' ||
    body.password.length < 1 ||
    body.password.length > 512
  ) {
    fail({ password: 'رمز عبور را وارد کنید.' });
  }
  return { password: body.password };
}

export function validateProject(body) {
  const fields = {};
  const result = {};
  const definitions = [
    ['title', ['title'], 2, 160, 'عنوان پروژه باید بین ۲ تا ۱۶۰ نویسه باشد.'],
    ['subtitle', ['subtitle'], 0, 240, 'زیرعنوان حداکثر ۲۴۰ نویسه است.'],
    ['summary', ['summary'], 20, 3000, 'معرفی پروژه باید بین ۲۰ تا ۳۰۰۰ نویسه باشد.'],
    ['location', ['location'], 2, 200, 'موقعیت پروژه باید بین ۲ تا ۲۰۰ نویسه باشد.'],
    ['timeline', ['timeline'], 0, 500, 'زمان‌بندی حداکثر ۵۰۰ نویسه است.'],
    ['leaderName', ['leaderName', 'ownerName'], 2, 160, 'نام راهبر باید بین ۲ تا ۱۶۰ نویسه باشد.'],
    ['leaderDescription', ['leaderDescription', 'ownerSummary'], 0, 1000, 'معرفی راهبر حداکثر ۱۰۰۰ نویسه است.'],
    ['processDescription', ['processDescription'], 0, 2000, 'شرح فرآیند حداکثر ۲۰۰۰ نویسه است.'],
  ];
  for (const [outputKey, aliases, minimum, maximum, message] of definitions) {
    const inputKey = aliases.find((key) => hasOwn(body, key));
    if (!inputKey) continue;
    const value = text(body[inputKey], { minimum, maximum, message });
    if (value.error) fields[outputKey] = value.error;
    else result[outputKey] = value.value;
  }
  if (hasOwn(body, 'slug')) {
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
      fields.slug = 'نشانی کوتاه باید ۱ تا ۸۰ نویسه و فقط شامل حروف انگلیسی کوچک، عدد و خط تیره باشد.';
    } else {
      result.slug = slug;
    }
  }
  if (hasOwn(body, 'targetDate')) {
    const targetDate = String(body.targetDate || '').trim();
    if (
      targetDate &&
      (
        !/^\d{4}-\d{2}-\d{2}$/.test(targetDate) ||
        Number.isNaN(Date.parse(`${targetDate}T00:00:00.000Z`)) ||
        new Date(`${targetDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== targetDate
      )
    ) {
      fields.targetDate = 'موعد هدف باید یک تاریخ معتبر باشد.';
    } else {
      result.targetDate = targetDate;
    }
  }
  if (hasOwn(body, 'status')) {
    if (!['draft', 'published'].includes(body.status)) {
      fields.status = 'وضعیت پروژه باید draft یا published باشد.';
    } else {
      result.status = body.status;
    }
  }
  if (Object.keys(fields).length) fail(fields);
  if (!Object.keys(result).length) {
    throw badRequest('EMPTY_UPDATE', 'حداقل یک فیلد پروژه را برای ویرایش ارسال کنید.');
  }
  return result;
}

const NEED_FIELDS = {
  title: [2, 160, 'عنوان نیاز باید بین ۲ تا ۱۶۰ نویسه باشد.'],
  description: [10, 1200, 'توضیح نیاز باید بین ۱۰ تا ۱۲۰۰ نویسه باشد.'],
  category: [2, 80, 'دسته‌بندی باید بین ۲ تا ۸۰ نویسه باشد.'],
  targetValue: [1, 180, 'هدف این نیاز باید مشخص باشد.'],
  expectations: [0, 1400, 'انتظارات حداکثر ۱۴۰۰ نویسه است.'],
};

export function validateNeed(body, { partial = false } = {}) {
  const fields = {};
  const result = {};
  for (const [key, [minimum, maximum, message]] of Object.entries(NEED_FIELDS)) {
    const aliases = key === 'expectations' ? ['expectations', 'requirements'] : [key];
    const inputKey = aliases.find((candidate) => hasOwn(body, candidate));
    if (partial && !inputKey) continue;
    const value = text(inputKey ? body[inputKey] : undefined, { minimum, maximum, message });
    if (value.error) fields[key] = value.error;
    else result[key] = value.value;
  }
  if (hasOwn(body, 'orderNo')) {
    const orderNo = Number(body.orderNo);
    if (!Number.isInteger(orderNo) || orderNo < 1 || orderNo > 999) {
      fields.orderNo = 'ترتیب نمایش باید عددی بین ۱ تا ۹۹۹ باشد.';
    } else {
      result.orderNo = orderNo;
    }
  }
  if (partial && !Object.keys(result).length && !Object.keys(fields).length) {
    throw badRequest('EMPTY_PATCH', 'حداقل یک فیلد برای ویرایش ارسال کنید.');
  }
  if (Object.keys(fields).length) fail(fields);
  return result;
}

export function validateNeedOrder(body) {
  const selected = body.needIds ?? body.ids;
  if (
    !Array.isArray(selected) ||
    selected.length > 500 ||
    selected.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    fail({ needIds: 'فهرست شناسه‌های نیازها معتبر نیست.' });
  }
  return selected.map((id) => id.trim());
}

const PROPOSAL_STATUS_SET = new Set([
  'new',
  'contacted',
  'negotiating',
  'accepted',
  'rejected',
]);

export function validateProposalPatch(body) {
  const patch = {};
  const fields = {};
  if (hasOwn(body, 'status')) {
    if (!PROPOSAL_STATUS_SET.has(body.status)) {
      fields.status = 'وضعیت پیشنهاد معتبر نیست.';
    } else {
      patch.status = body.status;
    }
  }
  if (hasOwn(body, 'decisionMessage')) {
    const result = optionalText(body.decisionMessage, 1000);
    if (result.error) fields.decisionMessage = result.error;
    else patch.decisionMessage = result.value;
  }
  if (hasOwn(body, 'internalNote')) {
    const result = optionalText(body.internalNote, 2000);
    if (result.error) fields.internalNote = result.error;
    else patch.internalNote = result.value;
  }
  if (hasOwn(body, 'confirmUnaccept')) {
    if (typeof body.confirmUnaccept !== 'boolean') {
      fields.confirmUnaccept = 'تأیید لغو پذیرش معتبر نیست.';
    } else {
      patch.confirmUnaccept = body.confirmUnaccept;
    }
  }
  if (
    body.status === 'rejected' &&
    (
      typeof body.decisionMessage !== 'string' ||
      body.decisionMessage.trim().length < 3
    )
  ) {
    fields.decisionMessage = 'برای رد پیشنهاد، دلیل کوتاهی برای متقاضی بنویسید.';
  }
  if (Object.keys(fields).length) fail(fields);
  if (!Object.keys(patch).some((key) => key !== 'confirmUnaccept')) {
    throw badRequest('EMPTY_PATCH', 'حداقل یک تغییر برای پیشنهاد ارسال کنید.');
  }
  return patch;
}
