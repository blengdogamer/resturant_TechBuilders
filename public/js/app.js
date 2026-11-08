import { guestAuth as auth, guestDb as db, sdk, isFirebaseConfigured } from './firebase.js';
import { firebaseConfig } from './firebase-config.js';
import { TELEGRAM_ENDPOINT } from './telegram-config.js';

const $ = selector => document.querySelector(selector);
const state = {
  groups: [], categories: [], items: [], settings: {},
  groupId: null, categoryId: null, page: 0, selectedItem: null,
  detailQty: 1, detailNote: '', cart: new Map(),
  verifiedLocation: null, locationVerifiedUntil: 0, serviceType: 'dineIn', paymentMethod: 'cash'
};
const PAGE_SIZE = 4;
const activeShamcashPolls = new Set();

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const sortByOrder = rows => rows.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
const formatMoney = (value, currency = 'ل.س') => `${Number(value || 0).toLocaleString('ar-SY')} ${escapeHtml(currency)}`;
const imageMarkup = (url, alt, className) => url
  ? `<img class="${className}" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`
  : `<div class="${className} image-placeholder" aria-label="${escapeHtml(alt)}">TB</div>`;
const activeGroup = () => state.groups.find(group => group.id === state.groupId);
const activeCategory = () => state.categories.find(category => category.id === state.categoryId);
const activeItems = () => sortByOrder(state.items.filter(item => item.categoryId === state.categoryId && item.active !== false));

function toast(message, duration = 3200) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), duration);
}

function showLoadError(message) {
  $('#bookContent').innerHTML = `<div class="empty-state"><strong>تعذّر تحميل المنيو</strong><p>${escapeHtml(message)}</p></div>`;
  $('#pageCounter').textContent = '— / —';
}

function applyBranding(settings = {}) {
  const theme = settings.theme || {};
  const root = document.documentElement;
  const cssMap = {
    '--blue': theme.primary,
    '--blue2': theme.accent,
    '--bg': theme.background,
    '--panel': theme.surface,
    '--panel2': theme.surface2,
    '--paper': theme.paper,
    '--paper2': theme.paper2,
    '--ink': theme.ink,
    '--surface-text': theme.text,
    '--muted': theme.muted
  };
  for (const [property, value] of Object.entries(cssMap)) {
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) root.style.setProperty(property, value);
  }
  if (typeof theme.border === 'string' && /^#[0-9a-f]{6}$/i.test(theme.border)) root.style.setProperty('--line', `${theme.border}80`);
  if (theme.background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.background);
  const rawLogo = String(settings.logoUrl || '').trim();
  const logo = rawLogo && (rawLogo.startsWith('https://') || rawLogo.startsWith('./') || rawLogo.startsWith('/')) ? rawLogo : './assets/techbuilders-logo.jpg';
  document.querySelectorAll('.brand img,.left-page-logo,.footer-brand img').forEach(image => { image.src = logo; });
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) favicon.href = logo;
}

function priceBreakdown(subtotal, serviceType = state.serviceType) {
  const appliesKey = serviceType === 'takeaway' ? 'takeaway' : 'dineIn';
  const taxes = (Array.isArray(state.settings.taxes) ? state.settings.taxes : [])
    .filter(tax => tax && tax.enabled !== false && Array.isArray(tax.appliesTo) && tax.appliesTo.includes(appliesKey))
    .map(tax => ({
      id: String(tax.id || ''),
      name: String(tax.name || 'رسوم'),
      rate: Math.max(0, Number(tax.rate) || 0),
      amount: Math.round(subtotal * Math.max(0, Number(tax.rate) || 0) / 100)
    }));
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amount, 0);
  return { subtotal, taxes, taxTotal, total: subtotal + taxTotal };
}

