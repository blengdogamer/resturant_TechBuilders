import { auth, db, sdk, isFirebaseConfigured } from './firebase.js';

const $ = selector => document.querySelector(selector);
let currentAdmin = null;
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

async function checkAdmin(user) {
  if (!user?.email) throw new Error('هذا الحساب لا يحتوي على بريد إلكتروني.');
  const email = user.email.trim().toLowerCase();
  const [emailSnap, uidSnap] = await Promise.all([
    sdk.getDoc(sdk.doc(db, 'admins', email)),
    sdk.getDoc(sdk.doc(db, 'admins', user.uid))
  ]);
  const authorizedByEmail = emailSnap.exists() && emailSnap.data().role === 'admin';
  const authorizedByUid = uidSnap.exists() && uidSnap.data().role === 'admin';
  if (!authorizedByEmail && !authorizedByUid) {
    throw new Error(`الحساب ${email} غير مضاف كمسؤول. أضف وثيقة admins/${email} واجعل role = admin.`);
  }
  return email;
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
    if (stopOrdersListener) stopOrdersListener();
    showLogin();
    return;
  }
  if (!isFirebaseConfigured || !db) return showLogin('إعدادات Firebase غير مكتملة.');
  try {
    const email = await checkAdmin(user);
    currentAdmin = user;
    $('#adminEmailLabel').textContent = email;
    $('#loginScreen').hidden = true;
    $('#adminApp').hidden = false;
    await loadAdminData();
  } catch (error) {
    console.error(error);
    await sdk.signOut(auth).catch(() => {});
    showLogin(error.message || 'هذا الحساب ليس ضمن مسؤولي المطعم.');
  }
}

