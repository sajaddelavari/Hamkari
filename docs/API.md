# نقشهٔ سطح بالای API هم‌ساخت

این سند برای جهت‌یابی توسعه‌دهنده و یکپارچه‌ساز است و **OpenAPI کامل** محسوب
نمی‌شود. برای schema دقیق body/response و transitionها، کد route/store و
تست‌های backend مرجع نهایی‌اند.

## قرارداد عمومی

- JSON: `Content-Type: application/json`
- mutation مرورگر: `Origin` صحیح و `X-CSRF-Token`
- upload سند: body باینری و headerهای توضیح‌داده‌شده در بخش اسناد
- پاسخ موفق با status متناسب `200/201/202`
- شناسهٔ درخواست در هدر `X-Request-Id` و پاسخ خطا

شکل ثابت خطا:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "اطلاعات واردشده معتبر نیست.",
    "fields": {
      "mobile": "شماره موبایل معتبر نیست."
    }
  },
  "requestId": "..."
}
```

`fields` اختیاری است. statusهای متداول:

| status | کاربرد |
|---:|---|
| 400 | ورودی یا transition نامعتبر |
| 401 | نشست/کلید/توکن احراز هویت نامعتبر |
| 403 | مجوز ناکافی، CSRF یا Origin نامعتبر |
| 404 | منبع موجود نیست یا خارج از scope است |
| 409 | تعارض وضعیت، idempotency یا invariant |
| 413 | payload یا فایل بیش از سقف |
| 415 | content type/encoding/signature نامعتبر |
| 429 | rate limit |
| 503 | ظرفیت SSE یا قابلیت runtime موقتاً در دسترس نیست |

## احراز هویت

### نشست مرورگر

ورود:

```http
POST /api/v2/auth/session
Origin: https://app.example.com
Content-Type: application/json