async function loadRestaurantData() {
  if (!isFirebaseConfigured || !db) {
    showLoadError('يجب وضع إعدادات Firebase في public/js/firebase-config.js ثم نشر الموقع. لا توجد بيانات تجريبية في هذه النسخة.');
    return;
  }
  try {
    const [groupSnap, categorySnap, itemSnap, settingsSnap] = await Promise.all([
      sdk.getDocs(sdk.query(sdk.collection(db, 'menuGroups'), sdk.where('active', '==', true))),
      sdk.getDocs(sdk.query(sdk.collection(db, 'categories'), sdk.where('active', '==', true))),
      sdk.getDocs(sdk.query(sdk.collection(db, 'menuItems'), sdk.where('active', '==', true))),
      sdk.getDoc(sdk.doc(db, 'settings', 'restaurant'))
    ]);
    state.groups = sortByOrder(groupSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    state.categories = sortByOrder(categorySnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    state.items = sortByOrder(itemSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    state.settings = settingsSnap.exists() ? settingsSnap.data() : {};
    $('#restaurantName').textContent = state.settings.name || 'TECHBUILDERS';
    applyBranding(state.settings);
    $('#footerMessage').textContent = state.settings.footerMessage || 'ننتظركم دائمًا. نتمنى لكم تجربة لذيذة.';
    if (!state.groupId || !state.groups.some(group => group.id === state.groupId)) state.groupId = state.groups[0]?.id || null;
    const groupCategories = state.categories.filter(category => category.groupId === state.groupId);
    if (!groupCategories.some(category => category.id === state.categoryId)) state.categoryId = groupCategories[0]?.id || null;
    $('#bookHeading').textContent = activeGroup()?.name || 'المنيو';
    renderMenu();
    $('#entryTitle').textContent = 'الطلب متاح من داخل المطعم فقط';
    $('#entryDescription').textContent = 'فعّل موقع هاتفك للتحقق من وجودك ضمن نطاق المطعم قبل إرسال الطلب.';
    $('#verifyEntry').hidden = false;
    $('#gateBoxTitle').textContent = 'تحقق من موقعك';
    $('#gateBoxText').textContent = state.settings.location?.lat != null && state.settings.location?.lng != null
      ? 'اضغط الزر واسمح للمتصفح بالوصول إلى موقعك.'
      : 'لم يحدد المسؤول موقع المطعم بعد.';

  } catch (error) {
    console.error(error);
    showLoadError(error.message || 'تحقق من اتصال Firebase وقواعد Firestore.');
  }
}

function renderMenu() {
  renderGroupTabs();
  renderCategoryTabs();
  $('#bookHeading').textContent = activeGroup()?.name || 'المنيو';
  if (!state.selectedItem) renderItemPage();
  $('#yearNow').textContent = new Date().getFullYear();
}

function renderGroupTabs() {
  const holder = $('#groupTabs');
  if (!state.groups.length) {
    holder.innerHTML = '<span class="section-label">لم تتم إضافة أقسام رئيسية بعد</span>';
    return;
  }
  holder.innerHTML = state.groups.map(group => `
    <button type="button" class="group-tab ${group.id === state.groupId ? 'active' : ''}" data-group="${escapeHtml(group.id)}">
      ${escapeHtml(group.name)}
    </button>`).join('');
}

function renderCategoryTabs() {
  const categories = state.categories.filter(category => category.groupId === state.groupId);
  if (!categories.length) {
    $('#categoryTabs').innerHTML = '<span class="section-label">لا توجد تصنيفات في هذا القسم حتى الآن</span>';
    return;
  }
  $('#categoryTabs').innerHTML = categories.map(category => `
    <button type="button" class="category-tab ${category.id === state.categoryId ? 'active' : ''}" data-category="${escapeHtml(category.id)}">
      ${escapeHtml(category.name)}
    </button>`).join('');
}

function renderItemPage() {
  const items = activeItems();
  const category = activeCategory();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages - 1);
  const start = state.page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  $('#pageSectionLabel').textContent = category?.name ? category.name.toUpperCase() : 'MENU';
  $('#pageCounter').textContent = `${String(state.page + 1).padStart(2, '0')} / ${String(totalPages).padStart(2, '0')}`;
  $('#prevPage').disabled = state.page <= 0;
  $('#nextPage').disabled = state.page >= totalPages - 1;

  if (!state.groups.length) {
    $('#bookContent').innerHTML = '<div class="empty-state"><strong>المنيو فارغ حاليًا</strong><p>عند إضافة الأقسام والوجبات من لوحة المسؤول ستظهر هنا مباشرة.</p></div>';
    return;
  }
  if (!category) {
    $('#bookContent').innerHTML = '<div class="empty-state"><strong>أضف تصنيفًا فرعيًا</strong><p>افتح لوحة المسؤول وأضف تصنيفًا تحت القسم الرئيسي المحدد.</p></div>';
    return;
  }
  if (!items.length) {
    $('#bookContent').innerHTML = '<div class="empty-state"><strong>لا توجد وجبات في هذا التصنيف</strong><p>يمكنك اختيار تصنيف آخر أو إضافة وجبات من لوحة المسؤول.</p></div>';
    return;
  }

  $('#bookContent').innerHTML = `<div class="menu-items-grid">${pageItems.map(item => `
    <article class="menu-item-card" role="button" tabindex="0" data-open-item="${escapeHtml(item.id)}" aria-label="عرض ${escapeHtml(item.name)}">
      ${imageMarkup(item.imageUrl, item.name, 'item-thumb')}
      <div class="item-card-copy">
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.description || item.ingredients || '')}</p>
        <div class="item-card-bottom"><span class="item-price">${formatMoney(item.price, item.currency)}</span><button type="button" class="add-mini" data-quick-add="${escapeHtml(item.id)}" aria-label="إضافة ${escapeHtml(item.name)} للسلة">+</button></div>
      </div>
    </article>`).join('')}</div>`;
  attachImageFallbacks();
}

