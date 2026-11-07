# TechBuilders Restaurant v3.0 — نسخة مجانية مبسطة

موقع منيو عربي RTL بتصميم كتاب وتقليب صفحات، متجاوب للجوال، سلة موحدة، تفاصيل وجبة وملاحظات، لوحة مسؤول، طلبات محفوظة في Firestore، وإشعار Telegram. لا توجد وجبات تجريبية أو بيانات جاهزة.

## ما الذي تغيّر؟

- حذف Cloud Functions وكل اعتماد على Firebase Blaze.
- حذف QR والرموز المؤقتة بالكامل. التحقق من داخل المطعم باستخدام GPS ونطاق المسافة فقط.
- نشر الواجهة وواجهة Telegram عبر Cloudflare Pages من مستودع GitHub.
- الاحتفاظ بـ Firebase Authentication وCloud Firestore على خطة Spark ضمن حصصها المجانية.
- حفظ Telegram Bot Token وChat ID كـ Secrets مشفرة في Cloudflare، وليس داخل JavaScript العام.
- الصور تضاف كرابط HTTPS مباشر داخل بيانات الوجبة، ولا يلزم Firebase Storage.
- تحسين أحجام الخطوط والأزرار واللمس والسحب للجوال.

## البنية

- `public/index.html` — منيو العملاء.
- `public/admin.html` — لوحة المسؤول.
- `public/js/app.js` — المنيو والسلة وفحص GPS وتسجيل الطلب.
- `public/js/admin.js` — تسجيل دخول المسؤول وإدارة الأقسام والتصنيفات والأصناف والطلبات.
- `public/js/firebase-config.js` — إعدادات Firebase Web العامة.
- `public/js/telegram-config.js` — مسار API فقط؛ لا يحتوي على سر البوت.
- `functions/api/send-order.js` — Pages Function ترسل إشعار Telegram باستخدام أسرار Cloudflare.
- `firestore.rules` — قواعد Firestore.

## 1. إعداد Firebase (دون تفعيل الفوترة)

1. افتح Firebase Console واختر مشروع المطعم.
2. من Project settings > General > Your apps أنشئ تطبيق Web أو استخدم التطبيق الموجود.
3. انسخ إعدادات الويب إلى `public/js/firebase-config.js`:

```js
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain &&
  firebaseConfig.projectId && firebaseConfig.appId
);
```

4. Authentication > Sign-in method: فعّل `Email/Password` و`Anonymous`.
5. بعد نشر Cloudflare Pages، اذهب إلى Authentication > Settings > Authorized domains وأضف النطاق الذي أعطاك إياه Cloudflare مثل `techbuilders-menu.pages.dev` (من دون `https://`).
6. أنشئ Firestore Database باستخدام قاعدة البيانات الافتراضية `(default)` في Native mode. الخطة Spark تعطي حصة مجانية لقاعدة بيانات واحدة.
7. من Firestore > Rules الصق محتوى ملف `firestore.rules` واضغط Publish.
8. في Authentication > Users تأكد أن حسابك موجود. في Firestore > Data أنشئ مجموعة `admins` ثم وثيقة Document ID تساوي بريدك الإلكتروني بحروف صغيرة، مثل `myemail@gmail.com`، وبداخلها:
   - `email` نوع string وقيمته نفس البريد الصغير.
   - `role` نوع string وقيمته `admin`.

لا تنشئ حساب مسؤول من الموقع؛ لوحة الإدارة تقبل فقط المستخدم الموجود في Firebase Authentication والموثق في `admins`.

## 2. نشر الموقع مجانًا من GitHub عبر Cloudflare Pages

**مهم:** GitHub Pages غير مناسب للموقع التشغيلي لمطعم يستقبل طلبات تجارية؛ شروط GitHub تنص على أن Pages ليس لاستضافة الأعمال التجارية أو المواقع التي تسهّل المعاملات. استخدم Cloudflare Pages المجاني المرتبط بمستودع GitHub. يبقى الكود محفوظًا في GitHub، وكل Push جديد ينشر التحديث تلقائيًا.

