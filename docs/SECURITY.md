# مدل امنیت و راهنمای بهره‌برداری امن

این سند کنترل‌های موجود، مرز اعتماد و محدودیت‌های شناخته‌شدهٔ نسخهٔ فعلی را
توضیح می‌دهد. وجود این کنترل‌ها جایگزین بازبینی امنیتی مستقل یا الزامات حقوقی
حوزهٔ فعالیت شما نیست.

## مرزهای اعتماد

1. **مرورگر عمومی:** فقط دادهٔ عمومی پروژه و توکن خصوصی پیگیری پیشنهاد را
   دارد؛ دادهٔ متقاضیان دیگر قابل دسترسی نیست.
2. **مرورگر عضو:** cookie نشست HttpOnly و CSRF token دارد و به permissions
   عضویت محدود است.
3. **کلاینت server-to-server:** با API key bearer و scope صریح کار می‌کند؛
   Origin/CSRF مرورگر برای آن کاربرد ندارد.
4. **reverse proxy:** TLS و IP واقعی را تحویل می‌دهد و باید تنها منبع مورد
   اعتماد در `TRUST_PROXY` باشد.
5. **برنامه Node:** محل اجرای authorization، validation، transaction و audit
   است و به رازهای runtime دسترسی دارد.
6. **SQLite و volume:** شامل دادهٔ کسب‌وکار، PII، سند و hash توکن‌هاست؛ مدیر
   سیستم میزبان یک trusted operator محسوب می‌شود.
7. **provider خارجی/اپراتور دستی:** خارج از مرز اعتماد کد است. نسخهٔ فعلی هیچ
   موفقیت خارجی را صرفاً از ورودی کاربر تأیید نمی‌کند.

## هویت و احراز هویت

- رمز با scrypt، salt تصادفی و مقایسهٔ timing-safe نگهداری می‌شود.
- رمز خام، توکن نشست، دعوت، بازنشانی، API key، backup code و توکن پیگیری در
  جداول هویت به‌صورت hash نگهداری می‌شوند. لینک bearer دعوت/بازنشانی برای
  تحویل، تا حذف outbox به‌صورت AES-GCM sealed و قابل‌بازیابی در SQLite و
  backup آن وجود دارد؛ بنابراین حفاظت از کلید و backup الزامی است.
- نشست هویت ۱۲ ساعت اعتبار دارد و cookie آن `HttpOnly`، `SameSite=Strict` و در
  production دارای `Secure` است.
- تغییر رمز، نشست‌های دیگر را باطل می‌کند.
- MFA از TOTP استفاده می‌کند؛ secret با AES-256-GCM و
  `AUTH_ENCRYPTION_KEY` sealed می‌شود.
- backup code یک‌بارمصرف است و پس از استفاده مصرف‌شده علامت می‌خورد.
- login، MFA، دعوت، reset و bootstrap rate limit مستقل دارند.
- پاسخ reset برای ایمیل موجود و ناموجود یکسان است تا user enumeration کاهش
  یابد.

MFA در مدل داده و رابط وجود دارد، اما اجبار اجباری سراسری بر اساس نقش در کد
تعریف نشده است. در production باید با رویهٔ سازمانی برای `owner`، `admin`،
`finance` و `board` اجباری شود.

## نشست، CSRF و Origin

mutation مرورگر باید هر دو کنترل زیر را بگذراند:

- `Origin` دقیقاً برابر `PUBLIC_ORIGIN`
- هدر `X-CSRF-Token` برابر توکن نشست

CSRF token از session secret و توکن نشست مشتق و hash آن نیز در دیتابیس
اعتبارسنجی می‌شود. پاسخ‌های API خصوصی `Cache-Control: no-store` دارند.

API key با قالب `Authorization: Bearer hmk_...` برای کلاینت server-to-server
است. mutation با API key به Origin یا CSRF نیاز ندارد، اما scope، سازمان،
پروژه، وضعیت سازنده و وضعیت عضویت دوباره کنترل می‌شود. API key اجازهٔ ساخت،
مشاهدهٔ مقدار خام یا ابطال API keyهای دیگر را ندارد؛ این چرخه فقط با نشست
تعاملی مجاز است.

