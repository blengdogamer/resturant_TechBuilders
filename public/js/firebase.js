import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';

let app = null;
let auth = null;
let db = null;
let guestApp = null;
let guestAuth = null;
let guestDb = null;
let sdk = {};
let appSdk = null;
let authSdk = null;

if (isFirebaseConfigured) {
  const [loadedAppSdk, loadedAuthSdk, firestoreSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js')
  ]);
  appSdk = loadedAppSdk;
  authSdk = loadedAuthSdk;
  sdk = { ...authSdk, ...firestoreSdk };

  app = appSdk.initializeApp(firebaseConfig);
  auth = authSdk.getAuth(app);
  db = firestoreSdk.getFirestore(app);

  // Customer authentication is isolated from the admin's default Auth session.
  guestApp = appSdk.getApps().find(candidate => candidate.name === 'techbuilders-customer-app')
    || appSdk.initializeApp(firebaseConfig, 'techbuilders-customer-app');
  guestAuth = authSdk.getAuth(guestApp);
  guestDb = firestoreSdk.getFirestore(guestApp);
}

// Uses a secondary Firebase Auth app so creating an employee does not log out the owner.
async function createEmployeeAuthAccount(email, password) {
  if (!isFirebaseConfigured || !appSdk || !authSdk) throw new Error('Firebase غير مهيأ.');
  const appName = 'techbuilders-employee-creator';
  const existing = appSdk.getApps().find(candidate => candidate.name === appName);
  const secondaryApp = existing || appSdk.initializeApp(firebaseConfig, appName);
  const secondaryAuth = authSdk.getAuth(secondaryApp);
  try {
    const credential = await authSdk.createUserWithEmailAndPassword(secondaryAuth, email, password);
    return { uid: credential.user.uid, email: credential.user.email };
  } finally {
    await authSdk.signOut(secondaryAuth).catch(() => {});
  }
}

export { app, auth, db, guestApp, guestAuth, guestDb, sdk, isFirebaseConfigured, createEmployeeAuthAccount };