1. ارفع محتويات مجلد المشروع إلى مستودع GitHub (لا ترفع أي Bot Token أو ملف أسرار).
2. افتح Cloudflare Dashboard وأنشئ حسابًا مجانيًا.
3. Workers & Pages > Create application > Pages > Connect to Git.
4. اختر مستودع `techbuilders-restaurant`.
5. إعدادات البناء:
   - Framework preset: `None` أو `Other`.
   - Build command: اتركه فارغًا.
   - Build output directory: `public`.
   - Root directory: اتركه `/` أو فارغًا.
6. احفظ واضغط Deploy. سيكتشف Cloudflare تلقائيًا الملف `functions/api/send-order.js` وينشره كمسار `/api/send-order`.
7. سيظهر رابط مثل `https://techbuilders-menu.pages.dev`. افتحه من الهاتف وتأكد أن صفحة المنيو تظهر.

لا تحتاج `npm install` أو `firebase deploy` أو بطاقة دفع لنشر هذه النسخة. Cloudflare Pages يخدم الملفات الثابتة مجانًا، وطلبات Pages Functions تدخل ضمن حصة Workers Free البالغة 100,000 طلب يوميًا. الملفات الثابتة لا تخصم من حصة Function عند ضبط مسارات الوظائف كما هو في `public/_routes.json`.

## 3. ربط Telegram مرة واحدة

1. أنشئ بوتًا من `@BotFather` وخذ Bot Token.
2. أضف البوت إلى قناة المطعم كمسؤول مع صلاحية إرسال الرسائل.
3. احصل على Chat ID للقناة؛ يمكن أن يكون `@channelname` أو رقم القناة مثل `-100...`.
4. افتح Cloudflare Dashboard > Workers & Pages > مشروع الموقع > Settings > Variables and Secrets.
5. ضمن Production أضف القيم التالية:
   - Secret: `TELEGRAM_BOT_TOKEN` = رمز البوت من BotFather.
   - Secret: `TELEGRAM_CHAT_ID` = Chat ID القناة.
   - Variable: `ALLOWED_ORIGIN` = أصل الموقع فقط، مثل `https://techbuilders-menu.pages.dev` دون شرطة مائلة في النهاية.
6. احفظ ثم افتح Deployments واضغط Redeploy لآخر Production deployment.
7. افتح `https://YOUR-PROJECT.pages.dev/api/send-order`؛ يجب أن ترى `"ok": true` و`"telegramConfigured": true`.

**لا تضع Bot Token داخل `public/js` أو داخل مستودع GitHub العام.** أي زائر يستطيع قراءة ملفات JavaScript المنشورة وسرقة الرمز والتحكم بالبوت. Cloudflare يحفظه مشفرًا ويستخدم الخطة المجانية. إذا تسرب الرمز في أي وقت، ألغِه من BotFather وأنشئ واحدًا جديدًا.

## 4. إعداد المطعم من لوحة الإدارة

1. افتح `https://YOUR-PROJECT.pages.dev/admin.html`.
2. سجّل الدخول ببريد المسؤول وكلمة المرور في Firebase Authentication.
3. من إعدادات المطعم اكتب اسم المطعم والعملة.
4. قف داخل المطعم من هاتف يتيح GPS واضغط «استخدام موقعي الحالي كنقطة المطعم»، أو اكتب Latitude وLongitude يدويًا. ثم اضغط حفظ.
5. عيّن نطاق التحقق بالمتر. ابدأ بـ 100–150 مترًا حسب دقة GPS وموقع المطعم.
6. أضف الأقسام الرئيسية مثل «المأكولات» و«المشروبات».
7. أضف التصنيفات الفرعية مثل «برغر» و«بيتزا» واربط كل تصنيف بالقسم الرئيسي.
8. أضف الوجبات: الاسم، رابط صورة HTTPS عام، الوصف، المكونات، السعر والعملة.
9. افتح صفحة الطلبات لمتابعة الطلبات الواردة وتغيير حالتها.

## 5. تجربة العميل على الهاتف

