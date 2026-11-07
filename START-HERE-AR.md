# ابدأ من هنا — TechBuilders Restaurant v3.0

## أولًا: اربط Firebase

1. افتح `public/js/firebase-config.js` والصق إعدادات Web App من Firebase Console.
2. من Firebase Authentication فعّل `Email/Password` و`Anonymous`.
3. من Firestore > Rules الصق ملف `firestore.rules` واضغط `Publish`.
4. من Firestore أنشئ `admins` ثم وثيقة باسم بريدك الإلكتروني بحروف صغيرة، وأضف `role` من نوع string وقيمته `admin`.

## ثانيًا: انشر الموقع

1. ارفع كل محتويات هذا المجلد إلى مستودع GitHub.
2. افتح Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git.
3. اختر مستودع المطعم.
4. اترك Build command فارغًا، واكتب `public` في Build output directory.
5. اضغط Deploy وانتظر ظهور رابط `*.pages.dev`.
6. أضف اسم النطاق `your-project.pages.dev` في Firebase Authentication > Settings > Authorized domains.

## ثالثًا: اربط Telegram

1. أنشئ البوت من `@BotFather`، وأضفه إلى القناة كمسؤول يستطيع إرسال الرسائل.
2. في Cloudflare Pages > Settings > Variables and Secrets أضف في Production:
   - Secret `TELEGRAM_BOT_TOKEN` = Bot Token.
   - Secret `TELEGRAM_CHAT_ID` = Chat ID أو `@channelname`.
   - Variable `ALLOWED_ORIGIN` = مثل `https://your-project.pages.dev` بلا `/` في النهاية.
3. أعد نشر آخر نسخة من Deployments.
4. افتح `https://your-project.pages.dev/api/send-order` وتأكد أن `telegramConfigured` تساوي `true`.

لا تضع Bot Token في ملفات `public` أو GitHub؛ ملفات الواجهة يراها كل زائر. Cloudflare يحفظه كـ Secret مجانيًا.

## رابعًا: أضف بيانات المطعم

1. افتح رابطك ثم `admin.html`.
2. سجّل الدخول بحساب Firebase المسؤول.
3. من إعدادات المطعم التقط موقع GPS وأنت داخل المطعم، وحدد نطاقًا مثل 100–150 مترًا ثم احفظ.
4. أضف الأقسام الرئيسية والتصنيفات الفرعية والوجبات والأسعار وروابط الصور.
5. جرّب من هاتفك: أضف وجبة للسلة، أدخل رقمك، تحقق من GPS، ثم أرسل الطلب.

**مهم:** تحقق GPS هنا حاجز بسيط يعمل في المتصفح، ويمكن تزويره على بعض الأجهزة المعدّلة. كذلك العميل يرسل السعر الظاهر في المنيو؛ هذه النسخة المبسطة ليست بديلًا عن خادم يعيد اعتماد الأسعار إذا كنت تحتاج منع تلاعب متقدم.
