import { auth, db, sdk, isFirebaseConfigured, createEmployeeAuthAccount } from './firebase.js';
import { firebaseConfig } from './firebase-config.js';

const $ = selector => document.querySelector(selector);
let currentAdmin = null;
let currentRole = 'admin';
let currentPermissions = ['overview', 'orders', 'archive'];
let archiveOrders = [];
let archivePage = 1;
let orderEditingDraft = null;
let taxesDraft = [];
const migratingCompletedOrders = new Set();
let groups = [];
let categories = [];
let items = [];
let orders = [];
let restaurantSettings = {};
let editing = { type: null, id: null };
let stopOrdersListener = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const sortByOrder = rows => rows.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
const money = (amount, currency = 'ل.س') => `${Number(amount || 0).toLocaleString('ar-SY')} ${escapeHtml(currency)}`;
const groupName = id => groups.find(group => group.id === id)?.name || 'قسم محذوف';
const categoryName = id => categories.find(category => category.id === id)?.name || 'تصنيف محذوف';
const statusNames = {
  pending: 'قيد الانتظار', accepted: 'تم القبول', preparing: 'قيد التحضير',
  ready: 'جاهز', completed: 'مكتمل', cancelled: 'ملغي'
};

function showToast(message, duration = 3000) {
  const node = $('#adminToast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => node.classList.remove('show'), duration);
}

function showLogin(message = '') {
  $('#adminApp').hidden = true;
  $('#loginScreen').hidden = false;
  if (message) $('#loginError').textContent = message;
}

async function resolveAccess(user) {
  if (!user?.email) throw new Error('هذا الحساب لا يحتوي على بريد إلكتروني.');
  const email = user.email.trim().toLowerCase();
  const [emailSnap, uidSnap] = await Promise.all([
    sdk.getDoc(sdk.doc(db, 'admins', email)),
    sdk.getDoc(sdk.doc(db, 'admins', user.uid))
  ]);
  const isOwner = (emailSnap.exists() && emailSnap.data().role === 'admin')
    || (uidSnap.exists() && uidSnap.data().role === 'admin');
  if (isOwner) return { email, role: 'admin', permissions: ['overview', 'orders', 'archive'] };
  const staffSnap = await sdk.getDoc(sdk.doc(db, 'staff', user.uid));
  if (staffSnap.exists() && staffSnap.data().active !== false && staffSnap.data().role === 'employee') {
    const permissions = Array.isArray(staffSnap.data().permissions) ? staffSnap.data().permissions : [];
    if (!permissions.length) throw new Error('حساب الموظف لا يملك صلاحيات مفعّلة. اطلب من صاحب المطعم تعديل صلاحياته.');
    return { email, role: 'employee', permissions };
  }
  throw new Error(`الحساب ${email} غير مخوّل. أضفه إلى admins كمالك أو أنشئه من إدارة الموظفين.`);
}

function canSee(panel) {
  return currentRole === 'admin' || currentPermissions.includes(panel);
}

function applyPermissions() {
  document.querySelectorAll('#sideNav [data-panel]').forEach(button => {
    const panel = button.dataset.panel;
    button.hidden = currentRole !== 'admin' && !canSee(panel);
  });
  document.querySelectorAll('[data-owner-only]').forEach(node => { node.hidden = currentRole !== 'admin'; });
  document.querySelectorAll('#sideNav [data-panel]').forEach(button => {
    const panel = button.dataset.panel;
    if (['groups', 'categories', 'items'].includes(panel)) button.hidden = currentRole !== 'admin' && !canSee(panel);
  });
  document.querySelectorAll('[data-employee-role]').forEach(node => { node.hidden = currentRole !== 'employee'; });
  const roleLabel = currentRole === 'admin' ? 'OWNER / ADMIN' : 'EMPLOYEE';
  $('#roleLabel').textContent = roleLabel;
  const firstAllowed = currentRole === 'admin' ? 'overview' : ['overview', 'orders', 'archive', 'groups', 'categories', 'items'].find(panel => currentPermissions.includes(panel));
  switchPanel(firstAllowed);
}

async function login(event) {
  event.preventDefault();
  $('#loginError').textContent = '';
  if (!isFirebaseConfigured || !auth) {
    $('#loginError').textContent = 'أدخل بيانات Firebase أولًا في public/js/firebase-config.js.';
    return;
  }
  const button = $('#loginButton');
  button.disabled = true;
  button.textContent = 'جارٍ تسجيل الدخول...';
  try {
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    await sdk.signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged يتحقق من وثيقة admins ويفتح اللوحة إذا كان الحساب مخوّلًا.
  } catch (error) {
    console.error(error);
    if (auth.currentUser) await sdk.signOut(auth).catch(() => {});
    const message = error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found'
      ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'
      : error.message || 'تعذر تسجيل الدخول.';
    $('#loginError').textContent = message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'دخول لوحة الإدارة <span>←</span>';
  }
}

async function authChanged(user) {
  if (!user) {
    currentAdmin = null;
    currentRole = 'admin';
    currentPermissions = [];
    if (stopOrdersListener) stopOrdersListener();
    showLogin();
    return;
  }
  if (!isFirebaseConfigured || !db) return showLogin('إعدادات Firebase غير مكتملة.');
  try {
    const access = await resolveAccess(user);
    currentAdmin = user;
    currentRole = access.role;
    currentPermissions = access.permissions;
    $('#adminEmailLabel').textContent = access.email;
    $('#loginScreen').hidden = true;
    $('#adminApp').hidden = false;
    applyPermissions();
    await loadAdminData();
  } catch (error) {
    console.error(error);
    await sdk.signOut(auth).catch(() => {});
    showLogin(error.message || 'هذا الحساب غير مخوّل.');
  }
}

async function loadAdminData() {
  try {
    const settingsSnap = await sdk.getDoc(sdk.doc(db, 'settings', 'restaurant'));
    restaurantSettings = settingsSnap.exists() ? settingsSnap.data() : {};
    fillSettings();
    applyAdminBranding();
    if (currentRole === 'admin') {
      await loadMenuCollections();
      loadStaff();
    } else if (['overview', 'groups', 'categories', 'items'].some(canSee)) {
      const [groupSnap, categorySnap, itemSnap] = await Promise.all([
        sdk.getDocs(sdk.query(sdk.collection(db, 'menuGroups'), sdk.where('active', '==', true))),
        sdk.getDocs(sdk.query(sdk.collection(db, 'categories'), sdk.where('active', '==', true))),
        sdk.getDocs(sdk.query(sdk.collection(db, 'menuItems'), sdk.where('active', '==', true)))
      ]);
      groups = sortByOrder(groupSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      categories = sortByOrder(categorySnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      items = sortByOrder(itemSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    }
    renderEverything();
    if (canSee('orders')) listenOrders();
    if (canSee('archive')) loadArchive();
  } catch (error) {
    console.error(error);
    showToast('تعذر تحميل بيانات الإدارة: ' + (error.message || 'تحقق من قواعد Firestore'), 6000);
  }
}

function applyAdminBranding() {
  const theme = restaurantSettings.theme || {};
  const root = document.documentElement;
  const cssMap = { '--blue': theme.primary, '--blue2': theme.accent, '--bg': theme.background, '--panel': theme.surface, '--panel2': theme.surface2, '--paper': theme.paper, '--paper2': theme.paper2, '--ink': theme.ink, '--text': theme.text, '--muted': theme.muted };
  for (const [property, value] of Object.entries(cssMap)) if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(property, value);
  if (typeof theme.border === 'string' && /^#[0-9a-f]{6}$/i.test(theme.border)) root.style.setProperty('--line', `${theme.border}80`);
  if (theme.background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.background);
  const rawLogo = String(restaurantSettings.logoUrl || '').trim();
  const logo = rawLogo && (rawLogo.startsWith('https://') || rawLogo.startsWith('./') || rawLogo.startsWith('/')) ? rawLogo : './assets/techbuilders-logo.jpg';
  document.querySelectorAll('.admin-brand img,.login-logo').forEach(image => { image.src = logo; });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = logo;
}

function renderEverything() {
  if (currentRole === 'admin' || canSee('groups')) renderGroups();
  if (currentRole === 'admin' || canSee('categories')) renderCategories();
  if (currentRole === 'admin' || canSee('items')) {
    populateCategoryFilter();
    renderItems();
  }
  renderStats();
  renderOrders();
}

function renderStats() {
  $('#statGroups').textContent = groups.filter(row => row.active !== false).length;
  $('#statCategories').textContent = categories.filter(row => row.active !== false).length;
  $('#statItems').textContent = items.filter(row => row.active !== false).length;
  const pending = orders.filter(order => order.status === 'pending').length;
  $('#statPending').textContent = pending;
  $('#pendingCount').textContent = pending;
}

function renderGroups() {
  if (!groups.length) {
    $('#groupsList').innerHTML = '<div class="empty-list">لم تتم إضافة أقسام رئيسية بعد.<br>اضغط «إضافة قسم» للبدء.</div>';
    return;
  }
  $('#groupsList').innerHTML = groups.map(group => `
    <article class="entity-card">
      <div class="entity-icon">▤</div>
      <div class="entity-copy"><h4>${escapeHtml(group.name)}</h4><p>${escapeHtml(group.description || 'قسم رئيسي في المنيو')}</p><div class="entity-meta">${categories.filter(category => category.groupId === group.id).length} تصنيف فرعي · <span class="status-pill ${group.active === false ? 'off' : ''}">${group.active === false ? 'مخفي' : 'ظاهر'}</span></div></div>
      <div class="entity-actions" ${currentRole === 'admin' ? '' : 'hidden'}><button class="icon-button" data-edit="group" data-id="${escapeHtml(group.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="group" data-id="${escapeHtml(group.id)}" aria-label="حذف">×</button></div>
    </article>`).join('');
}

function renderCategories() {
  if (!categories.length) {
    $('#categoriesList').innerHTML = '<div class="empty-list">لا توجد تصنيفات فرعية بعد.<br>أضف قسمًا رئيسيًا أولًا، ثم أضف التصنيفات تحته.</div>';
    return;
  }
  $('#categoriesList').innerHTML = categories.map(category => `
    <article class="entity-card">
      <div class="entity-icon">☷</div>
      <div class="entity-copy"><h4>${escapeHtml(category.name)}</h4><p>القسم الرئيسي: ${escapeHtml(groupName(category.groupId))}</p><div class="entity-meta">${items.filter(item => item.categoryId === category.id).length} وجبة · <span class="status-pill ${category.active === false ? 'off' : ''}">${category.active === false ? 'مخفي' : 'ظاهر'}</span></div></div>
      <div class="entity-actions" ${currentRole === 'admin' ? '' : 'hidden'}><button class="icon-button" data-edit="category" data-id="${escapeHtml(category.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="category" data-id="${escapeHtml(category.id)}" aria-label="حذف">×</button></div>
    </article>`).join('');
}

function populateCategoryFilter() {
  const current = $('#itemCategoryFilter').value || 'all';
  $('#itemCategoryFilter').innerHTML = '<option value="all">كل التصنيفات</option>' + categories.map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(groupName(category.groupId))} — ${escapeHtml(category.name)}</option>`).join('');
  $('#itemCategoryFilter').value = categories.some(category => category.id === current) ? current : 'all';
}

function renderItems() {
  const search = ($('#itemSearch').value || '').trim().toLowerCase();
  const categoryId = $('#itemCategoryFilter').value || 'all';
  const filtered = items.filter(item => (categoryId === 'all' || item.categoryId === categoryId)
    && (!search || String(item.name || '').toLowerCase().includes(search)));
  if (!filtered.length) {
    $('#itemsList').innerHTML = '<div class="empty-list">لا توجد وجبات مطابقة.<br>أضف وجبتك الأولى باستخدام زر «إضافة وجبة».</div>';
    return;
  }
  $('#itemsList').innerHTML = filtered.map(item => `
    <article class="entity-card">
      ${item.imageUrl ? `<img class="entity-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}">` : `<div class="entity-image entity-icon">TB</div>`}
      <div class="entity-copy"><h4>${escapeHtml(item.name)}</h4><p>${escapeHtml(categoryName(item.categoryId))} · ${escapeHtml((item.description || '').slice(0, 75))}</p><div class="entity-meta">${money(item.price, item.currency)} · <span class="status-pill ${item.active === false ? 'off' : ''}">${item.active === false ? 'مخفي' : 'متاح'}</span></div></div>
      <div class="entity-actions" ${currentRole === 'admin' ? '' : 'hidden'}><button class="icon-button" data-edit="item" data-id="${escapeHtml(item.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="item" data-id="${escapeHtml(item.id)}" aria-label="حذف">×</button></div>
    </article>`).join('');
  $('#itemsList').querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
}

function formatDate(value) {
  try {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'وقت غير متاح';
    return new Intl.DateTimeFormat('ar-SY', { dateStyle: 'medium', timeStyle: 'short', timeZone: restaurantSettings.timeZone || 'Asia/Damascus' }).format(date);
  } catch { return 'وقت غير متاح'; }
}

function paymentStatusLabel(payment = {}) {
  const labels = {
    unpaid: 'الدفع عند الاستلام', pending_invoice: 'بانتظار إصدار الفاتورة',
    awaiting_payment: 'بانتظار الدفع', paid: 'مدفوع شام كاش', partial: 'دفعة ناقصة',
    expired: 'انتهت الفاتورة', pending: 'بانتظار الدفع', cancelled: 'ملغاة'
  };
  return labels[payment.status] || (payment.method === 'shamcash' ? 'شام كاش' : 'الدفع عند الاستلام');
}

function invoicePrintHtml(order) {
  const restaurantName = escapeHtml(restaurantSettings.name || 'المطعم');
  const logoUrl = String(restaurantSettings.logoUrl || '').trim();
  const logo = logoUrl && /^https:\/\//i.test(logoUrl) ? `<img class="receipt-logo" src="${escapeHtml(logoUrl)}" alt="">` : '';
  const currency = order.currency || restaurantSettings.currency || 'ل.س';
  const rows = (order.items || []).map((item, index) => `
    <tr><td class="receipt-number">${index + 1}</td><td><b>${escapeHtml(item.name || 'صنف')}</b>${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}</td><td>${Number(item.quantity || 0)}</td><td>${money(item.unitPrice ?? (Number(item.subtotal || 0) / Math.max(1, Number(item.quantity || 1))), currency)}</td><td>${money(item.subtotal, currency)}</td></tr>`).join('');
  const taxes = Array.isArray(order.taxes) ? order.taxes : [];
  const computedSubtotal = (order.items || []).reduce((sum, item) => sum + Number(item.subtotal ?? (Number(item.unitPrice || 0) * Number(item.quantity || 1))), 0);
  const subtotal = Number.isFinite(Number(order.subtotal)) ? Number(order.subtotal) : computedSubtotal;
  const computedTaxTotal = taxes.reduce((sum, tax) => sum + Number(tax.amount || 0), 0);
  const taxTotal = Number.isFinite(Number(order.taxTotal)) ? Number(order.taxTotal) : computedTaxTotal;
  const grandTotal = Number.isFinite(Number(order.total)) ? Number(order.total) : subtotal + taxTotal;
  const taxLines = taxes.map(tax => `<div class="receipt-total-row"><span>${escapeHtml(tax.name || 'ضريبة')} ${Number(tax.rate || 0)}%</span><b>${money(tax.amount, currency)}</b></div>`).join('');
  const paymentText = paymentStatusLabel(order.payment || {});
  const serviceText = order.serviceType === 'takeaway' ? 'سفري' : 'محلي داخل المطعم';
  return `<section class="receipt-sheet" dir="rtl">
    <header class="receipt-header">${logo}<div><h1>${restaurantName}</h1><p>فاتورة مبيعات</p></div></header>
    <div class="receipt-meta"><div><span>رقم الفاتورة</span><b>${escapeHtml(order.orderNumber || order.id)}</b></div><div><span>التاريخ</span><b>${escapeHtml(formatDate(order.createdAt))}</b></div><div><span>العميل</span><b>${escapeHtml(order.phone || '—')}</b></div><div><span>نوع الطلب</span><b>${serviceText}</b></div><div><span>طريقة الدفع</span><b>${escapeHtml(paymentText)}</b></div></div>
    <table class="receipt-items"><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead><tbody>${rows || '<tr><td colspan="5">لا توجد أصناف</td></tr>'}</tbody></table>
    <div class="receipt-totals"><div class="receipt-total-row"><span>المجموع الفرعي</span><b>${money(subtotal, currency)}</b></div>${taxLines}<div class="receipt-total-row"><span>إجمالي الضرائب والرسوم</span><b>${money(taxTotal, currency)}</b></div><div class="receipt-grand-total"><span>الإجمالي النهائي</span><b>${money(grandTotal, currency)}</b></div></div>
    ${order.payment?.transactionId ? `<p class="receipt-payment-ref">رقم عملية شام كاش: ${escapeHtml(order.payment.transactionId)}</p>` : ''}
    <footer class="receipt-footer"><b>شكرًا لزيارتكم</b><span>${escapeHtml(restaurantSettings.footerMessage || 'نتمنى لكم تجربة لذيذة')}</span><small>تم إصدار الفاتورة إلكترونيًا بواسطة نظام المطعم</small></footer>
  </section>`;
}

function printOrderInvoice(order) {
  if (!order) return;
  const root = $('#invoicePrintRoot');
  root.innerHTML = invoicePrintHtml(order);
  root.setAttribute('aria-hidden', 'false');
  const finish = () => { root.innerHTML = ''; root.setAttribute('aria-hidden', 'true'); window.removeEventListener('afterprint', finish); };
  window.addEventListener('afterprint', finish, { once: true });
  window.print();
  setTimeout(finish, 60000);
}

async function callShamcashEndpoint(endpoint, payload) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, projectId: firebaseConfig.projectId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(result.error || 'تعذر الاتصال بخدمة شام كاش.');
  return result;
}

async function issueInvoiceForOrder(order, archive = false) {
  if (!order || order.payment?.method !== 'shamcash') return;
  try {
    const result = await callShamcashEndpoint('/api/shamcash/create-invoice', {
      orderId: order.id, orderNumber: order.orderNumber, amount: order.total, currency: order.currency
    });
    const payment = {
      method: 'shamcash', status: 'awaiting_payment', invoiceId: result.invoice.invoiceId,
      paymentUrl: result.invoice.paymentUrl, paymentNote: result.invoice.paymentNote || order.orderNumber,
      expiresAt: result.invoice.expiresAt || null, createdAt: sdk.serverTimestamp()
    };
    const collection = archive ? 'orderArchive' : 'orders';
    await sdk.updateDoc(sdk.doc(db, collection, order.id), { payment });
    order.payment = payment;
    if (archive) renderArchive(); else renderOrders();
    showToast('تم إنشاء فاتورة شام كاش.');
  } catch (error) {
    console.error(error); showToast(error.message || 'تعذر إصدار الفاتورة.', 6000);
  }
}

async function verifyShamcashPayment(order, archive = false) {
  if (!order?.payment?.invoiceId) return;
  try {
    const result = await callShamcashEndpoint('/api/shamcash/invoice-status', {
      orderId: order.id, invoiceId: order.payment.invoiceId, orderNumber: order.orderNumber
    });
    const payment = { ...order.payment, ...result.payment, checkedAt: sdk.serverTimestamp() };
    const collection = archive ? 'orderArchive' : 'orders';
    await sdk.updateDoc(sdk.doc(db, collection, order.id), { payment });
    order.payment = payment;
    if (archive) renderArchive(); else renderOrders();
    showToast(`حالة دفع شام كاش: ${paymentStatusLabel(payment)}`);
  } catch (error) {
    console.error(error); showToast(error.message || 'تعذر التحقق من الدفع.', 6000);
  }
}

function renderOrders() {
  const selectedStatus = $('#orderFilter').value || 'all';
  // Do not expose unpaid ShamCash checkout drafts as restaurant orders.
  const rows = orders.filter(order =>
    order.status !== 'completed' &&
    !(order.payment?.method === 'shamcash' && order.payment?.status !== 'paid') &&
    (selectedStatus === 'all' || order.status === selectedStatus)
  );
  const html = rows.length ? rows.map(order => `
    <article class="order-card">
      <div class="order-head"><div><div class="order-id">${escapeHtml(order.orderNumber || order.id)}</div><div class="order-time">${formatDate(order.createdAt)} · ${order.serviceType === 'takeaway' ? 'سفري' : 'محلي'}</div></div><div class="order-phone">${escapeHtml(order.phone || '')}</div></div>
      <div class="order-items">${(order.items || []).map(item => `<div class="order-item-line"><span>${escapeHtml(item.name)} × ${Number(item.quantity || 0)}${item.note ? `<small class="order-item-note">ملاحظة: ${escapeHtml(item.note)}</small>` : ''}</span><b>${money(item.subtotal, item.currency)}</b></div>`).join('')}</div>
      <div class="order-bottom"><div class="order-total">الإجمالي: ${money(order.total, order.currency)}<small class="payment-status-line">${escapeHtml(paymentStatusLabel(order.payment || {}))}</small></div><div class="order-actions"><button class="outline-button small" data-print-order="${escapeHtml(order.id)}">طباعة الفاتورة</button>${currentRole === 'admin' && order.payment?.method === 'shamcash' && !order.payment?.invoiceId ? `<button class="outline-button small" data-create-shamcash-invoice="${escapeHtml(order.id)}">إصدار فاتورة شام كاش</button>` : ''}${currentRole === 'admin' && order.payment?.method === 'shamcash' && order.payment?.invoiceId ? `<button class="outline-button small" data-verify-shamcash="${escapeHtml(order.id)}">تحقق من الدفع</button>` : ''}${currentRole === 'admin' ? `<button class="outline-button small" data-edit-order="${escapeHtml(order.id)}">تعديل الطلب</button>` : ''}<select data-order-status="${escapeHtml(order.id)}" aria-label="حالة الطلب">${Object.entries(statusNames).filter(([value]) => value !== 'completed' || order.status === value).map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}<option value="completed">مكتمل — نقل للأرشيف</option></select></div></div>
    </article>`).join('') : '<div class="empty-list">لا توجد طلبات نشطة في هذه القائمة حاليًا.</div>';
  $('#ordersList').innerHTML = html;
  $('#recentOrders').innerHTML = rows.slice(0, 4).map(order => `
    <article class="order-card"><div class="order-head"><div><div class="order-id">${escapeHtml(order.orderNumber || order.id)}</div><div class="order-time">${formatDate(order.createdAt)}</div></div><div class="order-phone">${escapeHtml(order.phone || '')}</div></div><div class="order-bottom"><div class="order-total">${money(order.total, order.currency)}</div><span class="status-pill">${escapeHtml(statusNames[order.status] || order.status)}</span></div></article>`).join('') || '<div class="empty-list">لم تصل طلبات بعد.</div>';
  renderStats();
}

async function loadArchive() {
  if (!canSee('archive')) return;
  try {
    const archiveQuery = sdk.query(sdk.collection(db, 'orderArchive'), sdk.orderBy('completedAt', 'desc'), sdk.limit(10));
    const snapshot = await sdk.getDocs(archiveQuery);
    archiveOrders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderArchive();
  } catch (error) {
    console.error(error);
    showToast('تعذر تحميل أرشيف الطلبات: ' + error.message, 5000);
  }
}

function restaurantDateKey(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: restaurantSettings.timeZone || 'Asia/Damascus', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function renderArchive() {
  const search = ($('#archiveSearch')?.value || '').trim().toLowerCase();
  const date = $('#archiveDate')?.value || '';
  const filtered = archiveOrders.filter(order => {
    const byNumber = !search || String(order.orderNumber || '').toLowerCase().includes(search);
    const byDate = !date || restaurantDateKey(order.completedAt) === date || restaurantDateKey(order.createdAt) === date;
    return byNumber && byDate;
  });
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  archivePage = Math.min(Math.max(1, archivePage), pageCount);
  const pageRows = filtered.slice((archivePage - 1) * pageSize, archivePage * pageSize);
  $('#archiveList').innerHTML = pageRows.length ? pageRows.map(order => `
    <article class="order-card"><div class="order-head"><div><div class="order-id">${escapeHtml(order.orderNumber || order.id)}</div><div class="order-time">اكتمل: ${formatDate(order.completedAt)} · أُنشئ: ${formatDate(order.createdAt)}</div></div><div class="order-phone">${escapeHtml(order.phone || '')}</div></div>
    <div class="order-items">${(order.items || []).map(item => `<div class="order-item-line"><span>${escapeHtml(item.name)} × ${Number(item.quantity || 0)}</span><b>${money(item.subtotal, item.currency)}</b></div>`).join('')}</div><div class="order-bottom"><span class="status-pill">مكتمل · ${escapeHtml(paymentStatusLabel(order.payment || {}))}</span><div class="order-actions"><div class="order-total">${money(order.total, order.currency)}</div><button class="outline-button small" data-print-archive="${escapeHtml(order.id)}">طباعة الفاتورة</button>${currentRole === 'admin' && order.payment?.method === 'shamcash' && order.payment?.invoiceId ? `<button class="outline-button small" data-verify-archive-payment="${escapeHtml(order.id)}">تحقق من الدفع</button>` : ''}</div></div></article>`).join('') : '<div class="empty-list">لا توجد طلبات مطابقة في الأرشيف.</div>';
  $('#archivePageLabel').textContent = `${archivePage} / ${pageCount}`;
  $('#archivePrev').disabled = archivePage <= 1;
  $('#archiveNext').disabled = archivePage >= pageCount;
  $('#archiveCount').textContent = `${filtered.length} طلب (الحد الأقصى المحفوظ: 10)`;
}

async function moveOrderToArchive(order) {
  const batch = sdk.writeBatch(db);
  const { id, ...data } = order;
  batch.set(sdk.doc(db, 'orderArchive', id), { ...data, status: 'completed', completedAt: sdk.serverTimestamp() });
  batch.delete(sdk.doc(db, 'orders', id));
  await batch.commit();
  if (currentRole === 'admin' || canSee('orders')) {
    const recent = await sdk.getDocs(sdk.query(sdk.collection(db, 'orderArchive'), sdk.orderBy('completedAt', 'desc'), sdk.limit(30)));
    if (recent.docs.length > 10) {
      const prune = sdk.writeBatch(db);
      recent.docs.slice(10).forEach(doc => prune.delete(doc.ref));
      await prune.commit();
    }
  }
  if (canSee('archive')) await loadArchive();
}

function listenOrders() {
  if (stopOrdersListener) stopOrdersListener();
  const ordersQuery = sdk.query(sdk.collection(db, 'orders'), sdk.orderBy('createdAt', 'desc'), sdk.limit(100));
  stopOrdersListener = sdk.onSnapshot(ordersQuery, snapshot => {
    const allRows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    orders = allRows.filter(order => order.status !== 'completed');
    renderOrders();
    if (currentRole === 'admin') {
      allRows.filter(order => order.status === 'completed' && !migratingCompletedOrders.has(order.id)).forEach(order => {
        migratingCompletedOrders.add(order.id);
        moveOrderToArchive(order).catch(error => { console.error('Legacy archive migration failed', error); showToast('تعذر نقل طلب قديم للأرشيف: ' + error.message, 5000); })
          .finally(() => migratingCompletedOrders.delete(order.id));
      });
    }
  }, error => {
    console.error(error);
    showToast('تعذر جلب الطلبات: ' + error.message, 5000);
  });
}

function fillSettings() {
  $('#settingName').value = restaurantSettings.name || 'TECHBUILDERS';
  $('#settingFooter').value = restaurantSettings.footerMessage || 'ننتظركم دائمًا. نتمنى لكم تجربة لذيذة.';
  $('#settingCurrency').value = restaurantSettings.currency || 'ل.س';
  $('#settingAddress').value = restaurantSettings.location?.address || '';
  $('#settingLat').value = restaurantSettings.location?.lat ?? '';
  $('#settingLng').value = restaurantSettings.location?.lng ?? '';
  $('#settingRadius').value = restaurantSettings.location?.radius || 100;
  $('#settingTimeZone').value = restaurantSettings.timeZone || 'Asia/Damascus';
  $('#settingLogoUrl').value = restaurantSettings.logoUrl || '';
  $('#settingShamcashEnabled').checked = restaurantSettings.paymentMethods?.shamcash?.enabled === true;
  $('#settingShamcashAccountId').value = restaurantSettings.paymentMethods?.shamcash?.accountId || '';
  const theme = restaurantSettings.theme || {};
  $('#themePrimary').value = theme.primary || '#087cf0';
  $('#themeAccent').value = theme.accent || '#42a1ff';
  $('#themeBackground').value = theme.background || '#080b10';
  $('#themeSurface').value = theme.surface || '#10151d';
  $('#themeSurface2').value = theme.surface2 || '#151c26';
  $('#themePaper').value = theme.paper || '#f3eee4';
  $('#themeInk').value = theme.ink || '#20252b';
  $('#themeText').value = theme.text || '#f5f7fa';
  $('#themeMuted').value = theme.muted || '#8993a2';
  $('#themeBorder').value = theme.border || '#364454';
  taxesDraft = Array.isArray(restaurantSettings.taxes) ? restaurantSettings.taxes.map(tax => ({ ...tax })) : [];
  renderTaxSettings();
}

function syncTaxDraftFromDom() {
  taxesDraft = taxesDraft.map((tax, index) => {
    const row = $('#taxSettingsRows').querySelector(`[data-tax-index="${index}"]`);
    if (!row) return tax;
    return {
      ...tax,
      name: row.querySelector('[data-tax-field="name"]')?.value || '',
      rate: Number(row.querySelector('[data-tax-field="rate"]')?.value || 0),
      appliesTo: ['dineIn', 'takeaway'].filter(key => row.querySelector(`[data-tax-applies="${key}"]`)?.checked),
      enabled: row.querySelector('[data-tax-enabled]')?.checked ?? true
    };
  });
}

function renderTaxSettings() {
  $('#taxSettingsRows').innerHTML = taxesDraft.map((tax, index) => `
    <div class="tax-setting-row" data-tax-index="${index}">
      <div class="tax-setting-top"><b>رسم إضافي ${index + 1}</b><button type="button" class="remove-tax-button" data-remove-tax="${index}">حذف</button></div>
      <div class="form-two"><label>اسم الرسم<input data-tax-field="name" data-index="${index}" maxlength="40" value="${escapeHtml(tax.name || '')}" required></label><label>النسبة %<input data-tax-field="rate" data-index="${index}" type="number" min="0" max="100" step="0.1" value="${Number(tax.rate || 0)}" required></label></div>
      <div class="tax-applies"><label><input type="checkbox" data-tax-applies="dineIn" data-index="${index}" ${(tax.appliesTo || []).includes('dineIn') ? 'checked' : ''}> محلي</label><label><input type="checkbox" data-tax-applies="takeaway" data-index="${index}" ${(tax.appliesTo || []).includes('takeaway') ? 'checked' : ''}> سفري</label><label><input type="checkbox" data-tax-enabled data-index="${index}" ${tax.enabled === false ? '' : 'checked'}> مفعّل</label></div>
    </div>`).join('') || '<div class="help-note">لا توجد رسوم إضافية. يمكنك إضافة رسم عند الحاجة.</div>';
}

async function saveSettings(event) {
  event.preventDefault();
  const latValue = $('#settingLat').value.trim();
  const lngValue = $('#settingLng').value.trim();
  const lat = latValue === '' ? null : Number(latValue);
  const lng = lngValue === '' ? null : Number(lngValue);
  const radius = Number($('#settingRadius').value || 100);
  try { new Intl.DateTimeFormat('en-US', { timeZone: $('#settingTimeZone').value }).format(new Date()); } catch { $('#settingsMessage').textContent = 'اختر منطقة زمنية صحيحة.'; return; }
  if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180))) {
    $('#settingsMessage').textContent = 'أدخل خط العرض وخط الطول معًا وبقيم صحيحة.'; return;
  }
  if (!Number.isFinite(radius) || radius < 25 || radius > 500) { $('#settingsMessage').textContent = 'نطاق الموقع يجب أن يكون بين 25 و500 متر.'; return; }
  const logoUrl = $('#settingLogoUrl').value.trim();
  if (logoUrl) { try { const url = new URL(logoUrl); if (url.protocol !== 'https:') throw new Error(); } catch { $('#settingsMessage').textContent = 'رابط الشعار يجب أن يكون HTTPS مباشرًا.'; return; } }
  const paymentMethods = {
    ...(restaurantSettings.paymentMethods || {}),
    shamcash: {
      ...(restaurantSettings.paymentMethods?.shamcash || {}),
      enabled: $('#settingShamcashEnabled').checked,
      accountId: $('#settingShamcashAccountId').value.trim()
    }
  };
  if (paymentMethods.shamcash.enabled && !paymentMethods.shamcash.accountId) {
    $('#settingsMessage').textContent = 'أدخل معرّف حساب الاستقبال قبل تفعيل شام كاش.'; return;
  }
  const theme = {
    primary: $('#themePrimary').value, accent: $('#themeAccent').value,
    background: $('#themeBackground').value, surface: $('#themeSurface').value,
    surface2: $('#themeSurface2').value,
    paper: $('#themePaper').value, paper2: '#e4dacb', ink: $('#themeInk').value,
    text: $('#themeText').value, muted: $('#themeMuted').value, border: $('#themeBorder').value
  };
  let taxes;
  try {
    taxes = taxesDraft.map((tax, index) => {
      const row = $('#taxSettingsRows').querySelector(`[data-tax-index="${index}"]`);
      const name = row?.querySelector('[data-tax-field="name"]')?.value.trim() || '';
      const rate = Number(row?.querySelector('[data-tax-field="rate"]')?.value || 0);
      const appliesTo = ['dineIn', 'takeaway'].filter(key => row?.querySelector(`[data-tax-applies="${key}"]`)?.checked);
      const enabled = row?.querySelector('[data-tax-enabled]')?.checked ?? true;
      if (!name || !Number.isFinite(rate) || rate < 0 || rate > 100 || !appliesTo.length) throw new Error('أكمل اسم ونسبة ونوع تطبيق كل رسم، أو احذفه.');
      return { id: tax.id || (crypto.randomUUID ? crypto.randomUUID() : `tax-${Date.now()}-${index}`), name, rate, appliesTo, enabled };
    });
  } catch (error) {
    $('#settingsMessage').textContent = error.message;
    return;
  }
  $('#settingsMessage').textContent = '';
  try {
    await sdk.setDoc(sdk.doc(db, 'settings', 'restaurant'), {
      name: $('#settingName').value.trim(), footerMessage: $('#settingFooter').value.trim(),
      currency: $('#settingCurrency').value.trim() || 'ل.س', logoUrl, theme, taxes, paymentMethods, timeZone: $('#settingTimeZone').value,
      location: { address: $('#settingAddress').value.trim(), lat, lng, radius },
      updatedAt: sdk.serverTimestamp()
    }, { merge: true });
    restaurantSettings = { ...restaurantSettings, name: $('#settingName').value.trim(), currency: $('#settingCurrency').value.trim(), logoUrl, theme, taxes, paymentMethods, timeZone: $('#settingTimeZone').value, location: { address: $('#settingAddress').value.trim(), lat, lng, radius } };
    applyAdminBranding();
    $('#settingsMessage').textContent = 'تم حفظ إعدادات المطعم.';
    showToast('تم حفظ الإعدادات بنجاح');
  } catch (error) {
    console.error(error); $('#settingsMessage').textContent = error.message || 'تعذر حفظ الإعدادات.';
  }
}

function captureRestaurantLocation() {
  if (!navigator.geolocation) return showToast('المتصفح لا يدعم تحديد الموقع.');
  const button = $('#captureLocation');
  button.disabled = true;
  button.textContent = 'جارٍ تحديد الموقع...';
  navigator.geolocation.getCurrentPosition(position => {
    $('#settingLat').value = position.coords.latitude.toFixed(7);
    $('#settingLng').value = position.coords.longitude.toFixed(7);
    button.disabled = false;
    button.textContent = '⌖ استخدام موقعي الحالي كنقطة المطعم';
    showToast('تم التقاط الإحداثيات. اضغط حفظ الإعدادات لتثبيتها.');
  }, error => {
    button.disabled = false;
    button.textContent = '⌖ استخدام موقعي الحالي كنقطة المطعم';
    showToast(error.message || 'تعذر تحديد موقع الجهاز.', 5000);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

function openEntityDialog(type, record = null) {
  if (type === 'category' && groups.length === 0) return showToast('أضف قسمًا رئيسيًا أولًا.');
  if (type === 'item' && categories.length === 0) return showToast('أضف تصنيفًا فرعيًا أولًا.');
  editing = { type, id: record?.id || null };
  $('#dialogError').textContent = '';
  const isEdit = Boolean(record);
  const labels = { group: ['MAIN MENU GROUP', 'قسم رئيسي'], category: ['SUBCATEGORY', 'تصنيف فرعي'], item: ['MENU ITEM', 'وجبة / صنف'] };
  $('#dialogKicker').textContent = labels[type][0];
  $('#dialogTitle').textContent = `${isEdit ? 'تعديل' : 'إضافة'} ${labels[type][1]}`;
  let fields = '';
  if (type === 'group') {
    fields = `
      <label>اسم القسم الرئيسي<input name="name" required maxlength="70" value="${escapeHtml(record?.name || '')}" placeholder="مثال: الوجبات الرئيسية"></label>
      <label>وصف مختصر (اختياري)<textarea name="description" maxlength="160">${escapeHtml(record?.description || '')}</textarea></label>
      <div class="form-two"><label>ترتيب الظهور<input name="sortOrder" type="number" value="${Number(record?.sortOrder || 0)}"></label><label class="check-row"><input name="active" type="checkbox" ${record?.active === false ? '' : 'checked'}> ظاهر في المنيو</label></div>`;
  } else if (type === 'category') {
    fields = `
      <label>القسم الرئيسي<select name="groupId" required>${groups.map(group => `<option value="${escapeHtml(group.id)}" ${record?.groupId === group.id ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select></label>
      <label>اسم التصنيف الفرعي<input name="name" required maxlength="70" value="${escapeHtml(record?.name || '')}" placeholder="مثال: البرغر"></label>
      <div class="form-two"><label>ترتيب الظهور<input name="sortOrder" type="number" value="${Number(record?.sortOrder || 0)}"></label><label class="check-row"><input name="active" type="checkbox" ${record?.active === false ? '' : 'checked'}> ظاهر في المنيو</label></div>`;
  } else {
    fields = `
      <label>التصنيف الفرعي<select name="categoryId" required>${categories.map(category => `<option value="${escapeHtml(category.id)}" ${record?.categoryId === category.id ? 'selected' : ''}>${escapeHtml(groupName(category.groupId))} — ${escapeHtml(category.name)}</option>`).join('')}</select></label>
      <label>اسم الوجبة<input name="name" required maxlength="90" value="${escapeHtml(record?.name || '')}" placeholder="اسم الوجبة"></label>
      <label>رابط صورة الوجبة (HTTPS)<input name="imageUrl" type="url" value="${escapeHtml(record?.imageUrl || '')}" placeholder="https://example.com/food.jpg"></label>
      <label>وصف الوجبة<textarea name="description" maxlength="350" placeholder="وصف مختصر يظهر في المنيو">${escapeHtml(record?.description || '')}</textarea></label>
      <label>المكونات<textarea name="ingredients" maxlength="600" placeholder="اكتب مكونات الوجبة">${escapeHtml(record?.ingredients || '')}</textarea></label>
      <div class="form-two"><label>السعر<input name="price" type="number" min="0" step="1" required value="${record?.price ?? ''}" placeholder="0"></label><label>العملة<input name="currency" maxlength="12" required value="${escapeHtml(record?.currency || restaurantSettings.currency || 'ل.س')}"></label></div>
      <div class="form-two"><label>ترتيب الظهور<input name="sortOrder" type="number" value="${Number(record?.sortOrder || 0)}"></label><label class="check-row"><input name="active" type="checkbox" ${record?.active === false ? '' : 'checked'}> متاح في المنيو</label></div>`;
  }
  $('#dialogFields').innerHTML = fields;
  $('#entityDialog').showModal();
}

async function saveEntity(event) {
  event.preventDefault();
  $('#dialogError').textContent = '';
  const formData = new FormData($('#entityForm'));
  const type = editing.type;
  const collectionName = type === 'group' ? 'menuGroups' : type === 'category' ? 'categories' : 'menuItems';
  const data = {
    name: String(formData.get('name') || '').trim(),
    sortOrder: Number(formData.get('sortOrder') || 0),
    active: $('#dialogFields input[name="active"]')?.checked ?? true,
    updatedAt: sdk.serverTimestamp()
  };
  if (type === 'group') {
    data.description = String(formData.get('description') || '').trim();
  } else if (type === 'category') {
    data.groupId = String(formData.get('groupId') || '');
  } else {
    data.categoryId = String(formData.get('categoryId') || '');
    data.imageUrl = String(formData.get('imageUrl') || '').trim();
    data.description = String(formData.get('description') || '').trim();
    data.ingredients = String(formData.get('ingredients') || '').trim();
    data.price = Number(formData.get('price'));
    data.currency = String(formData.get('currency') || 'ل.س').trim();
    if (!Number.isFinite(data.price) || data.price < 0) return $('#dialogError').textContent = 'أدخل سعرًا صحيحًا.';
    if (data.imageUrl) {
      try { const url = new URL(data.imageUrl); if (url.protocol !== 'https:') throw new Error(); }
      catch { return $('#dialogError').textContent = 'رابط الصورة يجب أن يبدأ بـ https://'; }
    }
  }
  if (!data.name) return $('#dialogError').textContent = 'اكتب الاسم أولًا.';
  if (type === 'category' && !groups.some(group => group.id === data.groupId)) return $('#dialogError').textContent = 'اختر قسمًا رئيسيًا صحيحًا.';
  if (type === 'item' && !categories.some(category => category.id === data.categoryId)) return $('#dialogError').textContent = 'اختر تصنيفًا فرعيًا صحيحًا.';
  const button = $('#saveEntity');
  button.disabled = true;
  button.textContent = 'جارٍ الحفظ...';
  try {
    if (editing.id) {
      await sdk.updateDoc(sdk.doc(db, collectionName, editing.id), data);
    } else {
      data.createdAt = sdk.serverTimestamp();
      await sdk.addDoc(sdk.collection(db, collectionName), data);
    }
    $('#entityDialog').close();
    await loadMenuCollections();
    renderEverything();
    showToast(editing.id ? 'تم تعديل البيانات.' : 'تمت الإضافة بنجاح.');
  } catch (error) {
    console.error(error);
    $('#dialogError').textContent = error.message || 'تعذر حفظ البيانات.';
  } finally {
    button.disabled = false;
    button.textContent = 'حفظ';
  }
}

async function loadMenuCollections() {
  const [groupSnap, categorySnap, itemSnap] = await Promise.all([
    sdk.getDocs(sdk.collection(db, 'menuGroups')),
    sdk.getDocs(sdk.collection(db, 'categories')),
    sdk.getDocs(sdk.collection(db, 'menuItems'))
  ]);
  groups = sortByOrder(groupSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  categories = sortByOrder(categorySnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  items = sortByOrder(itemSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
}

async function deleteEntity(type, id) {
  const collectionName = type === 'group' ? 'menuGroups' : type === 'category' ? 'categories' : 'menuItems';
  const record = (type === 'group' ? groups : type === 'category' ? categories : items).find(row => row.id === id);
  if (!record) return;
  if (type === 'group' && categories.some(category => category.groupId === id)) return showToast('لا يمكن حذف القسم قبل حذف تصنيفاته الفرعية أو نقلها.');
  if (type === 'category' && items.some(item => item.categoryId === id)) return showToast('لا يمكن حذف التصنيف قبل حذف وجباته أو نقلها.');
  const label = type === 'group' ? 'القسم' : type === 'category' ? 'التصنيف' : 'الوجبة';
  if (!confirm(`هل أنت متأكد من حذف ${label} «${record.name}»؟`)) return;
  try {
    await sdk.deleteDoc(sdk.doc(db, collectionName, id));
    await loadMenuCollections();
    renderEverything();
    showToast('تم الحذف.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'تعذر الحذف.', 5000);
  }
}

function switchPanel(name) {
  if (currentRole !== 'admin' && !canSee(name)) return showToast('ليس لديك صلاحية لعرض هذا القسم.');
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
  document.querySelectorAll('.side-nav button').forEach(button => button.classList.toggle('active', button.dataset.panel === name));
  const titles = { overview: 'نظرة عامة', groups: 'الأقسام الرئيسية', categories: 'التصنيفات الفرعية', items: 'الوجبات والأصناف', orders: 'الطلبات النشطة', archive: 'أرشيف الطلبات', staff: 'إدارة الموظفين', settings: 'إعدادات المطعم' };
  $('#panelTitle').textContent = titles[name] || 'لوحة الإدارة';
  $('#sidebar').classList.remove('open');
  if (name === 'archive') loadArchive();
}

function openOrderEditDialog(order) {
  if (currentRole !== 'admin') return showToast('تعديل تفاصيل الطلب متاح لصاحب المطعم فقط.');
  orderEditingDraft = JSON.parse(JSON.stringify({ ...order, items: order.items || [] }));
  const serviceLabel = order.serviceType === 'takeaway' ? 'سفري' : 'محلي';
  $('#orderEditTitle').textContent = `تعديل الطلب ${order.orderNumber || ''}`;
  $('#orderEditService').value = order.serviceType || 'dineIn';
  $('#orderEditRows').innerHTML = orderEditingDraft.items.map((line, index) => `
    <div class="order-edit-row" data-edit-index="${index}">
      <div><b>${escapeHtml(line.name)}</b><small>السعر الحالي: ${money(line.unitPrice, line.currency)}</small></div>
      <label>الكمية<input data-edit-quantity="${index}" type="number" min="1" max="20" value="${Number(line.quantity || 1)}"></label>
      <label>ملاحظة<input data-edit-note="${index}" maxlength="250" value="${escapeHtml(line.note || '')}"></label>
      <button type="button" class="remove-tax-button" data-remove-order-line="${index}">حذف</button>
    </div>`).join('');
  $('#orderEditAddItem').innerHTML = '<option value="">اختر صنفًا لإضافته</option>' + items.filter(item => item.active !== false).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} — ${money(item.price, item.currency)}</option>`).join('');
  $('#orderEditMessage').textContent = `${serviceLabel} · يمكن تعديل كميات الطلب وملاحظاته والأصناف.`;
  $('#orderEditDialog').showModal();
}

async function saveOrderEdits(event) {
  event.preventDefault();
  if (!orderEditingDraft || currentRole !== 'admin') return;
  const rows = [...$('#orderEditRows').querySelectorAll('[data-edit-index]')];
  const edited = rows.map(row => {
    const index = Number(row.dataset.editIndex);
    return { ...orderEditingDraft.items[index], quantity: Math.max(1, Math.min(20, Number(row.querySelector('[data-edit-quantity]')?.value || 1))), note: String(row.querySelector('[data-edit-note]')?.value || '').slice(0, 250) };
  });
  if (!edited.length) return $('#orderEditMessage').textContent = 'يجب أن يحتوي الطلب على صنف واحد على الأقل.';
  const currencies = [...new Set(edited.map(line => line.currency || restaurantSettings.currency || 'ل.س'))];
  if (currencies.length !== 1) return $('#orderEditMessage').textContent = 'لا يمكن دمج عملات مختلفة في طلب واحد.';
  edited.forEach(line => { line.subtotal = Number(line.unitPrice || 0) * line.quantity; });
  const subtotal = edited.reduce((sum, line) => sum + line.subtotal, 0);
  const serviceType = $('#orderEditService').value;
  const taxes = (Array.isArray(restaurantSettings.taxes) ? restaurantSettings.taxes : []).filter(tax => tax.enabled !== false && (tax.appliesTo || []).includes(serviceType === 'takeaway' ? 'takeaway' : 'dineIn')).map(tax => ({ id: tax.id, name: tax.name, rate: Number(tax.rate || 0), amount: Math.round(subtotal * Number(tax.rate || 0) / 100) }));
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amount, 0);
  const button = $('#saveOrderEdit'); button.disabled = true;
  try {
    await sdk.updateDoc(sdk.doc(db, 'orders', orderEditingDraft.id), { items: edited, serviceType, subtotal, taxes, taxTotal, total: subtotal + taxTotal, currency: currencies[0], updatedAt: sdk.serverTimestamp() });
    $('#orderEditDialog').close(); orderEditingDraft = null; showToast('تم حفظ تعديل الطلب.');
  } catch (error) { console.error(error); $('#orderEditMessage').textContent = error.message || 'تعذر حفظ التعديل.'; }
  finally { button.disabled = false; }
}

function renderStaff() {
  if (currentRole !== 'admin') return;
  $('#staffList').innerHTML = staffMembers.length ? staffMembers.map(member => `
    <article class="entity-card"><div class="entity-icon">♙</div><div class="entity-copy"><h4>${escapeHtml(member.email || member.uid)}</h4><p>الصلاحيات: ${escapeHtml((member.permissions || []).map(permission => ({ overview: 'نظرة عامة', orders: 'الطلبات', archive: 'الأرشيف' }[permission] || permission)).join('، '))}</p><div class="entity-meta">${member.active === false ? 'موقوف' : 'نشط'}</div></div><div class="entity-actions"><button type="button" class="icon-button delete" data-remove-staff="${escapeHtml(member.uid)}">إلغاء</button></div></article>`).join('') : '<div class="empty-list">لم تتم إضافة موظفين حتى الآن.</div>';
}
let staffMembers = [];
async function loadStaff() {
  if (currentRole !== 'admin') return;
  try {
    const snapshot = await sdk.getDocs(sdk.collection(db, 'staff'));
    staffMembers = snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
    renderStaff();
  } catch (error) { console.error(error); showToast('تعذر تحميل الموظفين: ' + error.message); }
}

async function createStaff(event) {
  event.preventDefault();
  if (currentRole !== 'admin') return;
  const email = $('#staffEmail').value.trim().toLowerCase();
  const password = $('#staffPassword').value;
  const permissions = [...document.querySelectorAll('[data-staff-permission]:checked')].map(input => input.value);
  if (!permissions.length) return $('#staffMessage').textContent = 'حدد صلاحية واحدة على الأقل.';
  const button = $('#createStaffButton'); button.disabled = true; button.textContent = 'جارٍ إنشاء الحساب...';
  $('#staffMessage').textContent = '';
  try {
    const account = await createEmployeeAuthAccount(email, password);
    await sdk.setDoc(sdk.doc(db, 'staff', account.uid), { uid: account.uid, email: account.email || email, role: 'employee', permissions, active: true, createdAt: sdk.serverTimestamp(), createdBy: currentAdmin.uid });
    $('#staffForm').reset();
    $('#staffMessage').textContent = 'تم إنشاء حساب الموظف. يمكنه تسجيل الدخول بالبريد وكلمة المرور المحددين.';
    showToast('تم إنشاء حساب الموظف.');
    await loadStaff();
  } catch (error) {
    console.error(error);
    const message = error.code === 'auth/email-already-in-use' ? 'هذا البريد مسجل مسبقًا في Firebase Authentication.' : (error.message || 'تعذر إنشاء الحساب.');
    $('#staffMessage').textContent = message;
  } finally { button.disabled = false; button.textContent = 'إنشاء حساب الموظف'; }
}

async function removeStaff(uid) {
  const member = staffMembers.find(row => row.uid === uid);
  if (!member || !confirm(`إلغاء صلاحيات الموظف ${member.email || uid}؟`)) return;
  try { await sdk.deleteDoc(sdk.doc(db, 'staff', uid)); showToast('تم إلغاء صلاحيات الموظف.'); await loadStaff(); }
  catch (error) { console.error(error); showToast(error.message || 'تعذر إلغاء الصلاحيات.', 5000); }
}

$('#loginForm').addEventListener('submit', login);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#captureLocation').addEventListener('click', captureRestaurantLocation);
$('#addTaxButton').addEventListener('click', () => {
  syncTaxDraftFromDom();
  taxesDraft.push({ id: crypto.randomUUID ? crypto.randomUUID() : `tax-${Date.now()}`, name: '', rate: 0, appliesTo: ['dineIn', 'takeaway'], enabled: true });
  renderTaxSettings();
});
$('#taxSettingsRows').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-tax]');
  if (!remove) return;
  syncTaxDraftFromDom();
  taxesDraft.splice(Number(remove.dataset.removeTax), 1);
  renderTaxSettings();
});
$('#addGroup').addEventListener('click', () => openEntityDialog('group'));
$('#addCategory').addEventListener('click', () => openEntityDialog('category'));
$('#addItem').addEventListener('click', () => openEntityDialog('item'));
$('#entityForm').addEventListener('submit', saveEntity);
$('#closeDialog').addEventListener('click', () => $('#entityDialog').close());
$('#cancelDialog').addEventListener('click', () => $('#entityDialog').close());
$('#itemSearch').addEventListener('input', renderItems);
$('#itemCategoryFilter').addEventListener('change', renderItems);
$('#orderFilter').addEventListener('change', renderOrders);
$('#refreshOrders').addEventListener('click', () => { if (stopOrdersListener) stopOrdersListener(); listenOrders(); showToast('تم تحديث قائمة الطلبات.'); });
$('#archiveSearch').addEventListener('input', () => { archivePage = 1; renderArchive(); });
$('#archiveDate').addEventListener('change', () => { archivePage = 1; renderArchive(); });
$('#refreshArchive').addEventListener('click', loadArchive);
$('#archivePrev').addEventListener('click', () => { archivePage--; renderArchive(); });
$('#archiveNext').addEventListener('click', () => { archivePage++; renderArchive(); });
$('#staffForm').addEventListener('submit', createStaff);
$('#staffAllPermissions').addEventListener('change', event => {
  document.querySelectorAll('[data-staff-permission]').forEach(input => { input.checked = event.target.checked; });
});
document.querySelectorAll('[data-staff-permission]').forEach(input => input.addEventListener('change', () => {
  $('#staffAllPermissions').checked = [...document.querySelectorAll('[data-staff-permission]')].every(item => item.checked);
}));
$('#staffList').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-staff]');
  if (remove) removeStaff(remove.dataset.removeStaff);
});
$('#orderEditForm').addEventListener('submit', saveOrderEdits);
$('#closeOrderEdit').addEventListener('click', () => $('#orderEditDialog').close());
$('#cancelOrderEdit').addEventListener('click', () => $('#orderEditDialog').close());
$('#orderEditRows').addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-order-line]');
  if (!remove || !orderEditingDraft) return;
  orderEditingDraft.items.splice(Number(remove.dataset.removeOrderLine), 1);
  openOrderEditDialog(orderEditingDraft);
});
$('#addOrderItemButton').addEventListener('click', () => {
  if (!orderEditingDraft) return;
  const itemId = $('#orderEditAddItem').value;
  const item = items.find(row => row.id === itemId);
  if (!item) return showToast('اختر صنفًا أولًا.');
  const currentCurrency = orderEditingDraft.currency || item.currency || restaurantSettings.currency || 'ل.س';
  if (currentCurrency !== (item.currency || restaurantSettings.currency || 'ل.س')) return showToast('لا يمكن إضافة صنف بعملة مختلفة عن الطلب.');
  orderEditingDraft.items.push({ id: item.id, name: item.name, quantity: 1, note: '', unitPrice: Number(item.price || 0), subtotal: Number(item.price || 0), currency: item.currency || restaurantSettings.currency || 'ل.س' });
  openOrderEditDialog(orderEditingDraft);
});
$('#sideNav').addEventListener('click', event => {
  const button = event.target.closest('[data-panel]');
  if (button) switchPanel(button.dataset.panel);
});
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => switchPanel(button.dataset.goto)));
$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#logoutButton').addEventListener('click', () => sdk.signOut(auth));
$('#groupsList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="group"]'); const remove = event.target.closest('[data-delete="group"]');
  if (edit) openEntityDialog('group', groups.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('group', remove.dataset.id);
});
$('#categoriesList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="category"]'); const remove = event.target.closest('[data-delete="category"]');
  if (edit) openEntityDialog('category', categories.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('category', remove.dataset.id);
});
$('#itemsList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="item"]'); const remove = event.target.closest('[data-delete="item"]');
  if (edit) openEntityDialog('item', items.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('item', remove.dataset.id);
});
$('#ordersList').addEventListener('click', event => {
  const print = event.target.closest('[data-print-order]');
  if (print) return printOrderInvoice(orders.find(row => row.id === print.dataset.printOrder));
  const createInvoice = event.target.closest('[data-create-shamcash-invoice]');
  if (createInvoice) return issueInvoiceForOrder(orders.find(row => row.id === createInvoice.dataset.createShamcashInvoice));
  const verifyPayment = event.target.closest('[data-verify-shamcash]');
  if (verifyPayment) return verifyShamcashPayment(orders.find(row => row.id === verifyPayment.dataset.verifyShamcash));
  const edit = event.target.closest('[data-edit-order]');
  if (edit) openOrderEditDialog(orders.find(row => row.id === edit.dataset.editOrder));
});
$('#archiveList').addEventListener('click', event => {
  const print = event.target.closest('[data-print-archive]');
  if (print) return printOrderInvoice(archiveOrders.find(row => row.id === print.dataset.printArchive));
  const verifyPayment = event.target.closest('[data-verify-archive-payment]');
  if (verifyPayment) return verifyShamcashPayment(archiveOrders.find(row => row.id === verifyPayment.dataset.verifyArchivePayment), true);
});
$('#ordersList').addEventListener('change', async event => {
  const select = event.target.closest('[data-order-status]');
  if (!select) return;
  const order = orders.find(row => row.id === select.dataset.orderStatus);
  if (!order) return;
  select.disabled = true;
  try {
    if (select.value === 'completed') {
      await moveOrderToArchive(order);
      showToast('تم نقل الطلب إلى الأرشيف.');
    } else {
      await sdk.updateDoc(sdk.doc(db, 'orders', order.id), { status: select.value, updatedAt: sdk.serverTimestamp() });
      showToast('تم تحديث حالة الطلب.');
    }
  } catch (error) {
    console.error(error); showToast(error.message || 'تعذر تحديث الطلب.', 5000);
    select.value = order.status;
  } finally { select.disabled = false; }
});

if (!isFirebaseConfigured) {
  showLogin('أدخل بيانات Firebase في public/js/firebase-config.js حتى تتمكن من تسجيل الدخول.');
} else {
  sdk.onAuthStateChanged(auth, authChanged);
}