1. يفتح العميل رابط المنيو من هاتفه.
2. يختار الوجبات، ويفتح صفحة كل وجبة، ويختار الكمية ويكتب الملاحظة.
3. يفتح السلة ويكتب رقم هاتفه.
4. يضغط «تحقق من موقعي» ويسمح للمتصفح باستخدام GPS.
5. يقارن الموقع الحالي بنقطة المطعم ونطاق المسافة. إذا كان خارج النطاق، لن يسمح الموقع بإرسال الطلب.
6. يضغط «إرسال الطلب». يُحفظ الطلب في Firestore ثم يُرسل إشعار إلى قناة Telegram.

التأكد من الموقع صالح لمدة 10 دقائق، وبعد إرسال الطلب يلزم التحقق مرة أخرى للطلب الجديد.

## 6. حدود مجانية الخدمة

- Firestore Spark: 1 GiB تخزين، و50,000 قراءة مستند يوميًا، و20,000 كتابة يوميًا، و20,000 حذف يوميًا، و10 GiB نقل بيانات شهريًا لقاعدة البيانات المجانية الواحدة.
- Cloudflare Workers Free: حتى 100,000 طلب يوميًا لوظائف Pages/Workers مجتمعة. الملفات الثابتة في Pages مجانية وغير محدودة ضمن سياسة الخدمة.
- لا توجد Firebase Cloud Functions في هذه النسخة، لذلك لا تحتاج Blaze أو ربط بطاقة من أجل Telegram.
- الحصص قابلة للتغيير من الشركات؛ راجع الروابط الرسمية قبل تشغيل كثيف.

## 7. تنبيهات أمان مهمة

- إعدادات Firebase Web وAPI Key ليست أسرارًا؛ أمان البيانات يأتي من قواعد Firestore. لا تفتح قواعد Firestore للجميع.
- Bot Token سرّ خاص، ومخزّن في Cloudflare Secrets وليس في ملفات الموقع.
- تحقق GPS في المتصفح مناسب كحاجز بسيط لمنع الطلب العرضي من خارج المطعم، لكنه ليس إثباتًا أمنيًا مطلقًا. يمكن تزوير GPS على بعض الأجهزة المعدّلة، كما يمكن تقليد طلب من خارج المتصفح. لا تستخدمه كدليل أمني قوي أو للتحصيل المسبق.
- قواعد Firestore تسمح للمستخدم المجهول بإنشاء طلب بصيغة محددة. لا يستطيع العميل قراءة الطلبات؛ لوحة المسؤول فقط تقرؤها. لكن المجموع/الأسعار المرسلة من المتصفح ليست محمية مثل نظام لديه خادم موثوق يعيد تسعير الأصناف. راجع الطلب في لوحة الإدارة قبل اعتماده.
- لا تحفظ بيانات بطاقات دفع أو كلمات مرور الزبائن في هذا النظام.

## 8. تشغيل محلي سريع

يمكن تشغيل الواجهة محليًا عبر Node.js:

```cmd
npm run preview
```

ثم افتح `http://localhost:4173`. المسار `/api/send-order` لن يعمل محليًا إلا بعد توفير بيئة Cloudflare Pages محلية؛ الأفضل اختبار إرسال Telegram من رابط النشر بعد إضافة الأسرار.

## هيكل Firestore

- `admins/{lowercaseEmail}`: `email`, `role`.
- `settings/restaurant`: `name`, `footerMessage`, `currency`, `location { address, lat, lng, radius }`.
- `menuGroups/{id}`: `name`, `description`, `sortOrder`, `active`.
- `categories/{id}`: `name`, `groupId`, `sortOrder`, `active`.
- `menuItems/{id}`: `name`, `categoryId`, `description`, `ingredients`, `imageUrl`, `price`, `currency`, `sortOrder`, `active`.
- `orders/{id}`: `orderNumber`, `phone`, `items`, `total`, `currency`, `status`, `customerUid`, `location`, `createdAt`.

## روابط رسمية

- Cloudflare Pages: https://developers.cloudflare.com/pages/
- Pages Functions: https://developers.cloudflare.com/pages/functions/
- Workers Free limits: https://developers.cloudflare.com/workers/platform/limits/
- Firestore quotas: https://firebase.google.com/docs/firestore/quotas
- Firebase pricing plans: https://firebase.google.com/pricing
- Telegram Bot API: https://core.telegram.org/bots/api
- GitHub Pages policy: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-pages