function attachImageFallbacks() {
  document.querySelectorAll('.item-thumb,.detail-image,.cart-line img').forEach(image => {
    image.addEventListener('error', () => {
      const placeholder = document.createElement('div');
      placeholder.className = `${image.className} image-placeholder`;
      placeholder.textContent = 'TB';
      placeholder.setAttribute('aria-label', image.alt || 'صورة الوجبة غير متاحة');
      image.replaceWith(placeholder);
    }, { once: true });
  });
}

function flip(callback) {
  const frame = $('#bookFrame');
  frame.classList.remove('is-flipping');
  void frame.offsetWidth;
  frame.classList.add('is-flipping');
  setTimeout(() => {
    callback();
    frame.classList.remove('is-flipping');
  }, 240);
}

function openItem(itemId) {
  const item = state.items.find(entry => entry.id === itemId);
  if (!item) return;
  flip(() => {
    state.selectedItem = item;
    state.detailQty = 1;
    state.detailNote = '';
    renderDetailPage();
  });
}

function renderDetailPage() {
  const item = state.selectedItem;
  if (!item) return renderItemPage();
  $('#pageSectionLabel').textContent = 'DETAILS / ' + (activeCategory()?.name || 'MENU').toUpperCase();
  $('#pageCounter').textContent = '✦';
  $('#prevPage').disabled = true;
  $('#nextPage').disabled = true;
  $('#bookContent').innerHTML = `
    <div class="detail-page">
      ${imageMarkup(item.imageUrl, item.name, 'detail-image')}
      <div class="detail-copy">
        <button type="button" class="back-to-menu" id="backToMenu">← العودة إلى المنيو</button>
        <h2>${escapeHtml(item.name)}</h2>
        <div class="detail-price">${formatMoney(item.price, item.currency)}</div>
        <p class="detail-description">${escapeHtml(item.description || '')}</p>
        <div class="ingredients-title">المكونات</div>
        <p class="ingredients">${escapeHtml(item.ingredients || 'لم تتم إضافة تفاصيل المكونات.')}</p>
        <div class="detail-actions">
          <div class="qty-control"><button type="button" id="detailMinus" aria-label="إنقاص الكمية">−</button><strong id="detailQty">${state.detailQty}</strong><button type="button" id="detailPlus" aria-label="زيادة الكمية">+</button></div>
          <button type="button" class="detail-add" id="detailAdd">إضافة إلى السلة</button>
        </div>
        <textarea class="detail-note" id="detailNote" maxlength="250" placeholder="ملاحظة خاصة بهذه الوجبة (اختياري)..."></textarea>
      </div>
    </div>`;
  attachImageFallbacks();
  $('#backToMenu').addEventListener('click', () => flip(() => { state.selectedItem = null; renderItemPage(); }));
  $('#detailMinus').addEventListener('click', () => { state.detailQty = Math.max(1, state.detailQty - 1); $('#detailQty').textContent = state.detailQty; });
  $('#detailPlus').addEventListener('click', () => { state.detailQty = Math.min(20, state.detailQty + 1); $('#detailQty').textContent = state.detailQty; });
  $('#detailNote').addEventListener('input', event => { state.detailNote = event.target.value; });
  $('#detailAdd').addEventListener('click', () => {
    addToCart(item, state.detailQty, state.detailNote);
    toast('تمت إضافة الوجبة إلى السلة');
    flip(() => { state.selectedItem = null; renderItemPage(); });
  });
}

function addToCart(item, quantity = 1, note = '') {
  const currentCurrencies = new Set([...state.cart.values()].map(line => line.item.currency || 'ل.س'));
  const itemCurrency = item.currency || 'ل.س';
  if (currentCurrencies.size && !currentCurrencies.has(itemCurrency)) {
    toast('لا يمكن جمع عملات مختلفة في سلة واحدة.');
    return;
  }
  const existing = state.cart.get(item.id);
  if (existing) {
    existing.quantity = Math.min(20, existing.quantity + quantity);
    if (note.trim()) existing.note = note.trim();
  } else {
    state.cart.set(item.id, { item, quantity: Math.min(20, quantity), note: note.trim() });
  }
  renderCart();
}

function updateCartQuantity(id, change) {
  const line = state.cart.get(id);
  if (!line) return;
  line.quantity += change;
  if (line.quantity <= 0) state.cart.delete(id);
  else line.quantity = Math.min(20, line.quantity);
  renderCart();
}

function shamcashEnabled() {
  const config = state.settings.paymentMethods?.shamcash || {};
  return config.enabled === true && String(config.accountId || '').trim().length > 0;
}

