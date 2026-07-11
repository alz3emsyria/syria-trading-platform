# SYRIA TRADING Platform

هذا الإصدار يحول الصفحة من عرض أمامي فقط إلى تطبيق أعضاء يعمل عبر خادم:

- تسجيل حسابات وحفظها في `data/db.json`.
- جلسات دخول بكوكي `HttpOnly`.
- اشتراك مدفوع جاهز للربط مع Stripe Checkout.
- وضع تطوير يفعّل الاشتراك محليا للتجربة.
- تحليل العملات الرقمية من الخادم عبر Binance.
- لوحة إدارة على `/admin.html`.

## التشغيل المحلي

1. ثبت Node.js 18 أو أحدث.
2. انسخ `.env.example` إلى `.env`.
3. شغل:

```bash
npm start
```

ثم افتح:

```text
http://localhost:3000
```

## ضبط الدفع الحقيقي

في الإنتاج اجعل:

```env
DEV_AUTO_ACTIVATE=false
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_MONTHLY=price_...
STRIPE_PRICE_YEARLY=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

ثم وجّه Stripe webhook إلى:

```text
https://your-domain.com/api/stripe/webhook
```

الاشتراك لا يتفعل في الإنتاج إلا بعد وصول حدث `checkout.session.completed`.

## المدير

ضع بريد المدير في:

```env
ADMIN_EMAIL=you@example.com
```

أول حساب يتم إنشاؤه بهذا البريد يحصل على صلاحية إدارة، ثم تظهر له لوحة الإدارة.
