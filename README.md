# هم‌ساخت

اتاق مشارکت سبک و فارسی برای تبدیل نیازهای یک پروژه به پیشنهادهای قابل پیگیری و تعهدهای واقعی.

هم‌ساخت سه تجربه دارد:

- صفحه عمومی پروژه و نیازهای همکاری
- فرم پیشنهاد و لینک خصوصی پیگیری
- پنل مدیر برای تماس، مذاکره، پذیرش یا رد پیشنهاد

پیشرفت پروژه فقط از نیازهایی محاسبه می‌شود که پیشنهادشان رسماً پذیرفته شده است. دنبال‌کردن و اعلام علاقه صرفاً شاخص تعامل‌اند و پیشرفت را تغییر نمی‌دهند.

## اجرای توسعه

نیازمندی‌ها:

- Node.js 24 یا بالاتر
- npm

```bash
npm install
npm run dev
```

سپس این نشانی‌ها در دسترس‌اند:

- صفحه عمومی: `http://localhost:3000`
- پنل مدیر: `http://localhost:3000/admin`
- سلامت سرویس: `http://localhost:3000/healthz`

در محیط توسعه، اگر `ADMIN_PASSWORD_HASH` یا `ADMIN_DEV_PASSWORD` تنظیم نشده باشد، برنامه در هر اجرا یک رمز موقت تصادفی می‌سازد و در log آغاز سرویس نشان می‌دهد. برای داشتن رمز ثابت محلی می‌توانید `ADMIN_DEV_PASSWORD` با حداقل ۱۲ نویسه تنظیم کنید. این fallback در محیط production غیرفعال است.

## تنظیم محیط production

فایل نمونه را کپی کنید:

```bash
cp .env.example .env
```

برای ساخت hash رمز مدیر، فرمان زیر را اجرا و رمز را در prompt مخفی وارد کنید:

```bash
npm run hash-password
```

برای اجرای خودکار نیز می‌توان رمز را از متغیر موقت `ADMIN_PASSWORD` یا stdin فرستاد؛ آن را به‌عنوان آرگومان فرمان ننویسید، چون ممکن است در history یا فهرست processها بماند. خروجی را در `ADMIN_PASSWORD_HASH` و داخل کوتیشن تکی قرار دهید تا علامت‌های `$` توسط Docker Compose تفسیر نشوند. `SESSION_SECRET` نیز باید یک مقدار تصادفی منحصربه‌فرد با حداقل ۳۲ نویسه باشد (برای نمونه خروجی `openssl rand -base64 48`). placeholder فایل نمونه عمداً نامعتبر است تا production با secret پیش‌فرض بالا نیاید.

متغیرهای اصلی:

| متغیر | توضیح |
|---|---|
| `NODE_ENV` | در production دقیقاً `production` |
| `PUBLIC_ORIGIN` | origin عمومی، مانند `https://ham.example.com` |
| `ADMIN_PASSWORD_HASH` | hash تولیدشده با دستور بالا |
| `SESSION_SECRET` | راز session و امضای شناسه ناشناس |
| `DATA_DIR` | پوشه پایدار SQLite؛ پیش‌فرض محلی `./data` |
| `BACKUP_DIR` | پوشه خروجی backup؛ در Docker برابر `/app/backups` |
| `DATABASE_PATH` | مسیر صریح فایل دیتابیس یا `:memory:` برای تست |
| `TRUST_PROXY` | `false` برای دسترسی مستقیم؛ IP/CIDR پراکسی معتمد برای استقرار پشت reverse proxy |
| `PORT` | پورت HTTP؛ پیش‌فرض `3000` |

پشت reverse proxy فقط IP یا CIDR همان پراکسی را در `TRUST_PROXY` قرار دهید (برای نمونه `172.16.0.0/12`). مقدار عمومی `true` در production عمداً پذیرفته نمی‌شود تا هدر جعلی `X-Forwarded-For` نتواند محدودسازی درخواست‌ها را دور بزند.

## Docker

```bash
docker compose up -d --build
```

داده‌های SQLite در volume نام‌دار `hamsakht-data` و snapshotها در `hamsakht-backups` نگهداری می‌شوند. برنامه داخل کانتینر با کاربر غیر root اجرا می‌شود و Docker healthcheck مسیر `/healthz` را بررسی می‌کند. فایل‌های دیتابیس و backup روی میزبان‌های POSIX با دسترسی `0600` و پوشه‌هایشان با `0700` ساخته می‌شوند.

