# راهنمای استقرار، پشتیبان‌گیری و بازیابی

این راهنما برای استقرار تک‌سرور روی VPS نوشته شده است. معماری فعلی SQLite را
روی دیسک محلی پایدار و **یک replica برنامه** فرض می‌کند.

## پیش‌نیازها

- VPS لینوکسی با Docker Engine و Docker Compose جدید، یا Node.js 24
- دامنه، DNS و TLS معتبر
- reverse proxy مانند Nginx، Caddy یا Traefik
- volume محلی پایدار با فضای کافی برای دیتابیس، WAL، اسناد و backup
- محل مستقل و رمز‌شده برای کپی خارج از سرور backupها
- ساعت سیستم همگام با NTP

SQLite را روی NFS، SMB یا volume اشتراکی چند میزبان قرار ندهید و چند replica
برنامه را به یک فایل دیتابیس متصل نکنید.

## متغیرهای محیطی

فایل `.env.example` را به `.env` کپی کنید و `.env` را هرگز commit نکنید.

| متغیر | الزام و توضیح |
|---|---|
| `NODE_ENV` | در سرور `production` |
| `HOST` | معمولاً `0.0.0.0` داخل container |
| `PORT` | پیش‌فرض `3000` |
| `PUBLIC_ORIGIN` | origin نهایی HTTPS، بدون path؛ مانند `https://app.example.com` |
| `DATA_DIR` | در Compose برابر `/app/data` |
| `DATABASE_PATH` | اختیاری؛ پیش‌فرض `${DATA_DIR}/hamkari.db`؛ مقدار `:memory:` در production رد می‌شود |
| `BACKUP_DIR` | در Compose برابر `/app/backups` |
| `TRUST_PROXY` | `false` یا فقط CIDR/IP پراکسی؛ مقدار کلی `true` در production رد می‌شود |
| `SESSION_SECRET` | راز تصادفی مستقل، حداقل ۳۲ نویسه |
| `AUTH_ENCRYPTION_KEY` | راز مستقل برای MFA و payload/credential رمز‌شده |
| `AUDIT_HMAC_KEY` | راز مستقل برای زنجیرهٔ audit |
| `ADMIN_PASSWORD_HASH` | hash اجباری bootstrap در production؛ حتی پس از ساخت مالک باید تنظیم بماند |
| `UPLOAD_LIMIT_BYTES` | پیش‌فرض ۵ MiB، حد مجاز کد ۱ KiB تا ۲۵ MiB |
| `DOCUMENT_PROJECT_QUOTA_BYTES` | سهمیهٔ پیش‌فرض اسناد هر پروژه: ۲۵۶ MiB |
| `DOCUMENT_ORGANIZATION_QUOTA_BYTES` | سهمیهٔ پیش‌فرض اسناد هر سازمان: ۱ GiB و نه کمتر از سهمیهٔ پروژه |
| `DOCUMENT_MAX_VERSIONS` | سقف پیش‌فرض نسخه‌های هر سند: ۱۰۰ |
| `DOCUMENT_UPLOADS_PER_HOUR` | سقف پیش‌فرض بارگذاری هر کاربر در ساعت: ۳۰ |
| `NOTIFICATION_PROVIDER` | در production فقط `manual`؛ مقدار `sandbox` فقط در development/test |
| `PAYMENT_PROVIDER_MODE` | در production فقط `manual` |
| `DISTRIBUTION_KYC_REQUIRED` | در production باید `true` باشد |
| `SQLITE_BUSY_TIMEOUT_MS` | پیش‌فرض ۵۰۰۰، بازهٔ ۱۰۰ تا ۶۰۰۰۰ |

برای ساخت hash رمز bootstrap:

```bash
npm run hash-password
```

در فایل `.env` مقدار `ADMIN_PASSWORD_HASH` را داخل single quote نگه دارید؛
در غیر این صورت Docker Compose بخش‌های دارای `$` را به‌عنوان variable
interpolation تفسیر می‌کند.

برای سه راز اصلی از password manager یا secret manager استفاده کنید. نمونهٔ
تولید محلی:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