مجوزهای کلید از allowlist automation انتخاب می‌شوند؛ `*` هنگام ساخت به همان
فهرست امن گسترش می‌یابد و در هر درخواست با نقش فعلی سازنده intersect می‌شود.
تنزل نقش، تعلیق یا حذف عضویت بلافاصله اختیار کلید را کم/قطع می‌کند. کلید به
مسیرهای شخصی `/api/v2/admin/me/*`، رأی، ساخت/ارسال/تأیید انتقال سهام و عملیات
چهارچشمی دسترسی ندارد. تاریخ انقضا هنگام ساخت به ISO canonical تبدیل می‌شود.

allowlist canonical عبارت است از:

```text
organization.read organization.manage projects.create
project.read project.manage project.archive project_work.write
proposals.read_sensitive proposals.manage
stakeholders.read_sensitive stakeholders.manage
capital.read capital.manage finance.read finance.manage goals.manage
governance.read governance.manage
compliance.read compliance.manage contracts.read contracts.manage audit.read
```

`userId` سازنده روی actor کلید فقط برای attribution است. کنترل‌های ownership
سند و comment تنها برای نشست تعاملی فعال می‌شوند؛ در نتیجه کلید
`project.read` یا `project_work.write` نمی‌تواند با تکیه بر مالکیت سازنده،
محتوای خصوصی او را بخواند، نسخه‌گذاری کند یا حذف کند.

## نقش‌ها و ماتریس خلاصهٔ دسترسی

### نقش سازمانی

| نقش | دامنهٔ اصلی |
|---|---|
| `owner` | همهٔ مجوزها، از جمله عملیات مالکیت سازمان |
| `admin` | مدیریت سازمان، اعضا، پروژه‌ها و همهٔ حوزه‌های پروژه؛ بدون اختیار ویژهٔ owner |
| `project_manager` | ساخت/مدیریت پروژه، اجرا، پیشنهاد و ذی‌نفع؛ مالی/سرمایه/حاکمیت عمدتاً خواندنی |
| `finance` | خواندن پروژه و ذی‌نفع؛ مدیریت مالی و سرمایه؛ compliance/contract خواندنی |
| `board` | خواندن مالی و سرمایه؛ مدیریت حاکمیت، compliance و contract؛ مشاهدهٔ audit |
| `auditor` | مشاهدهٔ حساس و audit بدون مجوز mutation دامنه |
| `viewer` | metadata سازمان؛ پروژه فقط با عضویت صریح |

### نقش پروژه‌ای

| نقش | دامنهٔ اصلی |
|---|---|
| `project_manager` | مدیریت پروژه، اجرا، اعضای پروژه، پیشنهاد و ذی‌نفع؛ مشاهدهٔ مالی/سرمایه/حاکمیت |
| `contributor` | مشاهدهٔ پروژه و حاکمیت و ثبت کار اجرایی |
| `finance` | مدیریت مالی و سرمایهٔ همان پروژه |
| `board` | مدیریت حاکمیت، compliance و contract همان پروژه و مشاهدهٔ audit |
| `auditor` | دسترسی خواندنی حساس و audit همان پروژه |
| `viewer` | مشاهدهٔ پروژه و اطلاعات حاکمیت مجاز |

permission نهایی اجتماع نقش سازمانی و پروژه‌ای است. کنترل منبع همواره علاوه
بر permission، تعلق `projectId` به سازمان را بررسی می‌کند و برای جلوگیری از
افشای وجود منبع خارج از scope معمولاً 404 می‌دهد.

## عملیات حساس و تفکیک وظایف

- صدور مستقیم سهم پس از bootstrap ممنوع است.
- اقدام سرمایه‌ای به مصوبهٔ نهایی‌شده، حد نصاب و outcome تصویب‌شده نیاز دارد.
- سازندهٔ اقدام نمی‌تواند آن را تصویب یا اجرا کند.
- preview و hash وضعیت cap table در تصویب ثبت و پیش از اجرا دوباره مقایسه
  می‌شود.
- انتقال سهم پس از bootstrap به KYC معتبر هر دو طرف، قرارداد فعال شامل هر دو
  طرف و مصوبهٔ تصویب‌شده با حد نصاب نیاز دارد.
- معاملهٔ سهم با قیمت مثبت فقط با payment intent ورودی موفق، هم‌ارز، هم‌مبلغ
  و مصرف‌نشده تأیید می‌شود؛ سازنده نیز نمی‌تواند تأییدکنندهٔ همان انتقال باشد.
- تمام mutationهای انتقال و اقدام سرمایه‌ای به نشست تعاملی نیاز دارند؛ API key
  حتی برای رد یا لغو انتقال pending به‌جای کاربر انسانی پذیرفته نمی‌شود.
