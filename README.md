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

⚠️ **بدون `RESEND_API_KEY` مضبوط، ما رح يوصل أي رمز تحقق فعليا** — الموقع يطبع تحذير بالـ Logs فقط ("RESEND_API_KEY غير مضبوط") ويتخطى الإرسال، لكن الحساب يضل بانتظار التفعيل بدون ما يوصله شي. هذا هو سبب عدم وصول الرمز حاليا.

1. أنشئ حساب مجاني على https://resend.com (3000 إيميل/شهر مجانا، 100/يوم).
2. من لوحة Resend → **API Keys** → أنشئ مفتاح جديد وانسخه لمتغير `RESEND_API_KEY` بـ Render.
3. للبداية السريعة، اترك `RESEND_FROM_EMAIL` كما هو (`onboarding@resend.dev`) — يشتغل فورا بدون توثيق نطاق.
4. بعد الحفظ، Render يعيد نشر الموقع تلقائيا. جرب تسجيل حساب جديد وتأكد من وصول الرمز (تحقق من مجلد السبام أول مرة).
5. لاحقا، لإرسال احترافي من نطاقك الخاص، وثّق نطاقك من **Domains** بلوحة Resend وحدّث `RESEND_FROM_EMAIL`.

## الشارت المباشر

الشارت يعتمد على طبقتين معا لضمان حركته المستمرة زي TradingView تماما:

1. **بث حي فوري (SSE)**: السيرفر نفسه يتصل بـ Binance ويمرر كل تحديث سعر لحظة حدوثه للشارت — لا يحتاج أي إعداد إضافي.
2. **نبض احتياطي مضمون**: بالتوازي، الموقع يطلب آخر سعر كل 3 ثوان (Binance) أو 8 ثوان (فوركس/معادن/مؤشرات عبر Yahoo)، لضمان تحرك الشارت باستمرار حتى لو تأخر البث الفوري لأي سبب شبكي.

كلا الطبقتين يعملان تلقائيا فور فتح صفحة تحليل أي أداة، بدون أي إعداد إضافي.