این دستور را سه بار اجرا کنید و خروجی‌ها را بین متغیرها reuse نکنید.

## استقرار با Docker Compose

```bash
umask 077
cp .env.example .env
chmod 600 .env
test "$(stat -c '%a' .env)" = "600"
test "$(stat -c '%u' .env)" = "$(id -u)"
# .env را با مقادیر واقعی و رازهای مستقل ویرایش کنید
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 hamsakht
```

دو بررسی `stat` باید موفق باشند. فایل باید متعلق به همان کاربر استقرار و فقط
برای مالک خواندنی/نوشتنی باشد؛ پس از هر ابزار ویرایش یا جایگزینی فایل، این
بررسی را دوباره اجرا کنید.

بررسی سلامت:

```bash
curl --fail http://127.0.0.1:3000/healthz
```

پاسخ باید وضعیت سلامت، نسخهٔ schema و اطلاعات runtime را برگرداند. سپس
bootstrap مالک را از رابط وب و فقط از origin نهایی HTTPS انجام دهید و MFA را
برای مالک فعال کنید.

> در محیط توسعهٔ گزارش ۲۰۲۶-۰۷-۲۴، Docker daemon فعال نبوده است؛ بنابراین
> build/restart واقعی container باید در staging یا سرور مقصد اجرا و ثبت شود.

## reverse proxy و TLS

پورت برنامه را در firewall عمومی نکنید؛ فقط reverse proxy باید به آن دسترسی
داشته باشد. نمونهٔ خلاصهٔ Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name app.example.com;

    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 75s;
    }

    location ~ ^/api/v1/projects/.+/events$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

مقدار `TRUST_PROXY` را دقیقاً به IP یا CIDR شبکه‌ای محدود کنید که reverse
proxy از آن به Node وصل می‌شود. تنظیم اشتباه آن می‌تواند rate limit و ثبت IP
را قابل جعل کند. TLS، renewal و redirect کامل HTTP به HTTPS بر عهدهٔ proxy
است.

## تحویل دستی دعوت و بازنشانی رمز

provider تولیدی فعلی `manual` است. API سازمانی فقط metadata outbox را نشان
می‌دهد و هرگز payload یا لینک bearer را reveal نمی‌کند. اپراتور دارای دسترسی
shell به همان سرور/volume می‌تواند صف احراز هویت را بدون مشاهدهٔ مقصد یا
payload فهرست کند:

```bash
docker compose exec hamsakht \
  npm run notification:manual -- list
```

برای تحویل یک رکورد دقیق:

```bash
docker compose exec hamsakht \
  npm run notification:manual -- deliver <OUTBOX_ID>
```

فرمان دوم تأیید تعاملی می‌خواهد. در automation کنترل‌شده می‌توان `--confirm`
افزود، اما stdout آن secret محسوب می‌شود و نباید توسط CI یا سامانهٔ log جمع
شود. ابزار فقط رکورد `pending/failed` از template دعوت یا reset را می‌پذیرد،
در تراکنش IMMEDIATE آن را `sent` می‌کند و محتوای همان رکورد را فقط یک‌بار
برمی‌گرداند. `sent` در اینجا یعنی تحویل به اپراتور، نه اثبات دریافت ایمیل
خارجی؛ ارسال از کانال امن و ثبت reconciliation بر عهدهٔ اپراتور است. در صورت
از‌دست‌رفتن خروجی، درخواست تازه ایجاد کنید و وضعیت دیتابیس را دستی برنگردانید.

## پشتیبان‌گیری

اسکریپت backup از `VACUUM INTO` استفاده می‌کند، فایل موجود را overwrite
نمی‌کند و روی خروجی `PRAGMA integrity_check` اجرا می‌کند:

```bash
docker compose exec hamsakht npm run backup
```

مسیر، اندازهٔ بایت و SHA-256 خروجی در JSON چاپ می‌شود؛ این سه مقدار را خارج از
سرور ثبت و پیش از restore با فایل مقصد تطبیق دهید. برای مقصد نام‌دار:

