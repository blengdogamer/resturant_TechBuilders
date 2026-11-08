function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '';
  if (!allowed || origin !== allowed) return null;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}
function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}
function value(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, value(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(value);
  return null;
}
async function firestoreDocument(projectId, path, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw.error?.message || `تعذر قراءة ${path} من Firestore.`);
  return Object.fromEntries(Object.entries(raw.fields || {}).map(([k, v]) => [k, value(v)]));
}
export async function onRequestOptions({ request, env }) {
  const headers = corsHeaders(request, env);
  return new Response(null, { status: headers ? 204 : 403, headers: headers || {} });
}
export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(request, env);
  if (!headers) return json({ ok: false, error: 'Origin not allowed' }, 403);
  if (!env.SHAMCASH_API_TOKEN) return json({ ok: false, error: 'أضف SHAMCASH_API_TOKEN في Cloudflare Pages Secrets.' }, 503, headers);
  const bearer = request.headers.get('Authorization') || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  if (!token) return json({ ok: false, error: 'جلسة Firebase غير موجودة.' }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'بيانات الطلب غير صالحة.' }, 400, headers); }
  const projectId = String(body.projectId || env.FIREBASE_PROJECT_ID || '').trim();
  const orderId = String(body.orderId || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{3,80}$/i.test(projectId) || !/^[A-Za-z0-9_-]{10,160}$/.test(orderId)) {
    return json({ ok: false, error: 'معرّف المشروع أو الطلب غير صالح.' }, 400, headers);
  }
  try {
    // Firestore rules only permit the guest who owns this order, or a restaurant admin, to read it.
    const [order, settings] = await Promise.all([
      firestoreDocument(projectId, `orders/${orderId}`, token),
      firestoreDocument(projectId, 'settings/restaurant', token)
    ]);
    if (order.paymentMethod !== 'shamcash' || order.payment?.method !== 'shamcash') return json({ ok: false, error: 'هذا الطلب ليس مضبوطاً على شام كاش.' }, 403, headers);
    if (order.status !== 'pending') return json({ ok: false, error: 'لا يمكن إنشاء فاتورة لطلب غير نشط.' }, 409, headers);
    if (order.payment?.invoiceId) return json({ ok: false, error: 'توجد فاتورة شام كاش لهذا الطلب بالفعل.' }, 409, headers);
    if (body.orderNumber && String(body.orderNumber) !== String(order.orderNumber)) return json({ ok: false, error: 'رقم الطلب لا يطابق السجل.' }, 409, headers);
    const shamcash = settings.paymentMethods?.shamcash || {};
    if (shamcash.enabled !== true || !String(shamcash.accountId || '').trim()) return json({ ok: false, error: 'الدفع عبر شام كاش غير مفعّل حاليًا من إعدادات المطعم.' }, 403, headers);
    const amount = Number(order.total);
    const currency = String(order.currency || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !['ل.س', 'SYP'].includes(currency)) return json({ ok: false, error: 'شام كاش في هذا الربط يقبل فواتير الليرة السورية فقط (SYP).' }, 400, headers);
    const invoiceBody = {
      account_id: String(shamcash.accountId).trim(),
      amount: String(Math.round(amount)),
      currency: 'SYP',
      payment_note: String(order.orderNumber),
      hosted: true,
      expires_in_minutes: 30
    };
    const apiResponse = await fetch('https://api.shamcash-api.com/v1/invoices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SHAMCASH_API_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(invoiceBody)
    });
    const payload = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok || payload.status !== 'success') {
      const code = payload.code ? `${payload.code}: ` : '';
      return json({ ok: false, error: `${code}${payload.message || 'رفض ShamCash إنشاء الفاتورة.'}` }, apiResponse.status >= 400 && apiResponse.status < 600 ? apiResponse.status : 502, headers);
    }
    const invoice = payload.data?.invoice || payload.data || {};
    const invoiceId = invoice.invoice_id || invoice.id || invoice.invoiceId;
    const paymentUrl = invoice.payment_url || invoice.hosted_url || invoice.url;
    if (!invoiceId || !paymentUrl || !/^https:\/\//i.test(String(paymentUrl))) {
      return json({ ok: false, error: 'تم استلام رد من شام كاش لكن لا يحتوي معرّف الفاتورة ورابط الدفع المتوقعين. راجع استجابة API.' }, 502, headers);
    }
    return json({ ok: true, invoice: {
      invoiceId: String(invoiceId), paymentUrl: String(paymentUrl),
      paymentNote: String(invoice.payment_note || invoiceBody.payment_note),
      expiresAt: invoice.expires_at || invoice.expiresAt || null,
      status: invoice.status || 'pending'
    } }, 200, headers);
  } catch (error) {
    return json({ ok: false, error: error.message || 'تعذر إنشاء فاتورة شام كاش.' }, 502, headers);
  }
}