function openShamcashPaymentDialog(orderNumber, amount, currency, invoice) {
  $('#shamcashOrderNumber').textContent = orderNumber;
  $('#shamcashAmount').textContent = formatMoney(amount, currency);
  $('#shamcashPaymentNote').textContent = invoice.paymentNote || orderNumber;
  $('#shamcashPayLink').href = invoice.paymentUrl;
  $('#shamcashExpiresAt').textContent = invoice.expiresAt
    ? `تنتهي صلاحية الفاتورة: ${new Date(invoice.expiresAt).toLocaleString('ar-SY')}`
    : 'أكمل الدفع قبل انتهاء صلاحية الفاتورة.';
  const dialog = $('#shamcashPaymentDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else window.location.href = invoice.paymentUrl;
}

async function createShamcashInvoice(orderId, orderNumber, amount, currency) {
  const user = auth.currentUser;
  if (!user) throw new Error('انتهت جلسة العميل. أعد التحقق من موقعك وحاول مجددًا.');
  const token = await user.getIdToken();
  const response = await fetch('/api/shamcash/create-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ orderId, orderNumber, amount, currency, projectId: firebaseConfig.projectId })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(result.error || 'تعذر إنشاء فاتورة شام كاش.');
  return result.invoice;
}

function renderCart() {
  const lines = [...state.cart.values()];
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotal = lines.reduce((sum, line) => sum + Number(line.item.price || 0) * line.quantity, 0);
  const breakdown = priceBreakdown(subtotal);
  const currencies = [...new Set(lines.map(line => line.item.currency || 'ل.س'))];
  const currency = currencies.length === 1 ? currencies[0] : '';
  const shamcashAvailable = shamcashEnabled() && (currency === 'ل.س' || currency === 'SYP');
  const shamcashButton = $('[data-payment-method=\"shamcash\"]');
  if (shamcashButton) shamcashButton.hidden = !shamcashAvailable;
  $('#shamcashPaymentHint').hidden = !shamcashAvailable;
  if (!shamcashAvailable && state.paymentMethod === 'shamcash') state.paymentMethod = 'cash';
  document.querySelectorAll('[data-payment-method]').forEach(button => {
    button.classList.toggle('active', button.dataset.paymentMethod === state.paymentMethod);
    button.setAttribute('aria-pressed', String(button.dataset.paymentMethod === state.paymentMethod));
  });
  $('#cartCount').textContent = count;
  $('#cartSubtotal').textContent = formatMoney(subtotal, currency);
  $('#cartTotal').textContent = formatMoney(breakdown.total, currency);
  $('#cartTaxLines').innerHTML = breakdown.taxes.map(tax => `
    <div class="tax-row"><span>${escapeHtml(tax.name)} (${tax.rate}%)</span><strong>${formatMoney(tax.amount, currency)}</strong></div>`).join('');
  $('#sendOrder').disabled = count === 0;
  document.querySelectorAll('[data-service-type]').forEach(button => {
    button.classList.toggle('active', button.dataset.serviceType === state.serviceType);
    button.setAttribute('aria-pressed', String(button.dataset.serviceType === state.serviceType));
  });
  if (!count) {
    $('#cartLines').innerHTML = '<div class="cart-empty"><span>▤</span><b>السلة فارغة</b><p>أضف وجباتك المفضلة من المنيو.</p></div>';
    return;
  }
  $('#cartLines').innerHTML = [...state.cart.entries()].map(([id, line]) => `
    <article class="cart-line" data-cart-line="${escapeHtml(id)}">
      ${imageMarkup(line.item.imageUrl, line.item.name, 'cart-line-image')}
      <div class="cart-line-info"><h4>${escapeHtml(line.item.name)}</h4><span class="cart-line-price">${formatMoney(Number(line.item.price || 0) * line.quantity, line.item.currency)}</span>
        <div class="cart-line-controls"><div class="qty-control"><button type="button" data-cart-minus="${escapeHtml(id)}" aria-label="إنقاص">−</button><strong>${line.quantity}</strong><button type="button" data-cart-plus="${escapeHtml(id)}" aria-label="زيادة">+</button></div><button type="button" class="remove-line" data-cart-remove="${escapeHtml(id)}">حذف</button></div>
      </div>
      <textarea class="cart-line-note" data-cart-note="${escapeHtml(id)}" maxlength="250" placeholder="ملاحظة لهذه الوجبة...">${escapeHtml(line.note)}</textarea>
    </article>`).join('');
  attachImageFallbacks();
}
function openCart() {
  $('#cartBackdrop').hidden = false;
  requestAnimationFrame(() => $('#cartBackdrop').classList.add('visible'));
  $('#cartDrawer').classList.add('open');
  $('#cartDrawer').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeCart() {
  $('#cartBackdrop').classList.remove('visible');
  $('#cartDrawer').classList.remove('open');
  $('#cartDrawer').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  setTimeout(() => { $('#cartBackdrop').hidden = true; }, 240);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = value => value * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function setLocationVerified(locationData) {
  state.verifiedLocation = locationData;
  state.locationVerifiedUntil = Date.now() + 10 * 60 * 1000;
  $('#entryState').textContent = 'داخل المطعم';
  $('#entryState').classList.add('ok');
  $('#entryTitle').textContent = 'تم التحقق من موقعك';
  $('#entryDescription').textContent = 'يمكنك إرسال طلبك الآن. التحقق صالح لمدة 10 دقائق.';
  $('#gateBox').classList.add('verified');
  $('#gateBoxTitle').textContent = 'موقعك ضمن نطاق المطعم';
  $('#gateBoxText').textContent = `تم التحقق على بُعد نحو ${Math.round(locationData.distanceMeters)} متر.`;
  $('#verifyEntry').textContent = 'تحديث التحقق';
}

async function verifyEntry() {
  if (!isFirebaseConfigured || !auth || !db) {
    toast('الموقع غير مربوط بـ Firebase بعد.');
    return;
  }
  const restaurantLocation = state.settings.location || {};
  const restaurantLat = Number(restaurantLocation.lat);
  const restaurantLng = Number(restaurantLocation.lng);
  const radius = Math.max(25, Math.min(500, Number(restaurantLocation.radius) || 100));
  if (!Number.isFinite(restaurantLat) || !Number.isFinite(restaurantLng)) {
    toast('لم يحدد المسؤول موقع المطعم بعد. تواصل مع الإدارة.');
    return;
  }
  if (!navigator.geolocation) {
    toast('متصفحك لا يدعم تحديد الموقع. افتح الموقع من متصفح حديث.');
    return;
  }
  const button = $('#verifyEntry');
  button.disabled = true;
  button.textContent = 'جارٍ تحديد موقعك...';
  try {
    if (!auth.currentUser) await sdk.signInAnonymously(auth);
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 22000, maximumAge: 0
    }));
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;
    const accuracy = Number(position.coords.accuracy || 0);
    const distanceMeters = haversineMeters(restaurantLat, restaurantLng, latitude, longitude);
    if (accuracy > 250) {
      throw new Error('دقة تحديد الموقع ضعيفة. فعّل GPS وحاول من مكان مفتوح داخل المطعم.');
    }
    if (distanceMeters > radius) {
      state.verifiedLocation = null;
      state.locationVerifiedUntil = 0;
      $('#entryState').textContent = 'خارج النطاق';
      $('#entryState').classList.remove('ok');
      $('#entryTitle').textContent = 'يبدو أنك خارج المطعم';
      $('#entryDescription').textContent = `المسافة الحالية نحو ${Math.round(distanceMeters)} متر، والمسموح ${radius} متر.`;
      $('#gateBox').classList.remove('verified');
      $('#gateBoxTitle').textContent = 'أنت خارج نطاق المطعم';
      $('#gateBoxText').textContent = 'يمكنك تصفّح المنيو، لكن إرسال الطلب متاح من داخل المطعم فقط.';
      throw new Error(`أنت خارج نطاق المطعم حاليًا (حوالي ${Math.round(distanceMeters)} متر).`);
    }
    setLocationVerified({ latitude, longitude, accuracy, distanceMeters, checkedAt: new Date().toISOString() });
    toast('تم التحقق من موقعك. يمكنك إرسال الطلب الآن.');
  } catch (error) {
    console.error(error);
    let message = error.message || 'تعذر التحقق من الموقع.';
    if (error.code === 1) message = 'يجب السماح للمتصفح بالوصول إلى موقعك لتتمكن من الطلب.';
    if (error.code === 2) message = 'تعذر تحديد موقعك. فعّل GPS وحاول مرة أخرى.';
    if (error.code === 3) message = 'انتهت مهلة تحديد الموقع. حاول مرة أخرى.';
    toast(message, 5200);
  } finally {
    button.disabled = false;
    button.textContent = 'تحقق من موقعي';
  }
}

async function notifyPaidShamcashOrder(orderNumber, phone, lines, breakdown, currency, location) {
  try {
    const response = await fetch(TELEGRAM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderNumber, restaurantName: state.settings.name || 'TechBuilders', phone,
        items: lines, subtotal: breakdown.subtotal, taxes: breakdown.taxes,
        taxTotal: breakdown.taxTotal, total: breakdown.total,
        serviceType: state.serviceType, paymentMethod: 'shamcash', currency, location
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) console.error('Paid ShamCash order Telegram notification failed:', result.error);
  } catch (error) {
    console.error('Paid ShamCash order Telegram notification failed:', error);
  }
}

async function monitorShamcashPayment(orderRef, orderId, orderNumber, invoice, orderData) {
  if (activeShamcashPolls.has(orderId)) return;
  activeShamcashPolls.add(orderId);
  const statusNode = $('#shamcashExpiresAt');
  const startedAt = Date.now();
  const check = async () => {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('انتهت جلسة التحقق من الدفع.');
      const token = await user.getIdToken();
      const response = await fetch('/api/shamcash/invoice-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderId, orderNumber, invoiceId: invoice.invoiceId, projectId: firebaseConfig.projectId })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || 'تعذر التحقق من حالة الدفع.');
      const payment = result.payment || {};
      if (payment.status === 'paid') {
        await sdk.updateDoc(orderRef, { payment: { method: 'shamcash', ...payment, invoiceId: invoice.invoiceId, paymentUrl: invoice.paymentUrl, paymentNote: invoice.paymentNote || orderNumber, paidAt: payment.paidAt || sdk.serverTimestamp() } });
        if (statusNode) statusNode.textContent = 'تم تأكيد الدفع بنجاح. وصل طلبك إلى المطعم.';
        await notifyPaidShamcashOrder(orderNumber, orderData.phone, orderData.items, {
          subtotal: orderData.subtotal, taxes: orderData.taxes, taxTotal: orderData.taxTotal, total: orderData.total
        }, orderData.currency, orderData.location);
        activeShamcashPolls.delete(orderId);
        toast(`تم تأكيد الدفع بنجاح، وصل طلبك ${orderNumber} إلى المطعم.`, 8000);
        return;
      }
      if (payment.status === 'expired' || payment.status === 'cancelled') {
        await sdk.deleteDoc(orderRef);
        if (statusNode) statusNode.textContent = payment.status === 'expired' ? 'انتهت الفاتورة ولم يتم تسجيل الطلب.' : 'تم إلغاء الفاتورة ولم يتم تسجيل الطلب.';
        activeShamcashPolls.delete(orderId);
        return;
      }
      if (statusNode) statusNode.textContent = 'بانتظار تأكيد شام كاش للدفع… يتم التحقق تلقائيًا.';
    } catch (error) {
      console.warn('ShamCash payment status check:', error);
      if (statusNode) statusNode.textContent = 'بانتظار تأكيد الدفع. سيستمر التحقق تلقائيًا.';
    }
    if (Date.now() - startedAt < 30 * 60 * 1000) setTimeout(check, 5000);
    else {
      if (statusNode) statusNode.textContent = 'توقف التحقق التلقائي. تواصل مع المطعم للتأكد من حالة الدفع.';
      activeShamcashPolls.delete(orderId);
    }
  };
  setTimeout(check, 2500);
}

function normalizePhoneDigits(value) {
  return String(value || '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\D/g, '');
}

function localDayKey(date = new Date()) {
  const timeZone = state.settings.timeZone || 'Asia/Damascus';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function displayOrderNumber(dayKey, sequence) {
  const [, month, day] = dayKey.split('-');
  const year = dayKey.slice(2, 4);
  return `${year}-${month}-${day}-${sequence}`;
}

async function submitOrder() {
  if (!state.cart.size) return toast('السلة فارغة. أضف وجبة أولًا.');
  if (!state.verifiedLocation || state.locationVerifiedUntil < Date.now()) {
    state.verifiedLocation = null;
    $('#gateBox').classList.remove('verified');
    $('#gateBoxTitle').textContent = 'تحقق من موقعك أولًا';
    $('#gateBoxText').textContent = 'اضغط «تحقق من موقعي» واسمح باستخدام GPS قبل إرسال الطلب.';
    toast('يجب التحقق من وجودك داخل المطعم قبل إرسال الطلب.', 4500);
    return;
  }
  const phone = $('#customerPhone').value.trim();
  const digits = normalizePhoneDigits(phone);
  if (digits.length < 7 || digits.length > 15) {
    $('#customerPhone').focus();
    return toast('أدخل رقم هاتف صحيحًا للتواصل معك.');
  }
  const lines = [...state.cart.entries()].map(([id, line]) => ({
    id,
    name: String(line.item.name || ''),
    quantity: Math.max(1, Math.min(20, Number(line.quantity) || 1)),
    note: String(line.note || '').slice(0, 250),
    unitPrice: Number(line.item.price || 0),
    subtotal: Number(line.item.price || 0) * Number(line.quantity || 1),
    currency: String(line.item.currency || state.settings.currency || 'ل.س')
  }));
  const currencies = [...new Set(lines.map(line => line.currency))];
  if (currencies.length !== 1) return toast('لا يمكن إرسال سلة تحتوي على أكثر من عملة.');
  const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const breakdown = priceBreakdown(subtotal);
  const dayKey = localDayKey();
  const button = $('#sendOrder');
  button.disabled = true;
  button.textContent = 'جارٍ إرسال الطلب...';
  try {
    if (!auth.currentUser) await sdk.signInAnonymously(auth);
    const orderRef = sdk.doc(sdk.collection(db, 'orders'));
    const counterRef = sdk.doc(db, 'dailyCounters', dayKey);
    const orderBase = {
      phone,
      items: lines,
      subtotal: breakdown.subtotal,
      taxes: breakdown.taxes,
      taxTotal: breakdown.taxTotal,
      total: breakdown.total,
      currency: currencies[0],
      serviceType: state.serviceType,
      paymentMethod: state.paymentMethod,
      payment: { method: state.paymentMethod, status: state.paymentMethod === 'shamcash' ? 'pending_invoice' : 'unpaid' },
      status: 'pending',
      customerUid: auth.currentUser.uid,
      counterDate: dayKey,
      location: {
        latitude: state.verifiedLocation.latitude,
        longitude: state.verifiedLocation.longitude,
        accuracy: state.verifiedLocation.accuracy,
        distanceMeters: Math.round(state.verifiedLocation.distanceMeters),
        checkedAt: state.verifiedLocation.checkedAt
      },
      createdAt: sdk.serverTimestamp()
    };
    const orderNumber = await sdk.runTransaction(db, async transaction => {
      const counterSnapshot = await transaction.get(counterRef);
      const sequence = (counterSnapshot.exists() ? Number(counterSnapshot.data().count || 0) : 0) + 1;
      const number = displayOrderNumber(dayKey, sequence);
      transaction.set(counterRef, { date: dayKey, count: sequence, lastOrderId: orderRef.id, updatedAt: sdk.serverTimestamp() });
      transaction.set(orderRef, { ...orderBase, orderNumber: number, counterValue: sequence });
      return number;
    });

    let shamcashInvoice = null;
    let shamcashInvoiceError = '';
    if (state.paymentMethod === 'shamcash') {
      try {
        shamcashInvoice = await createShamcashInvoice(orderRef.id, orderNumber, breakdown.total, currencies[0]);
        await sdk.updateDoc(orderRef, {
          payment: {
            method: 'shamcash', status: 'awaiting_payment', invoiceId: shamcashInvoice.invoiceId,
            paymentUrl: shamcashInvoice.paymentUrl, paymentNote: shamcashInvoice.paymentNote || orderNumber,
            expiresAt: shamcashInvoice.expiresAt || null, createdAt: sdk.serverTimestamp()
          }
        });
      } catch (error) {
        console.error('ShamCash invoice creation failed:', error);
        shamcashInvoiceError = error.message || 'تعذر إنشاء فاتورة شام كاش.';
        await sdk.deleteDoc(orderRef).catch(deleteError => console.error('Could not remove unpaid checkout draft:', deleteError));
      }
    }

    let telegramSent = false;
    let telegramError = '';
    if (state.paymentMethod !== 'shamcash') {
      try {
        const response = await fetch(TELEGRAM_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderNumber, restaurantName: state.settings.name || 'TechBuilders', phone,
            items: lines, subtotal: breakdown.subtotal, taxes: breakdown.taxes,
            taxTotal: breakdown.taxTotal, total: breakdown.total,
            serviceType: state.serviceType, paymentMethod: state.paymentMethod,
            currency: currencies[0], location: orderBase.location
          })
        });
        const result = await response.json().catch(() => ({}));
        telegramSent = response.ok && result.ok === true;
        if (!telegramSent) telegramError = result.error || 'تعذر إرسال إشعار Telegram.';
      } catch (error) {
        telegramError = error.message || 'تعذر الاتصال بخدمة إشعارات Telegram.';
      }
    }

    state.cart.clear();
    state.verifiedLocation = null;
    state.locationVerifiedUntil = 0;
    renderCart();
    closeCart();
    $('#entryState').textContent = 'غير مفعّل';
    $('#entryState').classList.remove('ok');
    $('#entryTitle').textContent = 'الطلب متاح من داخل المطعم فقط';
    $('#entryDescription').textContent = 'للقيام بطلب جديد، تحقق من موقعك مرة أخرى.';
    $('#gateBox').classList.remove('verified');
    $('#gateBoxTitle').textContent = 'تحقق من موقعك';
    $('#gateBoxText').textContent = 'يجب أن تكون داخل نطاق المطعم لإرسال الطلب.';
    $('#verifyEntry').textContent = 'تحقق من موقعي';
    if (shamcashInvoice) {
      openShamcashPaymentDialog(orderNumber, breakdown.total, currencies[0], shamcashInvoice);
      monitorShamcashPayment(orderRef, orderRef.id, orderNumber, shamcashInvoice, {
        phone, items: lines, subtotal: breakdown.subtotal, taxes: breakdown.taxes,
        taxTotal: breakdown.taxTotal, total: breakdown.total, currency: currencies[0], location: orderBase.location
      });
    } else if (shamcashInvoiceError) {
      toast(`لم يتم تأكيد طلبك لأن فاتورة شام كاش لم تُنشأ: ${shamcashInvoiceError}`, 9000);
    } else {
      toast(telegramSent
        ? `تم تسجيل طلبك ${orderNumber} وإرسال إشعار المطعم بنجاح.`
        : `تم تسجيل الطلب ${orderNumber}، لكن إشعار Telegram لم يصل. ${telegramError}`, 7000);
    }
  } catch (error) {
    console.error(error);
    const message = error.code === 'permission-denied'
      ? 'رفض Firestore الطلب أو تسلسل الرقم. تأكد من نشر قواعد v4 الموجودة في firestore.rules.'
      : error.message || 'تعذر تسجيل الطلب. حاول مجددًا.';
    toast(message, 6500);
  } finally {
    button.textContent = 'إرسال الطلب ←';
    button.disabled = state.cart.size === 0;
  }
}