```bash
docker compose exec hamsakht \
  npm run backup -- /app/backups/hamkari-before-release.db
```

حداقل سیاست پیشنهادی:

- backup روزانه و پیش از هر release یا migration
- نگهداری چند نسل با retention مصوب
- کپی خودکار خارج از VPS و رمزنگاری at-rest
- checksum و ثبت زمان/اندازه
- آزمون restore دوره‌ای، نه صرفاً مشاهدهٔ وجود فایل

WAL و فایل live را با `cp` خام در زمان اجرای برنامه backup نکنید.

دیتابیس به‌تنهایی backup کامل عملیاتی نیست. نسخهٔ متناظر
`AUTH_ENCRYPTION_KEY` و `AUDIT_HMAC_KEY` را جدا از دیتابیس و در vault/escrow
امن نگه دارید؛ اولی برای بازکردن TOTP، outbox و تنظیمات sealed و دومی برای
اعتبارسنجی زنجیرهٔ audit لازم است. رازها را داخل همان فایل backup یا کنار آن
روی دیسک عمومی قرار ندهید.

## restore drill

Restore دیتابیس live را جایگزین می‌کند و فقط بعد از توقف سرویس مجاز است.
اسکریپت، منبع و staging را integrity-check می‌کند، تطابق دقیق با schema جاری
و جدول‌های شناخته‌شدهٔ هم‌ساخت را پیش از swap می‌سنجد و از دیتابیس قبلی فایل
rollback می‌سازد. اگر اعتبارسنجی بعد از swap شکست بخورد، rollback قبلی به‌صورت
خودکار به مسیر live برگردانده می‌شود.

```bash
docker compose stop hamsakht
docker compose run --rm \
  -e RESTORE_CONFIRM=I_UNDERSTAND_REPLACE_DATABASE \
  hamsakht npm run restore -- /app/backups/hamkari-before-release.db
docker compose start hamsakht
docker compose logs --tail=100 hamsakht
curl --fail https://app.example.com/healthz
```

پس از restore:

1. نسخهٔ schema و health را بررسی کنید.
2. کلیدهای متناظر بازیابی را بارگذاری و بازشدن یک دادهٔ sealed غیرحساس آزمایشی
   را کنترل کنید.
3. ورود مالک، فهرست سازمان/پروژه و یک گزارش مالی را smoke test کنید.
4. `audit-events/verify` را با نقش auditor/owner بررسی کنید.
5. مقدار sentinel و شمارش‌های کلیدی ثبت‌شده در restore drill را با نتیجه تطبیق دهید.
6. نام فایل rollback چاپ‌شده توسط اسکریپت را تا پایان تأیید نگه دارید.

RPO و RTO را کسب‌وکار تعیین می‌کند. بدون restore drill، وجود backup به معنی
قابلیت بازیابی اثبات‌شده نیست.

## پایش

حداقل هشدارهای production:

- شکست `/healthz` یا restart پی‌درپی container
- خطاهای HTTP 5xx و افزایش 401/403/429
- پیام‌های `SQLITE_BUSY`، integrity یا migration
- مصرف CPU/RAM، فضای volume، رشد دیتابیس/WAL و اندازهٔ backup
- رکوردهای outbox در `failed` یا `processing` طولانی
- payment/distributionهای متوقف در وضعیت میانی
- شکست verify زنجیرهٔ audit
- انقضای TLS و شکست job پشتیبان‌گیری

لاگ برنامه JSON است؛ آن را به journal یا سامانهٔ log مرکزی بفرستید و دسترسی
به لاگ را مانند دادهٔ حساس محدود کنید.

## تغییر و چرخش رازها