پیش از اولین اجرای production، `.env` را با مقادیر واقعی تکمیل کنید.

دیتابیس خالی در development با نمونهٔ گلخانه پر می‌شود. در production این نمونه هرگز ساخته یا منتشر نمی‌شود؛ اولین اجرا فقط یک پروژهٔ خالی با وضعیت `draft` می‌سازد تا مدیر اطلاعات واقعی و نیازها را تکمیل و سپس منتشر کند.

## مدل گردش‌کار

وضعیت پیشنهاد:

```text
new → contacted → negotiating → accepted
                         └────→ rejected
```

پیشنهاد ردشده قابل بازگشایی است. لغو یک پذیرش نیازمند تأیید مدیر و در تاریخچه ثبت می‌شود.

وضعیت نیاز از پیشنهادهایش مشتق می‌شود:

| کلید | معنی |
|---|---|
| `open` | پیشنهاد فعالی ندارد |
| `under_review` | پیشنهاد جدید یا تماس‌گرفته‌شده دارد |
| `negotiating` | مذاکره در جریان است |
| `committed` | یک پیشنهاد پذیرفته شده است |

برای هر نیاز تنها یک پیشنهاد می‌تواند هم‌زمان پذیرفته باشد.

## API

API عمومی:

- `GET /api/v1/projects/current`
- `GET /api/v1/projects/:slug`
- `PUT /api/v1/needs/:id/viewer-state`
- `POST /api/v1/needs/:id/proposals`
- `GET /api/v1/proposals/track` با هدر `Authorization: Bearer <token>`
- `GET /api/v1/projects/:slug/events`

API مدیریت زیر `/api/v1/admin` قرار دارد و به session و CSRF token نیاز دارد. پاسخ خطا شکل ثابتی دارد:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "اطلاعات ورودی معتبر نیست.",
    "fields": {
      "mobile": "شماره موبایل معتبر وارد کنید."
    }
  },
  "requestId": "..."
}
```

## پایگاه داده و backup

SQLite در حالت WAL اجرا می‌شود. migrationها با `PRAGMA user_version` اعمال و دیتابیس نسخه prototype نیز بدون حذف داده ارتقا داده می‌شود.

ساخت backup:

```bash
npm run backup
```

در Docker:

```bash
docker compose exec hamsakht npm run backup
```

برای کپی snapshotها به پوشه‌ای خارج از volume:

```bash
docker compose cp hamsakht:/app/backups ./backups
```

خروجی backup را خارج از سرور نیز نگهداری کنید. این نسخه برای اجرای تک‌نمونه‌ای طراحی شده و نباید چند کانتینر هم‌زمان را روی یک فایل SQLite اجرا کرد.

## تست و کنترل کیفیت

```bash
npm run check
npm run test:backend
npx playwright install chromium
npm run test:e2e
npm run audit:lighthouse
```

تست‌ها migration، اعتبارسنجی، احراز هویت، idempotency، تغییر وضعیت پیشنهاد و مسیر کامل ثبت تا پذیرش را پوشش می‌دهند. تست مرورگر همچنین RTL، دسترس‌پذیری، baseline تصویری و چیدمان responsive را بررسی می‌کند. ممیزی Lighthouse بودجهٔ Performance و Accessibility حداقل ۹۵ و CLS کمتر از ۰٫۱ را enforce می‌کند؛ در صورت پیدا نشدن خودکار Chrome می‌توانید مسیر آن را در `CHROME_PATH` بگذارید.

## ساختار

```text
server.js            نقطه شروع سرویس
src/                 config، database، store، routes، security و SSE
public/              رابط عمومی و پنل مدیر
scripts/             ابزار hash رمز و backup
test/                تست‌های backend و مرورگر
data/                دیتابیس محلی؛ در Git ذخیره نمی‌شود
```

## حریم خصوصی

نام، موبایل، ایمیل و متن پیشنهاد فقط برای مدیر پروژه قابل مشاهده‌اند. صفحه عمومی صرفاً وضعیت و آمار تجمیعی را نمایش می‌دهد. لینک پیگیری token تصادفی را فقط در fragment نگه می‌دارد، رابط وب آن را پس از import از address bar پاک می‌کند و درخواست وضعیت آن را در هدر می‌فرستد تا در access log پراکسی ثبت نشود. token خام نیز در دیتابیس ذخیره نمی‌شود.

فونت محلی [Vazirmatn](https://github.com/rastikerdar/vazirmatn) تحت مجوز OFL 1.1 در `public/assets/fonts` قرار دارد.