$('#groupTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-group]');
  if (!button || button.dataset.group === state.groupId) return;
  flip(() => {
    state.groupId = button.dataset.group;
    const categories = state.categories.filter(category => category.groupId === state.groupId);
    state.categoryId = categories[0]?.id || null;
    state.page = 0;
    state.selectedItem = null;
    renderMenu();
  });
});

$('#categoryTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button || button.dataset.category === state.categoryId) return;
  flip(() => {
    state.categoryId = button.dataset.category;
    state.page = 0;
    state.selectedItem = null;
    renderMenu();
  });
});

$('#bookContent').addEventListener('click', event => {
  const quick = event.target.closest('[data-quick-add]');
  if (quick) {
    event.stopPropagation();
    const item = state.items.find(entry => entry.id === quick.dataset.quickAdd);
    if (item) { addToCart(item, 1, ''); toast('تمت الإضافة إلى السلة'); }
    return;
  }
  const card = event.target.closest('[data-open-item]');
  if (card) openItem(card.dataset.openItem);
});
$('#bookContent').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-item]')) {
    event.preventDefault(); openItem(event.target.dataset.openItem);
  }
});

$('#prevPage').addEventListener('click', () => {
  if (state.page <= 0 || state.selectedItem) return;
  flip(() => { state.page--; renderItemPage(); });
});
$('#nextPage').addEventListener('click', () => {
  const pages = Math.ceil(activeItems().length / PAGE_SIZE);
  if (state.selectedItem || state.page >= pages - 1) return;
  flip(() => { state.page++; renderItemPage(); });
});

