// انسخ إعدادات تطبيق Web من Firebase Console > Project settings > Your apps.
// لا تضع TELEGRAM_BOT_TOKEN هنا؛ رمز البوت يبقى في Cloudflare Pages Secrets ولا يوضع في هذا الملف العام.
export const firebaseConfig = {
  apiKey: "AIzaSyBs_UjlT8dTaA9sP0hBk3jjMqpn44VyckE",
  authDomain: "quiz-alakshar-f2a08.firebaseapp.com",
  projectId: "quiz-alakshar-f2a08",
  storageBucket: "quiz-alakshar-f2a08.firebasestorage.app",
  messagingSenderId: "883648884787",
  appId: "1:883648884787:web:1dd82e120d09257ac2f346"
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId
);
