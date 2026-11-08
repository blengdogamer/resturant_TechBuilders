function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '';
  if (!allowed || origin !== allowed) return null;
  return { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', Vary: 'Origin' };
}
function json(data, status, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
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
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw.error?.message || 'تعذر قراءة الطلب من Firestore.');
  return Object.fromEntries(Object.entries(raw.fields || {}).map(([k, v]) => [k, value(v)]));
}
export async function onRequestOptions({ request, env }) { const headers = corsHeaders(request, env); return new Response(null, { status: headers ? 204 : 403, headers: headers || {} }); }
export async function onRequestPost({ request, env }) {
  const headers = corsHeaders(request, env);
  if (!headers) return json({ ok: false, error: 'Origin not allowed' }, 403);
  if (!env.SHAMCASH_API_TOKEN) return json({ ok: false, error: 'SHAMCASH_API_TOKEN غير مضبوط في Cloudflare.' }, 503, headers);
  const bearer = request.headers.get('Authorization') || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  if (!token) return json({ ok: false, error: 'جلسة الإدارة غير موجودة.' }, 401, headers);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: 'بيانات غير صالحة.' }, 400, headers); }
  const projectId = String(body.projectId || env.FIREBASE_PROJECT_ID || '').trim();
  const orderId = String(body.orderId || '').trim();
  const invoiceId = String(body.invoiceId || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{3,80}$/i.test(projectId) || !/^[A-Za-z0-9_-]{10,160}$/.test(orderId) || !invoiceId || invoiceId.length > 180) return json({ ok: false, error: 'بيانات التحقق غير مكتملة.' }, 400, headers);
  try {
    // Completed orders are moved from /orders to /orderArchive. Check both so
    // the owner can verify an invoice from either list.
    let order;
    try {
      order = await firestoreDocument(projectId, `orders/${orderId}`, token);
    } catch (activeOrderError) {
      try {
        order = await firestoreDocument(projectId, `orderArchive/${orderId}`, token);
      } catch {
        throw activeOrderError;
      }
    }
    if (order.payment?.method !== 'shamcash' || order.payment?.invoiceId !== invoiceId || (body.orderNumber && String(body.orderNumber) !== String(order.orderNumber))) {
      return json({ ok: false, error: 'الفاتورة لا تطابق هذا الطلب.' }, 403, headers);
    }
    const response = await fetch(`https://api.shamcash-api.com/v1/invoices/${encodeURIComponent(invoiceId)}`, {
      headers: { Authorization: `Bearer ${env.SHAMCASH_API_TOKEN}`, Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== 'success') return json({ ok: false, error: payload.message || payload.code || 'تعذر قراءة حالة الفاتورة من شام كاش.' }, response.status >= 400 && response.status < 600 ? response.status : 502, headers);
    const invoice = payload.data?.invoice || payload.data || {};
    const note = invoice.payment_note || invoice.paymentNote;
    if (note && String(note) !== String(order.orderNumber)) return json({ ok: false, error: 'ملاحظة الفاتورة لا تطابق رقم الطلب.' }, 409, headers);
    let status = String(invoice.status || 'pending').toLowerCase();
    const paymentResult = String(invoice.payment_result || invoice.paymentResult || '').toLowerCase();
    if (status === 'completed') status = paymentResult === 'partial' ? 'partial' : 'paid';
    if (status === 'cancelled') status = 'cancelled';
    if (status === 'expired') status = 'expired';
    const payment = {
      status,
      paymentResult: paymentResult || null,
      transactionId: invoice.payment?.transaction_id || invoice.payment?.transactionId || invoice.transaction_id || null,
      paidAmount: invoice.payment?.amount || invoice.payment?.paid_amount || null,
      paidCurrency: invoice.payment?.currency || null,
      paidAt: invoice.payment?.occurred_at || invoice.payment?.paid_at || invoice.paid_at || null
    };
    return json({ ok: true, payment }, 200, headers);
  } catch (error) {
    return json({ ok: false, error: error.message || 'تعذر التحقق من الفاتورة.' }, 502, headers);
  }
}