let touchStartX = 0;
$('#bookFrame').addEventListener('touchstart', event => { touchStartX = event.changedTouches[0].clientX; }, { passive: true });
$('#bookFrame').addEventListener('touchend', event => {
  const delta = event.changedTouches[0].clientX - touchStartX;
  if (Math.abs(delta) < 55 || state.selectedItem) return;
  if (delta > 0) $('#prevPage').click(); else $('#nextPage').click();
}, { passive: true });

$('#openCart').addEventListener('click', openCart);
document.querySelectorAll('[data-service-type]').forEach(button => button.addEventListener('click', () => { state.serviceType = button.dataset.serviceType; renderCart(); }));
document.querySelectorAll('[data-payment-method]').forEach(button => button.addEventListener('click', () => { state.paymentMethod = button.dataset.paymentMethod; renderCart(); }));
$('#closeShamcashDialog').addEventListener('click', () => $('#shamcashPaymentDialog').close());
$('#closeShamcashDialogBottom').addEventListener('click', () => $('#shamcashPaymentDialog').close());
$('#closeCart').addEventListener('click', closeCart);
$('#cartBackdrop').addEventListener('click', closeCart);
$('#verifyEntry').addEventListener('click', verifyEntry);
$('#sendOrder').addEventListener('click', submitOrder);
$('#cartLines').addEventListener('click', event => {
  const minus = event.target.closest('[data-cart-minus]');
  const plus = event.target.closest('[data-cart-plus]');
  const remove = event.target.closest('[data-cart-remove]');
  if (minus) updateCartQuantity(minus.dataset.cartMinus, -1);
  if (plus) updateCartQuantity(plus.dataset.cartPlus, 1);
  if (remove) { state.cart.delete(remove.dataset.cartRemove); renderCart(); }
});
$('#cartLines').addEventListener('input', event => {
  const note = event.target.closest('[data-cart-note]');
  if (note && state.cart.has(note.dataset.cartNote)) state.cart.get(note.dataset.cartNote).note = note.value;
});

renderCart();
loadRestaurantData();
