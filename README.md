# SYRIA TRADING Platform

هذا الإصدار تطبيق أعضاء يعمل عبر خادم Node.js وقاعدة بيانات PostgreSQL:

- تسجيل حسابات وحفظها في قاعدة بيانات PostgreSQL (بدل ملف محلي كان يُمسح مع كل إعادة تشغيل على Render).
- جلسات دخول بكوكي `HttpOnly`.
- اشتراك مدفوع مربوط مع Stripe Checkout.
- وضع تطوير يفعّل الاشتراك محليا للتجربة (`DEV_AUTO_ACTIVATE`، افتراضيا false الآن).
- تحليل العملات الرقمية من الخادم عبر Binance.
- لوحة إدارة على `/admin.html`.

## متغيرات البيئة المطلوبة (Render → Environment)

```env
DATABASE_URL=postgres://user:password@host:5432/dbname
APP_URL=https://your-app.onrender.com
SESSION_SECRET=سلسلة عشوائية طويلة
ADMIN_EMAIL=you@example.com
DEV_AUTO_ACTIVATE=false
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_MONTHLY=price_...
STRIPE_PRICE_YEARLY=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=SYRIA TRADING <onboarding@resend.dev>
TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_BOT_USERNAME=YourBotUsername
```

### قاعدة البيانات (DATABASE_URL)

1. من لوحة Render أنشئ خدمة جديدة نوع **PostgreSQL** (فيها خطة مجانية).
2. بعد إنشائها، Render يعطيك رابط اتصال (Internal Database URL أو External Database URL).
3. انسخ الرابط وضعه بمتغير `DATABASE_URL` في إعدادات خدمة الويب (Web Service) الخاصة بموقعك — **وليس بخدمة قاعدة البيانات نفسها**.
4. الجداول (`users`, `sessions`, `payments`) تُنشأ تلقائيا أول ما يشتغل السيرفر، لا حاجة لأي إعداد يدوي.

⚠️ هذه الخطوة ضرورية جدا: بدون `DATABASE_URL` صحيح، أي حساب يتسجل سيضيع بمجرد إعادة تشغيل الخدمة (توقف تلقائي بعد فترة خمول أو عند أي Deploy جديد).

## ضبط الدفع الحقيقي عبر Stripe

1. في Render اضبط:
   ```env
   DEV_AUTO_ACTIVATE=false
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PRICE_MONTHLY=price_...
   STRIPE_PRICE_YEARLY=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   (استخدم مفاتيح Live الحقيقية من حسابك على Stripe، وليس مفاتيح Test، بما إن الموقع يعمل فعليا للزبائن)

2. من لوحة تحكم Stripe → Developers → Webhooks → أضف Endpoint جديد يشير إلى:
   ```text
   https://your-domain.onrender.com/api/stripe/webhook
   ```
   واختر الحدث `checkout.session.completed`.

3. انسخ الـ Signing secret الذي يظهر لك وضعه في `STRIPE_WEBHOOK_SECRET`.

الاشتراك لا يتفعل في الإنتاج إلا بعد وصول حدث `checkout.session.completed` من Stripe للخادم عبر الـ Webhook.

## المدير (Admin)

1. ضع بريد المدير في متغير البيئة:
   ```env
   ADMIN_EMAIL=you@example.com
   ```
2. سجّل حساب جديد بنفس هذا البريد بالضبط من صفحة "إنشاء حساب" في الموقع.
3. أول حساب يُنشأ بهذا البريد يحصل تلقائيا على صلاحية `admin`، وتظهر له لوحة الإدارة على `/admin.html`.

## التشغيل المحلي

1. ثبت Node.js 18 أو أحدث، وشغّل قاعدة بيانات PostgreSQL محلية أو استخدم واحدة سحابية مجانية (مثل Neon).
2. انسخ `.env.example` إلى `.env` واملأ القيم، أهمها `DATABASE_URL`.
3. شغل:
   ```bash
   npm install
   npm start
   ```
4. افتح `http://localhost:3000`.

## تفعيل التحقق من الإيميل (رمز تأكيد عند التسجيل)

بدون `RESEND_API_KEY`، الموقع يشتغل عاديا لكن بدون إرسال رمز التحقق فعليا (يُطبع تحذير بالـ Logs فقط، والحساب يبقى غير مفعل الإيميل).

1. أنشئ حساب مجاني على https://resend.com (3000 إيميل/شهر مجانا، 100/يوم).
2. من لوحة Resend → **API Keys** → أنشئ مفتاح جديد وانسخه لمتغير `RESEND_API_KEY`.
3. للبداية السريعة، اترك `RESEND_FROM_EMAIL` كما هو (`onboarding@resend.dev`) — يشتغل فورا بدون توثيق نطاق، لكنه مناسب للتجربة فقط وقد تصل رسائله لصندوق السبام أحيانا.
4. لاحقا، لإرسال احترافي من نطاقك الخاص (مثل `no-reply@syria-trading.com`)، وثّق نطاقك من **Domains** بلوحة Resend وحدّث `RESEND_FROM_EMAIL`.

## تفعيل إشعارات تلغرام

1. افتح تلغرام وتحدث مع **@BotFather** → أرسل `/newbot` واتبع التعليمات لإنشاء بوت جديد باسمك.
2. انسخ الـ **Token** الذي يعطيك ياه وضعه في `TELEGRAM_BOT_TOKEN`.
3. انسخ اسم المستخدم (username) الخاص بالبوت (بدون @) وضعه في `TELEGRAM_BOT_USERNAME`.
4. بعد نشر الموقع على Render، فعّل الـ Webhook بزيارة هذا الرابط مرة واحدة من متصفحك (استبدل القيم):
   ```text
   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-domain.onrender.com/api/telegram/webhook
   ```
   يفترض يرجعلك رد فيه `"ok":true`.
5. أي عضو مشترك يقدر يروح لصفحة الموقع الرئيسية ويشوف صندوق "🔔 فعّل تنبيهات تلغرام"، يضغط الزر، يفتحله تلغرام تلقائيا ويرسل رمز الربط، ويتفعل الربط فورا.
6. أي صفقة جديدة يقترحها النظام تنرسل تلقائيا لكل الأعضاء المشتركين: عبر تلغرام لمن ربط حسابه، وعبر الإيميل (لو `RESEND_API_KEY` مضبوط) للباقي.

## البث المباشر للشارت

الشارت يتصل ببيانات حية عبر مسار `/api/live-stream` بالسيرفر نفسه (وليس من متصفح الزائر مباشرة لـ Binance)، لتفادي مشاكل الحجب الجغرافي على بعض الشبكات. لا يحتاج أي إعداد إضافي — يعمل تلقائيا لكل أدوات Binance (العملات الرقمية والذهب). باقي الأدوات (فوركس، فضة، نفط، مؤشرات عبر Yahoo Finance) تتحدث كل 30 ثانية تلقائيا.