| راز | اثر چرخش |
|---|---|
| `SESSION_SECRET` | نشست‌های جاری عملاً نامعتبر می‌شوند و cookie ناشناس/CSRF مشتق‌شده تغییر می‌کند؛ پنجرهٔ نگهداری اعلام کنید |
| `AUTH_ENCRYPTION_KEY` | TOTP و credential/payload sealed قبلی بدون migration قابل بازکردن نیستند؛ هرگز کورکورانه عوض نکنید |
| `AUDIT_HMAC_KEY` | verify کل تاریخچه با کلید تازه شکست می‌خورد؛ کلید قبلی را در vault نگه دارید و طرح versioned re-sign/new-chain داشته باشید |
| `ADMIN_PASSWORD_HASH` | فقط ورود legacy/bootstrap را تغییر می‌دهد؛ بعد از owner، مسیر legacy غیرفعال است |
| API key | از پنل revoke و کلید تازه با scope حداقلی صادر کنید؛ مقدار خام قبلی قابل بازیابی نیست |

پیش از چرخش، backup و runbook بازگشت داشته باشید. رازها را در لاگ، ticket،
shell history یا سند پروژه قرار ندهید.

## انتشار و rollback

روال انتشار:

1. tag یا digest تغییرناپذیر image را ثبت کنید.
2. backup سالم و خارج از سرور بگیرید.
3. release notes و schema مبدا/مقصد را ثبت کنید.
4. در staging migration و smoke test را اجرا کنید.
5. در بازهٔ نگهداری image جدید را بالا بیاورید.
6. health، ورود، عملیات کلیدی و audit را بررسی کنید.

Migrationها forward-only هستند. نسخهٔ قدیمی برنامه ممکن است دیتابیس با schema
جدید را نپذیرد. اسکریپت restore نیز عمداً فقط backup با نسخهٔ دقیق
`SCHEMA_VERSION` همان image را می‌پذیرد. بنابراین backup نسخهٔ قبلی را با
اسکریپت image جدید restore نکنید.

rollback امن در آن حالت:

1. digest تغییرناپذیر image قبلی و backup ساخته‌شده با همان schema را انتخاب
   و تطابقشان را از release record تأیید کنید؛
2. **پیش از اجرای restore** متغیر Compose را روی همان image قرار دهید و خروجی
   انتخاب image را بررسی کنید؛
3. سرویس را متوقف و restore را با اسکریپت داخل همان image قبلی اجرا کنید؛
4. همان image را بدون build مجدد بالا بیاورید و health، schema و داده را تأیید
   کنید.

نمونه:

```bash
export HAMSAKHT_IMAGE='registry.example.com/hamsakht@sha256:<previous-digest>'
docker compose config --images
docker compose pull hamsakht
docker compose stop hamsakht
docker compose run --rm --no-deps \
  -e RESTORE_CONFIRM=I_UNDERSTAND_REPLACE_DATABASE \
  hamsakht npm run restore -- /app/backups/hamkari-before-release.db
docker compose up -d --no-build --force-recreate hamsakht
docker compose ps
curl --fail https://app.example.com/healthz
```

خروجی `docker compose config --images` پیش از restore و image کانتینر پس از
راه‌اندازی باید همان digest قبلی باشند. اگر schema backup با
`SCHEMA_VERSION` آن image برابر نیست، عملیات را متوقف کنید و جفت صحیح
image/backup را بیابید؛ version check را دور نزنید.

این rollback تغییرات ثبت‌شده بعد از backup را از دست می‌دهد؛ تصمیم آن باید با
مسئول کسب‌وکار و بر اساس RPO گرفته شود. روی دیتابیس migrateشده، صرفاً image
قدیمی را start نکنید.

## محدودیت توپولوژی

- یک process/replica نویسنده
- یک فایل SQLite روی storage محلی پایدار
- بدون load balancer چند replica، shared SQLite یا active-active
- rate limiter در حافظهٔ همان process است و با restart پاک می‌شود
- SSE و session به process واحد متکی‌اند

برای مقیاس افقی باید پایگاه دادهٔ client/server، rate limiter و event broker
توزیع‌شده، object storage اسناد و آزمون migration جداگانه طراحی شوند.

برای کنترل‌های امنیتی و محدودیت‌های provider به [SECURITY.md](SECURITY.md) و
برای وضعیت واقعی تحویل به [STATUS_REPORT.md](STATUS_REPORT.md) مراجعه کنید.