async function loadAdminData() {
  try {
    const [groupSnap, categorySnap, itemSnap, settingsSnap] = await Promise.all([
      sdk.getDocs(sdk.collection(db, 'menuGroups')),
      sdk.getDocs(sdk.collection(db, 'categories')),
      sdk.getDocs(sdk.collection(db, 'menuItems')),
      sdk.getDoc(sdk.doc(db, 'settings', 'restaurant'))
    ]);
    groups = sortByOrder(groupSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    categories = sortByOrder(categorySnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    items = sortByOrder(itemSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    restaurantSettings = settingsSnap.exists() ? settingsSnap.data() : {};
    fillSettings();
    renderEverything();
    listenOrders();
  } catch (error) {
    console.error(error);
    showToast('تعذر تحميل بيانات الإدارة: ' + (error.message || 'تحقق من قواعد Firestore'), 6000);
  }
}

function renderEverything() {
  renderGroups();
  renderCategories();
  populateCategoryFilter();
  renderItems();
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
      <div class="entity-actions"><button class="icon-button" data-edit="group" data-id="${escapeHtml(group.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="group" data-id="${escapeHtml(group.id)}" aria-label="حذف">×</button></div>
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
      <div class="entity-actions"><button class="icon-button" data-edit="category" data-id="${escapeHtml(category.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="category" data-id="${escapeHtml(category.id)}" aria-label="حذف">×</button></div>
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
      <div class="entity-actions"><button class="icon-button" data-edit="item" data-id="${escapeHtml(item.id)}" aria-label="تعديل">✎</button><button class="icon-button delete" data-delete="item" data-id="${escapeHtml(item.id)}" aria-label="حذف">×</button></div>
    </article>`).join('');
  $('#itemsList').querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true }));
}

function formatDate(value) {
  try {
    const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'وقت غير متاح';
    return new Intl.DateTimeFormat('ar-SY', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch { return 'وقت غير متاح'; }
}

function renderOrders() {
  const selectedStatus = $('#orderFilter').value || 'all';
  const rows = orders.filter(order => selectedStatus === 'all' || order.status === selectedStatus);
  const html = rows.length ? rows.map(order => `
    <article class="order-card">
      <div class="order-head"><div><div class="order-id">${escapeHtml(order.orderNumber || order.id)}</div><div class="order-time">${formatDate(order.createdAt)}</div></div><div class="order-phone">${escapeHtml(order.phone || '')}</div></div>
      <div class="order-items">${(order.items || []).map(item => `<div class="order-item-line"><span>${escapeHtml(item.name)} × ${Number(item.quantity || 0)}${item.note ? `<small class="order-item-note">ملاحظة: ${escapeHtml(item.note)}</small>` : ''}</span><b>${money(item.subtotal, item.currency)}</b></div>`).join('')}</div>
      <div class="order-bottom"><div class="order-total">الإجمالي: ${money(order.total, order.currency)}</div><select data-order-status="${escapeHtml(order.id)}" aria-label="حالة الطلب">${Object.entries(statusNames).map(([value, label]) => `<option value="${value}" ${order.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    </article>`).join('') : '<div class="empty-list">لا توجد طلبات في هذه القائمة حاليًا.</div>';
  $('#ordersList').innerHTML = html;
  $('#recentOrders').innerHTML = rows.slice(0, 4).map(order => `
    <article class="order-card"><div class="order-head"><div><div class="order-id">${escapeHtml(order.orderNumber || order.id)}</div><div class="order-time">${formatDate(order.createdAt)}</div></div><div class="order-phone">${escapeHtml(order.phone || '')}</div></div><div class="order-bottom"><div class="order-total">${money(order.total, order.currency)}</div><span class="status-pill">${escapeHtml(statusNames[order.status] || order.status)}</span></div></article>`).join('') || '<div class="empty-list">لم تصل طلبات بعد.</div>';
  renderStats();
}

function listenOrders() {
  if (stopOrdersListener) stopOrdersListener();
  const ordersQuery = sdk.query(sdk.collection(db, 'orders'), sdk.orderBy('createdAt', 'desc'), sdk.limit(100));
  stopOrdersListener = sdk.onSnapshot(ordersQuery, snapshot => {
    orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderOrders();
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
}

async function saveSettings(event) {
  event.preventDefault();
  const latValue = $('#settingLat').value.trim();
  const lngValue = $('#settingLng').value.trim();
  const lat = latValue === '' ? null : Number(latValue);
  const lng = lngValue === '' ? null : Number(lngValue);
  const radius = Number($('#settingRadius').value || 100);
  if ((lat === null) !== (lng === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180))) {
    $('#settingsMessage').textContent = 'أدخل خط العرض وخط الطول معًا وبقيم صحيحة.';
    return;
  }
  if (!Number.isFinite(radius) || radius < 25 || radius > 500) {
    $('#settingsMessage').textContent = 'نطاق الموقع يجب أن يكون بين 25 و500 متر.';
    return;
  }
  $('#settingsMessage').textContent = '';
  try {
    await sdk.setDoc(sdk.doc(db, 'settings', 'restaurant'), {
      name: $('#settingName').value.trim(),
      footerMessage: $('#settingFooter').value.trim(),
      currency: $('#settingCurrency').value.trim() || 'ل.س',
      location: {
        address: $('#settingAddress').value.trim(),
        lat, lng, radius
      },
      updatedAt: sdk.serverTimestamp()
    }, { merge: true });
    restaurantSettings = { ...restaurantSettings, name: $('#settingName').value.trim(), currency: $('#settingCurrency').value.trim(), location: { address: $('#settingAddress').value.trim(), lat, lng, radius } };
    $('#settingsMessage').textContent = 'تم حفظ إعدادات المطعم.';
    showToast('تم حفظ الإعدادات بنجاح');
  } catch (error) {
    console.error(error);
    $('#settingsMessage').textContent = error.message || 'تعذر حفظ الإعدادات.';
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
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
  document.querySelectorAll('.side-nav button').forEach(button => button.classList.toggle('active', button.dataset.panel === name));
  const titles = { overview: 'نظرة عامة', groups: 'الأقسام الرئيسية', categories: 'التصنيفات الفرعية', items: 'الوجبات والأصناف', orders: 'طلبات العملاء', settings: 'إعدادات المطعم' };
  $('#panelTitle').textContent = titles[name] || 'لوحة الإدارة';
  $('#sidebar').classList.remove('open');
}

$('#loginForm').addEventListener('submit', login);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#captureLocation').addEventListener('click', captureRestaurantLocation);
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
$('#sideNav').addEventListener('click', event => {
  const button = event.target.closest('[data-panel]');
  if (button) switchPanel(button.dataset.panel);
});
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => switchPanel(button.dataset.goto)));
$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#logoutButton').addEventListener('click', () => sdk.signOut(auth));
$('#groupsList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="group"]');
  const remove = event.target.closest('[data-delete="group"]');
  if (edit) openEntityDialog('group', groups.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('group', remove.dataset.id);
});
$('#categoriesList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="category"]');
  const remove = event.target.closest('[data-delete="category"]');
  if (edit) openEntityDialog('category', categories.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('category', remove.dataset.id);
});
$('#itemsList').addEventListener('click', event => {
  const edit = event.target.closest('[data-edit="item"]');
  const remove = event.target.closest('[data-delete="item"]');
  if (edit) openEntityDialog('item', items.find(row => row.id === edit.dataset.id));
  if (remove) deleteEntity('item', remove.dataset.id);
});
$('#ordersList').addEventListener('change', async event => {
  const select = event.target.closest('[data-order-status]');
  if (!select) return;
  select.disabled = true;
  try {
    await sdk.updateDoc(sdk.doc(db, 'orders', select.dataset.orderStatus), {
      status: select.value,
      updatedAt: sdk.serverTimestamp()
    });
    showToast('تم تحديث حالة الطلب.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'تعذر تحديث حالة الطلب.', 5000);
  } finally {
    select.disabled = false;
  }
});

if (!isFirebaseConfigured) {
  showLogin('أدخل بيانات Firebase في public/js/firebase-config.js حتى تتمكن من تسجيل الدخول.');
} else {
  sdk.onAuthStateChanged(auth, authChanged);
}