- وکالت رأی فقط توسط کاربر فعال متصل به ذی‌نفع اعطاکننده ساخته یا لغو می‌شود
  و تمام قدرت رأی او را منتقل می‌کند. نتیجه و بسته‌شدن مصوبه با tally/حدنصاب
  canonical در یک تراکنش انجام می‌شود.
- سند حسابداری ثبت‌شده با reversal اصلاح می‌شود.
- توزیع سود در production به KYC تأییدشدهٔ داخلی نیاز دارد و body درخواست
  نمی‌تواند سیاست را خاموش کند.
- عملیات مهم مالی و ارزش‌گذاری idempotent هستند.

در اقدام شرکتی، کنترل four-eyes سازنده را از approver/executor جدا می‌کند؛
الزام اینکه approver و executor نیز حتماً دو فرد متفاوت باشند در نسخهٔ فعلی
وجود ندارد. در انتقال سهم، سازنده و تأییدکننده باید متفاوت باشند.

## audit

audit enterprise موارد زیر را نگه می‌دارد:

- سازمان، پروژه، actor، request id، action و resource
- snapshot قبل/بعد و metadata با redaction کلیدهای حساس
- `previous_hash` و `event_hash` مبتنی بر HMAC-SHA256

زنجیره از endpoint مجاز قابل verify است و تغییر معمول رکوردها را آشکار
می‌کند. محدودیت‌ها:

- WORM یا timestamp authority بیرونی نیست.
- دارندهٔ هم‌زمان دیتابیس و `AUDIT_HMAC_KEY` می‌تواند تاریخچهٔ جعلی تازه
  بسازد.
- تغییر کلید بدون طرح versioning، verify تاریخچه را می‌شکند.

کلید را جدا از دیتابیس و backup آن نگه دارید و head hash را دوره‌ای به مخزن
خارج از سرور export کنید.

## داده، حریم خصوصی و نگهداری

- API عمومی فقط وضعیت و آمار تجمیعی را منتشر می‌کند.
- موبایل، ایمیل، متن پیشنهاد، PII ذی‌نفع و اسناد خصوصی به permission حساس
  نیاز دارند.
- session، tracking و API token به‌صورت hash ذخیره می‌شوند.
- TOTP و credential/payload برخی اتصال‌ها با AES-GCM sealed می‌شوند.
- خود SQLite، PII، متن پیشنهاد و BLOB اسناد با SQLCipher رمز نشده‌اند.

بنابراین volume، snapshot و backup باید در سطح زیرساخت رمز شوند. دسترسی root
سرور، backup و لاگ را محدود و retention/deletion را با مشاور حقوقی و نیاز
کسب‌وکار تعریف کنید. این نسخه ابزار کامل data-subject request، legal hold یا
حذف رمزنگاری‌شدهٔ داده ندارد.

## upload

کنترل‌های موجود:

- allowlist MIME
- سقف اندازهٔ قابل تنظیم؛ حداکثر ۲۵ MiB
- کنترل magic bytes برای PDF، JPEG، PNG و WebP و بررسی central directory،
  local header و entryهای الزامی OOXML برای DOCX/XLSX
- parse واقعی JSON و رد byte صفر در متن
- نام فایل امن برای download و SHA-256 هر نسخه
- permission مجزا برای سند خصوصی
- quota اتمیک قابل تنظیم برای کل سازمان، هر پروژه و تعداد نسخهٔ هر سند
- rate limit ساعتی بارگذاری به تفکیک actor و پروژه

محدودیت‌ها:

- antivirus، sandbox فایل، CDR و DLP وجود ندارد.
- اعتبارسنجی OOXML ساختار بسته و entryهای اصلی را می‌سنجد، اما جایگزین parse
  کامل XML، ضدویروس یا تشخیص محتوای فعال نیست.
- object storage مستقل وجود ندارد؛ BLOBها در SQLite و در سهمیهٔ پروژه/سازمان
  نگهداری می‌شوند.

برای ورودی کاملاً غیرقابل اعتماد، فایل را پیش از دسترسی کاربر از یک malware
scanner یا gateway قرنطینه عبور دهید.

## امنیت HTTP و ظرفیت

پاسخ‌ها دارای CSP self-only، منع frame/object، `nosniff`، policyهای
cross-origin، Referrer-Policy و در production HSTS هستند. برنامه body JSON را
به ۶۴ KiB و upload را به سقف تنظیم‌شده محدود می‌کند. rate limiter فعلی در
حافظهٔ process است:

