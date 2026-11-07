function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return origin === new URL(request.url).origin;
}

async function handleTelegram(request, env) {
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    if (!isSameOrigin(request)) return json({ ok: false, error: "Origin not allowed" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": new URL(request.url).origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin"
      }
    });
  }

  if (method === "GET") {
    return json({
      ok: true,
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    });
  }

  if (method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
  }

  if (!isSameOrigin(request)) {
    return json({ ok: false, error: "Origin not allowed" }, 403);
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ ok: false, error: "أضف TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID في إعدادات Worker." }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "بيانات الطلب غير صالحة." }, 400);
  }

  const phone = String(data.phone || "").trim();
  const orderNumber = String(data.orderNumber || "").trim();
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Number(data.total);
  const currency = String(data.currency || "").trim().slice(0, 12);

  if (!orderNumber || orderNumber.length > 40 || phone.length < 7 || phone.length > 24 ||
      items.length < 1 || items.length > 30 || !Number.isFinite(total) || total < 0 || !currency) {
    return json({ ok: false, error: "بيانات الطلب ناقصة أو غير صالحة." }, 400);
  }

  const lines = [];
  for (const item of items.slice(0, 12)) {
    const name = String(item.name || "").trim().slice(0, 70);
    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(item.quantity) || 1)));
    const note = String(item.note || "").trim().slice(0, 100);
    const subtotal = Number(item.subtotal);

    if (!name || !Number.isFinite(subtotal) || subtotal < 0) {
      return json({ ok: false, error: "أحد الأصناف في الطلب غير صالح." }, 400);
    }

    lines.push(
      `• ${escapeHtml(name)} × ${quantity} — ${escapeHtml(subtotal.toLocaleString("en-US"))} ${escapeHtml(currency)}${note ? `\n  ملاحظة: ${escapeHtml(note)}` : ""}`
    );
  }

  const restaurantName = escapeHtml(String(data.restaurantName || "TechBuilders").slice(0, 80));
  const location = data.location && typeof data.location === "object" ? data.location : {};
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  const distance = Number(location.distanceMeters);
  const mapLine = Number.isFinite(lat) && Number.isFinite(lng)
    ? `\n📍 <a href="https://maps.google.com/?q=${lat},${lng}">عرض موقع العميل</a> (المسافة المحسوبة: ${Math.round(distance || 0)} م)`
    : "";

  const message = [
    `🍽️ <b>طلب جديد — ${restaurantName}</b>`,
    `🧾 <b>رقم الطلب:</b> <code>${escapeHtml(orderNumber)}</code>`,
    `📞 <b>هاتف العميل:</b> <code>${escapeHtml(phone)}</code>`,
    "",
    "<b>تفاصيل الطلب:</b>",
    lines.join("\n"),
    ...(items.length > 12 ? [`… وهناك ${items.length - 12} صنف إضافي في الطلب.`] : []),
    "",
    `💰 <b>الإجمالي:</b> ${escapeHtml(total.toLocaleString("en-US"))} ${escapeHtml(currency)}`,
    mapLine
  ].filter(Boolean).join("\n");

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }
    );

    const result = await telegramResponse.json();
    if (!telegramResponse.ok || result.ok !== true) {
      return json({ ok: false, error: result.description || "فشل Telegram في إرسال الإشعار." }, 502);
    }

    return json({ ok: true, messageId: result.result?.message_id || null });
  } catch {
    return json({ ok: false, error: "تعذر الاتصال بخدمة Telegram." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/send-order") {
      return handleTelegram(request, env);
    }

    // Serve the existing restaurant website from the public/ folder.
    return env.ASSETS.fetch(request);
  }
};