{"email":"...","password":"...","totpCode":"..."}
```

سرور cookie امن و `csrfToken` را در payload برمی‌گرداند. در mutationهای بعدی:

```http
X-CSRF-Token: <csrfToken>
Origin: https://app.example.com
```

### API key

```http
Authorization: Bearer hmk_<raw-token>
```

API key برای server-to-server است، به سازمان و permissions محدود می‌شود و
CSRF ندارد. permissions از allowlist امن انتخاب و در هر درخواست با نقش فعلی
سازنده intersect می‌شود؛ wildcard خام ذخیره نمی‌شود و انقضا ISO canonical
است. ساخت/فهرست/ابطال API key فقط با نشست تعاملی مجاز است. کلید به مسیرهای
شخصی `/admin/me/*`، رأی و عملیات حساس انتقال/اقدام سرمایه‌ای دسترسی ندارد.

allowlist صدور دقیقاً شامل این کلیدهاست:

```text
organization.read organization.manage projects.create
project.read project.manage project.archive project_work.write
proposals.read_sensitive proposals.manage
stakeholders.read_sensitive stakeholders.manage
capital.read capital.manage finance.read finance.manage goals.manage
governance.read governance.manage
compliance.read compliance.manage contracts.read contracts.manage audit.read
```

مقدار `*` فقط به همین فهرست گسترش می‌یابد. نام‌های مستعار route مانند
`documents.manage` permission قابل صدور نیستند.
شناسهٔ سازندهٔ کلید فقط برای attribution نگه داشته می‌شود؛ کلید shortcut
«سازنده/نویسندهٔ منبع خصوصی» را از کاربر انسانی به ارث نمی‌برد و سند یا نظر
خصوصی فقط با permission صریح همان دسته/مدیریت پروژه قابل دسترسی است.

### توکن پیگیری پیشنهاد

```http
Authorization: Bearer <tracking-token>
GET /api/v1/proposals/track
```

توکن را در query string قرار ندهید تا در history و log افشا نشود.

## Idempotency

برای mutationهایی که ایجاد تکراری آن‌ها خطرناک است، هدر زیر الزامی است:

```http
Idempotency-Key: <random-value-between-32-and-128-characters>
```

نمونه‌ها:

- ثبت پیشنهاد عمومی
- صدور/انتقال/عرضه در مسیر سازگاری سرمایه
- ایجاد سند مالی، reversal، valuation، invoice و payment intent

ارسال دوبارهٔ همان payload و key، پاسخ قبلی را با
`idempotentReplay: true` برمی‌گرداند. استفاده از همان key با payload متفاوت
خطای `409 IDEMPOTENCY_CONFLICT` می‌دهد. key را برای عملیات مستقل reuse نکنید.

## API عمومی v1

| متد و مسیر | کاربرد |
|---|---|
| `GET /api/v1/projects` | فهرست پروژه‌های منتشرشده |
| `GET /api/v1/projects/current` | پروژهٔ عمومی جاری برای سازگاری |
| `GET /api/v1/projects/:slug` | اتاق عمومی پروژه، نیازها و آمار |
| `GET /api/v1/needs/:id` | جزئیات عمومی نیاز |
| `PUT /api/v1/needs/:id/viewer-state` | follow/interest ناشناس امضاشده |
| `POST /api/v1/needs/:id/proposals` | ثبت idempotent پیشنهاد خصوصی |
| `GET /api/v1/proposals/track` | پیگیری خصوصی با bearer tracking token |
| `GET /api/v1/projects/:slug/events` | جریان SSE رویدادهای پروژه |
| `GET /api/v1/healthz` | health سازگار |

API عمومی شماره تماس، ایمیل، متن پیشنهاد یا دادهٔ خصوصی ذی‌نفعان را
برنمی‌گرداند. cookie ناشناس بازدیدکننده امضاشده است و `actorId` از body
پذیرفته نمی‌شود.

مسیرهای `/api/v1/admin/*` فقط برای مهاجرت/سازگاری نسل قبلی باقی مانده‌اند.
پس از bootstrap مالک، نشست مدیریت legacy غیرفعال می‌شود؛ توسعهٔ جدید باید از
`v2` استفاده کند.

## هویت و سازمان در v2

### bootstrap و session

| مسیر | کاربرد |
|---|---|
| `GET/POST /api/v2/auth/bootstrap` | وضعیت و ساخت نخستین مالک با نشست legacy |
| `GET/POST/DELETE /api/v2/auth/session` | وضعیت، ورود و خروج |
| `POST /api/v2/auth/invitations/inspect` | بررسی دعوت |
| `POST /api/v2/auth/invitations/accept` | پذیرش دعوت |
| `POST /api/v2/auth/password-reset/request` | درخواست reset بدون user enumeration |
| `POST /api/v2/auth/password-reset/complete` | تکمیل reset |

### حساب شخصی

پیشوند: `/api/v2/admin/me`

همهٔ مسیرهای این بخش فقط نشست تعاملی cookie/CSRF را می‌پذیرند؛ API key حتی
اگر متعلق به همان کاربر باشد رد می‌شود تا دادهٔ شخصی یا سازمان دیگر او افشا
نشود.

- `GET/PATCH /` برای پروفایل
- `POST /password`
- `POST /mfa/totp/setup`
- `POST /mfa/totp/confirm`
- `POST /mfa/backup-codes/regenerate`
- `POST /mfa/disable`
- `GET/PATCH /notifications`
- `PUT /notification-preferences`
- `GET /saved-listings`
- `PUT /saved-listings/:listingId`

### سازمان

پیشوند: `/api/v2/admin/organizations`

- فهرست/ساخت سازمان و `GET/PATCH/DELETE /:organizationId`
- اعضا: `/:organizationId/members`
- دعوت‌ها: `/:organizationId/invitations`
- اعضای پروژه:
  `/:organizationId/projects/:projectId/members/:userId`
- overview و public profile
- integration connection
- notification outbox دستی
- API key
- audit events و `audit-events/verify`

تمام mutationها به permission مناسب سازمان نیاز دارند؛ نشست مرورگر علاوه بر
آن CSRF/Origin و API key، scope متناظر را باید ارائه کند.

فهرست و تغییر وضعیت outbox فقط metadata تحویل را برمی‌گرداند و هیچ‌گاه payload
sealed یا لینک bearer دعوت/بازنشانی را reveal نمی‌کند.
تحویل دستی این پیام‌ها API ندارد و فقط با ابزار محلی اپراتور
`npm run notification:manual -- deliver <OUTBOX_ID>` روی سرور انجام می‌شود.

## فضای کاری و پروژه‌ها در v2

| مسیر | کاربرد |
|---|---|
| `GET /api/v2/admin/workspace` | bootstrap دادهٔ UI، سازمان/پروژه انتخابی، permission و dashboard |
| `GET/POST /api/v2/admin/projects` | فهرست قابل دسترسی و ساخت پروژه |
| `GET/PATCH/DELETE /api/v2/admin/projects/:projectId` | مشاهده، ویرایش و آرشیو پروژه |

منابع نسل قبلی پروژه از همین prefix در v2 با authorization جدید در دسترس‌اند:

- `needs` و `proposals`
- `stakeholders`
- `share-classes`، `share-offers`، `share-transfers` و `cap-table`
- `goals`
- `meetings` و resolution/vote
- dashboard و audit سازگاری

صدور مستقیم `share-classes/:id/issuances` پس از bootstrap رد می‌شود و باید از
`corporate-actions` استفاده شود.
منبع legacy به نام `financial-entries` نیز پس از bootstrap فقط `GET` است؛
mutation آن با `DOUBLE_ENTRY_FINANCE_REQUIRED` رد می‌شود و مالی جدید باید از
`journal-entries` استفاده کند.

ذی‌نفع حقیقی فیلد اختیاری `userId` دارد؛ کاربر باید عضو فعال همان سازمان و در
پروژه یکتا باشد. resolution نیز `operationScope` اختیاری دارد. برای عملیات
حساس، scope ساختاریافتهٔ `share_transfer` یا `corporate_action` به hash
canonical تبدیل و پس از بازشدن رأی‌گیری تغییرناپذیر می‌شود. رأی فقط با نشست
کاربر لینک‌شده به stakeholder یا دارندهٔ proxy معتبر ثبت می‌شود.

انتقال enterprise ابتدا `draft` است و همهٔ mutationهای چرخهٔ آن فقط نشست
تعاملی را می‌پذیرند؛ maker شواهد را با PATCH شامل
`resolutionId`، `contractId`، `paymentIntentId` و وضعیت `pending` ثبت می‌کند و
کاربر دوم آن را `approved/rejected` می‌کند. payment معاملهٔ مبلغ‌دار باید
`purposeType=share_transfer` و `purposeId=<transferId>`، مبلغ/ارز دقیق و وضعیت
موفق داشته باشد؛ payment متصل به invoice پذیرفته نمی‌شود. در تأیید، سرور
مصوبهٔ scoped و یک‌بارمصرف، KYC طرفین، قرارداد، payment، موجودی و four-eyes را
در همان transaction دوباره کنترل می‌کند.

## عملیات پروژه

پیشوند همهٔ مسیرها:

```text
/api/v2/admin/projects/:projectId
```

| منبع | عملیات سطح بالا |
|---|---|
| `operations` یا `operations-dashboard` | داشبورد پیشرفت، ریسک، منابع، KPI و بودجه |
| `phases` | CRUD آرشیوی فاز |
| `tasks` | CRUD آرشیوی، dependency و time entry |
| `time-entries` | ثبت/ویرایش/حذف زمان |
| `resources` | CRUD آرشیوی منبع |
| `allocations` | تخصیص منبع به فاز/فعالیت |
| `risks` و `issues` | مدیریت ریسک و مسئله |
| `kpis` | KPI و measurement |
| `progress-updates` | گزارش پیشرفت |
| `budgets` | نسخه، سرفصل، تصویب و بازنگری بودجه |

خواندن معمولاً `project.read` و mutation اجرایی
`project_work.write` می‌خواهد. بودجه به `finance.manage` نیاز دارد.

## مالی، حقوقی و سرمایه

همان پیشوند پروژه در v2 استفاده می‌شود.

### حسابداری و بازده

- `accounts`
- `fiscal-periods` و actionهای `open/closing/close/reopen`
- `journal-entries`، `lines`، `post` و `reverse`
- `valuations`
- `reports/trial-balance`
- `reports/profit-loss`
- `reports/balance-sheet`
- `reports/returns`

### صورتحساب، پرداخت و توزیع

- `invoices` و `invoices/:id/void`
- `payment-intents` و `payment-intents/:id/confirm`
- `distributions/preview`
- `distributions/:id/approve`
- `distributions/:id/pay`

provider مجاز از تنظیم سرور می‌آید. body نمی‌تواند `providerVerified` یا
غیرفعال‌کردن KYC production را جعل کند.

### compliance و قرارداد

- `kyc-cases`
- `kyc-cases/:id/checks`
- `kyc-cases/:id/review`
- `contracts`
- `contracts/:id/parties`
- `contracts/:id/request-signatures`
- `contracts/:id/signatures/:signatureId/manual`

همهٔ این مسیرها گردش داخلی دستی‌اند مگر adapter واقعی جداگانه نصب و
اعتبارسنجی شود. runtime فعلی در production فقط حالت `manual` را می‌پذیرد؛
فعال‌سازی provider زنده علاوه بر adapter به release کد/پیکربندی جدید نیاز دارد.

### سرمایه و حاکمیت

- `corporate-actions` و `preview/approve/execute`
- `preemptive-rights` و `exercise/waive`
- `share-certificates` و `cancel/replace`
- `governance-proxies` و `revoke`
- `meetings/:meetingId/quorum`
- `meetings/:meetingId/resolutions/:resolutionId/outcome`
- `.../finalize-outcome`
- `decision-actions`
- `decision-actions/:id/transitions`
- `decision-actions/:id/history`

پس از bootstrap، اقدام سرمایه‌ای به مصوبهٔ معتبر و تفکیک سازنده از
تصویب/اجرا نیاز دارد.

ساخت و لغو `governance-proxies` فقط با نشست تعاملی کاربری مجاز است که به
ذی‌نفع اعطاکننده متصل باشد؛ API key و مدیر غیرمتصل نمی‌توانند به‌جای او وکالت
بسازند. چون مدل فعلی رأی شکسته ندارد، proxy باید تمام قدرت رأی اعطاکننده را
منتقل کند. `finalize-outcome` نتیجه، حدنصاب و وضعیت `closed` را اتمیک ثبت
می‌کند و پس از آن رأی تازه پذیرفته نمی‌شود.

## اسناد، نظر و گزارش

### سند

```text
GET/POST  /api/v2/admin/projects/:projectId/documents
PATCH     /api/v2/admin/projects/:projectId/documents/:documentId
POST      /api/v2/admin/projects/:projectId/documents/:documentId/versions
GET       /api/v2/admin/projects/:projectId/documents/:documentId/versions/:versionId
POST      /api/v2/admin/projects/:projectId/documents/:documentId/links
```

upload نسخه:

```http
POST .../documents/:documentId/versions
Content-Type: application/pdf
X-File-Name: %D8%B3%D9%86%D8%AF.pdf
X-Change-Note: %D9%86%D8%B3%D8%AE%D9%87%20%D8%A7%D9%88%D9%84

<raw binary body>
```

برای نام و توضیح فارسی از UTF-8 percent-encoding استفاده کنید. MIMEهای مجاز
در کد محدودند؛ PDF/تصویر با signature و فایل‌های OOXML با ساختار ZIP، central
directory، local header و entryهای الزامی Word/Excel بررسی می‌شوند. سقف حجم،
تعداد نسخه، سهمیهٔ پروژه/سازمان و rate limit آپلود نیز در سرور اعمال می‌شود.

### همکاری و خروجی

- `GET/POST /api/v2/admin/projects/:projectId/comments`
- `DELETE /api/v2/admin/projects/:projectId/comments/:commentId`
- `POST /api/v2/admin/projects/:projectId/reports/:reportType` با خروجی
  JSON/CSV/HTML
- `GET/POST/PATCH /api/v2/admin/projects/:projectId/marketplace-listings`

## marketplace عمومی v2

| مسیر | کاربرد |
|---|---|
| `GET /api/v2/marketplace/listings` | جست‌وجو و cursor pagination |
| `GET /api/v2/marketplace/listings/:id` | جزئیات listing منتشرشده |
| `GET /api/v2/marketplace/facets` | facetهای نوع و ارز |

این API discovery است و endpoint سفارش، escrow یا settlement ندارد.

## pagination، فیلتر و تاریخ

- تاریخ تقویمی با `YYYY-MM-DD` و timestamp با ISO 8601 ارسال می‌شود.
- مبلغ و تعداد سهم عدد صحیح در واحد پایهٔ ارز/سهم هستند.
- endpointهای فهرست بر حسب نیاز `limit`، `cursor` یا `offset` و فیلترهای status،
  date و query دارند؛ سقف‌ها در هر store اعتبارسنجی می‌شوند.
- روی ترتیب پیش‌فرض بدون ثبت آن در integration تکیه نکنید.

## سازگاری و تغییر نسخه

- `v1` برای اتاق عمومی و سازگاری داده باقی می‌ماند.
- `v2` مسیر اصلی هویت، سازمان، عملیات، مالی، سرمایه و همکاری است.
- افزودن فیلد response به‌صورت backward-compatible ممکن است.
- integration نباید error message فارسی را parse کند؛ از `error.code` استفاده
  کند.
- schema کامل OpenAPI هنوز تولید نشده است؛ پیش از SDK عمومی باید قرارداد
  machine-readable و versioning policy مستقل اضافه شود.

مدل داده در [PLATFORM_MODEL.md](PLATFORM_MODEL.md)، کنترل‌های امنیتی در
[SECURITY.md](SECURITY.md) و تنظیم runtime در [DEPLOYMENT.md](DEPLOYMENT.md)
آمده است.