- با restart پاک می‌شود؛
- بین چند replica مشترک نیست؛
- جایگزین WAF یا rate limiter لبه برای ترافیک عمومی بزرگ نیست.

reverse proxy باید سقف body، timeout، TLS و rate limit لبه را نیز اعمال کند.

## سیاست provider دستی

- production فقط `PAYMENT_PROVIDER_MODE=manual` و
  `NOTIFICATION_PROVIDER=manual` را می‌پذیرد.
- `DISTRIBUTION_KYC_REQUIRED=false` در production رد می‌شود.
- KYC، امضا و valuation فعلی دستی‌اند و `providerVerified` از body کاربر
  پذیرفته نمی‌شود.
- payload و لینک bearer دعوت/بازنشانی از هیچ API مدیریتی outbox قابل reveal
  نیستند؛ پاسخ تغییر وضعیت outbox نیز payload برنمی‌گرداند.
- دعوت‌کننده لینک دعوت را فقط یک‌بار در پاسخ ساخت دعوت می‌گیرد. در حالت
  notification دستی، تحویل reset فقط از ابزار محلی اپراتور روی سرور و بیرون
  از API tenant انجام می‌شود.
- `npm run notification:manual -- list` فقط metadata غیرحساس و
  `deliver <OUTBOX_ID>` پس از تأیید فقط یک رکورد دقیق را آشکار و اتمیک `sent`
  می‌کند. stdout فرمان deliver secret است؛ `sent` اثبات تحویل خارجی نیست و
  همان رکورد دوباره reveal نمی‌شود.
- mark/retry/cancel دستی قابل ممیزی است و CAS مانع بازنویسی لغو با پاسخ دیررس
  provider می‌شود.
- حالت sandbox فقط در development/test مجاز و نتیجهٔ آن شبیه‌سازی‌شده است.
- ثبت `live` برای یک integration به‌تنهایی adapter فعال ایجاد نمی‌کند؛ runtime
  production فعلی نیز provider غیر `manual` را رد می‌کند و فعال‌سازی زنده
  نیازمند adapter و release کد/پیکربندی است.

هیچ‌کدام از این وضعیت‌ها مدرک پرداخت بانکی، KYC رسمی، امضای معتبر یا تحویل
ایمیل نیست. reconciliation باید با سند خارجی و اپراتور مسئول انجام شود.

## چک‌لیست رخداد امنیتی

1. رخداد را زمان‌دار ثبت و دامنهٔ سازمان/پروژه/کاربر را مشخص کنید.
2. در صورت compromise فعال، دسترسی عمومی را در proxy محدود کنید.
3. sessionهای مشکوک، API keyها و دعوت‌های باز را revoke کنید.
4. قبل از تغییر، snapshot و backup فقط‌خواندنی برای بررسی نگه دارید.
5. head hash و نتیجهٔ audit verify را خارج از سرور ثبت کنید.
6. لاگ proxy، لاگ JSON برنامه، audit و رویدادهای provider دستی را جمع‌آوری
   کنید.
7. راز در معرض خطر را مطابق [راهنمای چرخش راز](DEPLOYMENT.md#تغییر-و-چرخش-رازها)
   عوض کنید؛ برای کلید encryption و audit ابتدا برنامهٔ migration داشته باشید.
8. integrity دیتابیس و backup شناخته‌شدهٔ سالم را بررسی کنید.
9. اشخاص و نهادهای لازم را طبق قانون و قرارداد مطلع کنید.
10. علت ریشه‌ای، اصلاح، آزمون regression و زمان بازگشت سرویس را مستند کنید.

## محدودیت حقوقی و مالی

- cap table داخلی، گواهی و انتقال ثبت‌شده جای ثبت قانونی سهم را نمی‌گیرد.
- امضای دستی سامانه، امضای دیجیتال مورد تأیید مرجع نیست.
- KYC دستی احراز هویت provider رسمی نیست.
- payment دستی تسویهٔ بانکی را تضمین نمی‌کند.
- ROI و XIRR خروجی مدیریتی و تخمینی‌اند، نه توصیه یا تضمین سرمایه‌گذاری.
- قوانین اوراق بهادار، مالیات، حریم خصوصی و نگهداری سند باید برای حوزهٔ
  قضایی مقصد جداگانه بررسی شوند.

وضعیت عملی تحویل در [STATUS_REPORT.md](STATUS_REPORT.md)، تنظیمات استقرار در
[DEPLOYMENT.md](DEPLOYMENT.md) و قرارداد HTTP در [API.md](API.md) آمده است.
