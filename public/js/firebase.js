import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';

let app = null;
let auth = null;
let db = null;
let sdk = {};

if (isFirebaseConfigured) {
  const [appSdk, authSdk, firestoreSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js')
  ]);
  app = appSdk.initializeApp(firebaseConfig);
  auth = authSdk.getAuth(app);
  db = firestoreSdk.getFirestore(app);
  sdk = { ...authSdk, ...firestoreSdk };
}

export { app, auth, db, sdk, isFirebaseConfigured };
