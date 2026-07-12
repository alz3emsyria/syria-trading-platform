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
