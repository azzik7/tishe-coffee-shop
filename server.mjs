import http from "node:http";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "store.json");
const port = Number(process.env.PORT || 4173);
const isProduction = process.env.NODE_ENV === "production";
const paymentMode = process.env.PAYMENT_MODE || "test";
const maxBodyBytes = 64 * 1024;
const sessionsTtlMs = 30 * 24 * 60 * 60 * 1000;
const rateBuckets = new Map();
let saveQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".mp4": "video/mp4", ".woff2": "font/woff2"
};

const seedProducts = [
  { id: "coffee-soft", slug: "myagkiy", name: "Мягкий", subtitle: "Какао и карамель", description: "Спокойный кофе для эспрессо и молочных напитков.", roast: "Средняя", active: true, variants: [
    { id: "soft-250", weight: 250, price: 790, stock: 40 }, { id: "soft-1000", weight: 1000, price: 2490, stock: 15 }
  ] },
  { id: "coffee-balance", slug: "balans", name: "Баланс", subtitle: "Орех и красное яблоко", description: "Ровная чашка на каждый день, подходит для большинства способов.", roast: "Средняя", active: true, variants: [
    { id: "balance-250", weight: 250, price: 850, stock: 40 }, { id: "balance-1000", weight: 1000, price: 2690, stock: 15 }
  ] },
  { id: "coffee-bright", slug: "yarkiy", name: "Яркий", subtitle: "Ягоды и тёмный шоколад", description: "Выразительный профиль для фильтра, турки и гейзера.", roast: "Светлее средней", active: true, variants: [
    { id: "bright-250", weight: 250, price: 920, stock: 40 }, { id: "bright-1000", weight: 1000, price: 2890, stock: 15 }
  ] }
];

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function loadStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(dataFile, "utf8"));
    parsed.products ||= seedProducts; parsed.users ||= []; parsed.orders ||= []; parsed.payments ||= []; parsed.sessions ||= [];
    return parsed;
  } catch {
    return { products: seedProducts, users: [], orders: [], payments: [], sessions: [] };
  }
}

const db = await loadStore();

function saveStore() {
  saveQueue = saveQueue.then(() => writeFile(dataFile, JSON.stringify(db, null, 2), "utf8"));
  return saveQueue;
}

async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || (isProduction ? "" : "admin@tishe.local")).toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || (isProduction ? "" : "ChangeMe-2026!"));
  if (!email || !password) return console.warn("Admin is disabled. Set ADMIN_EMAIL and ADMIN_PASSWORD.");
  if (db.users.some((user) => user.email === email)) return;
  db.users.push({ id: crypto.randomUUID(), name: "Администратор", email, phone: "", role: "admin", passwordHash: await hashPassword(password), createdAt: new Date().toISOString() });
  await saveStore();
  if (!isProduction) console.log(`Local admin: ${email} / ${password}`);
}

await ensureAdmin();

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders });
  response.end(JSON.stringify(payload));
}

function publicUser(user) { return user ? { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } : null; }

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }

async function currentUser(request) {
  const token = parseCookies(request).tishe_session;
  if (!token) return null;
  const session = db.sessions.find((item) => item.tokenHash === tokenHash(token) && new Date(item.expiresAt).getTime() > Date.now());
  return session ? db.users.find((user) => user.id === session.userId) || null : null;
}

async function createSession(user, response) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions = db.sessions.filter((item) => new Date(item.expiresAt).getTime() > Date.now());
  db.sessions.push({ tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + sessionsTtlMs).toISOString() });
  await saveStore();
  response.setHeader("Set-Cookie", `tishe_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionsTtlMs / 1000}${isProduction ? "; Secure" : ""}`);
}

async function destroySession(request, response) {
  const token = parseCookies(request).tishe_session;
  if (token) db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash(token));
  await saveStore();
  response.setHeader("Set-Cookie", `tishe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProduction ? "; Secure" : ""}`);
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return String(forwarded || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimited(request, key, limit = 20, windowMs = 60_000) {
  const id = `${getClientIp(request)}:${key}`;
  const now = Date.now();
  const bucket = (rateBuckets.get(id) || []).filter((time) => now - time < windowMs);
  bucket.push(now); rateBuckets.set(id, bucket);
  return bucket.length > limit;
}

function sameSiteRequest(request) {
  if (String(request.headers["sec-fetch-site"] || "") === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

async function readJson(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("payload_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function clean(value, max = 120) { return String(value || "").trim().slice(0, max); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function orderForClient(order) {
  const { accessTokenHash, ...safe } = order;
  safe.events ||= [{ type: "created", label: "Заказ создан", at: order.createdAt, actor: "customer" }];
  return safe;
}

function appendOrderEvent(order, type, label, actor = "system") {
  order.events ||= [];
  order.events.push({ type, label, actor, at: new Date().toISOString() });
}

function restoreOrderStock(order) {
  if (order.stockRestored) return;
  for (const item of order.items) {
    const product = db.products.find((entry) => entry.id === item.productId);
    const variant = product?.variants.find((entry) => entry.id === item.variantId);
    if (variant) variant.stock += item.quantity;
  }
  order.stockRestored = true;
}

async function expirePendingOrders() {
  let changed = false;
  const now = Date.now();
  for (const order of db.orders) {
    if (order.paymentStatus !== "paid" && !["cancelled", "expired"].includes(order.status) && new Date(order.reservationExpiresAt || 0).getTime() <= now) {
      order.status = "expired";
      order.updatedAt = new Date().toISOString();
      restoreOrderStock(order);
      appendOrderEvent(order, "expired", "Время оплаты истекло, резерв снят");
      changed = true;
    }
  }
  if (changed) await saveStore();
}

async function notifyOrder(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN; const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const items = order.items.map((item) => `${item.name}, ${item.weight} г × ${item.quantity}`).join("\n");
  const text = `Новый заказ ${order.number}\n${items}\nСумма: ${order.total} ₽\n${order.customer.name}, ${order.customer.phone}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(8000) });
  } catch (error) { console.error("Telegram notification failed:", error.message); }
}

function productPayload() { return db.products.filter((product) => product.active).map((product) => ({ ...product })); }

async function api(request, response, url) {
  const method = request.method || "GET"; const pathname = url.pathname;
  await expirePendingOrders();
  if (method !== "GET" && !sameSiteRequest(request)) return sendJson(response, 403, { message: "Запрос отклонён." });
  if (method === "GET" && pathname === "/api/products") return sendJson(response, 200, { products: productPayload() });
  if (method === "GET" && pathname === "/api/auth/me") return sendJson(response, 200, { user: publicUser(await currentUser(request)) });

  if (method === "POST" && pathname === "/api/auth/register") {
    if (rateLimited(request, "register", 8)) return sendJson(response, 429, { message: "Слишком много попыток." });
    let body; try { body = await readJson(request); } catch { return sendJson(response, 400, { message: "Не удалось прочитать данные." }); }
    const name = clean(body.name, 60); const email = clean(body.email, 120).toLowerCase(); const phone = clean(body.phone, 30); const password = String(body.password || "");
    if (name.length < 2 || !validEmail(email) || phone.length < 7 || password.length < 8) return sendJson(response, 422, { message: "Проверьте имя, email, телефон и пароль от 8 символов." });
    if (db.users.some((user) => user.email === email)) return sendJson(response, 409, { message: "Этот email уже зарегистрирован." });
    const user = { id: crypto.randomUUID(), name, email, phone, role: "customer", passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
    db.users.push(user); await createSession(user, response);
    return sendJson(response, 201, { user: publicUser(user) });
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    if (rateLimited(request, "login", 12)) return sendJson(response, 429, { message: "Слишком много попыток." });
    let body; try { body = await readJson(request); } catch { return sendJson(response, 400, { message: "Не удалось прочитать данные." }); }
    const email = clean(body.email, 120).toLowerCase(); const user = db.users.find((item) => item.email === email);
    if (!user || !(await verifyPassword(String(body.password || ""), user.passwordHash))) return sendJson(response, 401, { message: "Неверный email или пароль." });
    await createSession(user, response); return sendJson(response, 200, { user: publicUser(user) });
  }

  if (method === "POST" && pathname === "/api/auth/logout") { await destroySession(request, response); return sendJson(response, 200, { ok: true }); }

  if (method === "POST" && pathname === "/api/orders") {
    if (rateLimited(request, "orders", 10)) return sendJson(response, 429, { message: "Слишком много заказов. Подождите минуту." });
    let body; try { body = await readJson(request); } catch { return sendJson(response, 400, { message: "Не удалось прочитать заказ." }); }
    const user = await currentUser(request); const rawItems = Array.isArray(body.items) ? body.items.slice(0, 20) : []; const items = [];
    for (const raw of rawItems) {
      const product = db.products.find((item) => item.id === raw.productId && item.active); const variant = product?.variants.find((item) => item.id === raw.variantId); const quantity = Math.max(1, Math.min(10, Number(raw.quantity) || 1));
      if (!product || !variant || variant.stock < quantity) return sendJson(response, 409, { message: "Один из товаров закончился или изменился." });
      items.push({ productId: product.id, variantId: variant.id, name: product.name, weight: variant.weight, price: variant.price, quantity });
    }
    if (!items.length) return sendJson(response, 422, { message: "Корзина пуста." });
    const fulfillment = body.fulfillment === "delivery" ? "delivery" : "pickup";
    const customer = { name: clean(body.customer?.name || user?.name, 60), phone: clean(body.customer?.phone || user?.phone, 30), email: clean(body.customer?.email || user?.email, 120).toLowerCase() };
    const address = fulfillment === "delivery" ? clean(body.address, 240) : ""; const pickupTime = fulfillment === "pickup" ? clean(body.pickupTime, 60) : "";
    if (customer.name.length < 2 || customer.phone.length < 7 || !validEmail(customer.email)) return sendJson(response, 422, { message: "Проверьте имя, телефон и email." });
    if (fulfillment === "delivery" && address.length < 8) return sendJson(response, 422, { message: "Укажите адрес доставки." });
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0); const deliveryPrice = fulfillment === "delivery" ? 350 : 0; const accessToken = crypto.randomBytes(20).toString("base64url");
    const createdAt = new Date().toISOString();
    const order = { id: crypto.randomUUID(), number: `T-${String(db.orders.length + 1).padStart(5, "0")}`, userId: user?.id || null, accessTokenHash: tokenHash(accessToken), customer, items, fulfillment, address, pickupTime, comment: clean(body.comment, 300), subtotal, deliveryPrice, total: subtotal + deliveryPrice, status: "new", paymentStatus: "pending", stockRestored: false, reservationExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), events: [{ type: "created", label: "Заказ создан, товар зарезервирован на 30 минут", actor: "customer", at: createdAt }], createdAt, updatedAt: createdAt };
    for (const item of items) db.products.find((product) => product.id === item.productId).variants.find((variant) => variant.id === item.variantId).stock -= item.quantity;
    db.orders.unshift(order); await saveStore();
    return sendJson(response, 201, { order: orderForClient(order), accessToken });
  }

  if (method === "GET" && pathname === "/api/orders") {
    const user = await currentUser(request); if (!user) return sendJson(response, 401, { message: "Войдите в аккаунт." });
    return sendJson(response, 200, { orders: db.orders.filter((order) => order.userId === user.id).map(orderForClient) });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (method === "GET" && orderMatch) {
    const order = db.orders.find((item) => item.id === orderMatch[1]); if (!order) return sendJson(response, 404, { message: "Заказ не найден." });
    const user = await currentUser(request); const allowed = user?.role === "admin" || (user && order.userId === user.id) || tokenHash(url.searchParams.get("token") || "") === order.accessTokenHash;
    return allowed ? sendJson(response, 200, { order: orderForClient(order) }) : sendJson(response, 403, { message: "Нет доступа к заказу." });
  }

  if (method === "POST" && pathname === "/api/payments") {
    let body; try { body = await readJson(request); } catch { return sendJson(response, 400, { message: "Не удалось прочитать данные." }); }
    const order = db.orders.find((item) => item.id === body.orderId); if (!order) return sendJson(response, 404, { message: "Заказ не найден." });
    const user = await currentUser(request); const allowed = user?.role === "admin" || (user && order.userId === user.id) || tokenHash(clean(body.accessToken, 200)) === order.accessTokenHash;
    if (!allowed) return sendJson(response, 403, { message: "Нет доступа к заказу." });
    if (paymentMode !== "test") return sendJson(response, 503, { message: "Платёжный сервис ещё не подключён." });
    const payment = { id: crypto.randomUUID(), orderId: order.id, amount: order.total, status: "pending", provider: "test", createdAt: new Date().toISOString() };
    db.payments.push(payment); await saveStore();
    return sendJson(response, 201, { payment, paymentUrl: `/checkout.html?paymentId=${payment.id}&token=${encodeURIComponent(body.accessToken || "")}` });
  }

  const confirmMatch = pathname.match(/^\/api\/payments\/([^/]+)\/test-confirm$/);
  if (method === "POST" && confirmMatch) {
    if (paymentMode !== "test") return sendJson(response, 404, { message: "Недоступно." });
    let body; try { body = await readJson(request); } catch { body = {}; }
    const payment = db.payments.find((item) => item.id === confirmMatch[1]); const order = payment && db.orders.find((item) => item.id === payment.orderId);
    if (!payment || !order || tokenHash(clean(body.accessToken, 200)) !== order.accessTokenHash) return sendJson(response, 403, { message: "Нет доступа к платежу." });
    if (["cancelled", "expired"].includes(order.status)) return sendJson(response, 409, { message: "Резерв заказа уже снят. Создайте заказ заново." });
    payment.status = "paid"; payment.paidAt = new Date().toISOString(); order.paymentStatus = "paid"; order.status = "confirmed"; order.updatedAt = new Date().toISOString();
    appendOrderEvent(order, "paid", "Оплата подтверждена, заказ передан кофейне");
    await saveStore(); notifyOrder(order); return sendJson(response, 200, { payment, order: orderForClient(order) });
  }

  if (pathname.startsWith("/api/admin/")) {
    const admin = await currentUser(request); if (!admin || admin.role !== "admin") return sendJson(response, 403, { message: "Нужны права администратора." });
    if (method === "GET" && pathname === "/api/admin/orders") return sendJson(response, 200, { orders: db.orders.map(orderForClient) });
    if (method === "GET" && pathname === "/api/admin/products") return sendJson(response, 200, { products: db.products });
    const adminOrderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (method === "PATCH" && adminOrderMatch) {
      let body; try { body = await readJson(request); } catch { return sendJson(response, 400, { message: "Не удалось прочитать данные." }); }
      const order = db.orders.find((item) => item.id === adminOrderMatch[1]); const allowedStatuses = ["new", "confirmed", "accepted", "preparing", "ready", "completed", "cancelled"];
      if (!order) return sendJson(response, 404, { message: "Заказ не найден." });
      if (!allowedStatuses.includes(body.status)) return sendJson(response, 422, { message: "Неизвестный статус." });
      order.status = body.status; order.updatedAt = new Date().toISOString();
      if (body.status === "cancelled") restoreOrderStock(order);
      const labels = { new: "Заказ ожидает оплаты", confirmed: "Оплата подтверждена", accepted: "Кофейня приняла заказ", preparing: "Заказ готовится", ready: "Заказ готов к выдаче", completed: "Заказ выполнен", cancelled: "Заказ отменён" };
      appendOrderEvent(order, body.status, labels[body.status], "staff");
      await saveStore();
      return sendJson(response, 200, { order: orderForClient(order) });
    }
  }
  return sendJson(response, 404, { message: "API-адрес не найден." });
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, ""); const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`) || filePath.startsWith(`${dataDir}${path.sep}`)) { response.writeHead(403); return response.end("Forbidden"); }
  let fileStat; try { fileStat = await stat(filePath); } catch { response.writeHead(404); return response.end("Not found"); }
  if (!fileStat.isFile()) { response.writeHead(404); return response.end("Not found"); }
  const headers = { "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'" };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) { response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` }); return response.end(); }
    const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Number(match[2]) : fileStat.size - 1;
    if (start > end || end >= fileStat.size) { response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` }); return response.end(); }
    response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${fileStat.size}`, "Content-Length": end - start + 1 });
    return request.method === "HEAD" ? response.end() : createReadStream(filePath, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...headers, "Content-Length": fileStat.size }); return request.method === "HEAD" ? response.end() : createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true, paymentMode });
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    if (request.method === "GET" || request.method === "HEAD") return await serveStatic(request, response, url.pathname);
    response.writeHead(405, { Allow: "GET, HEAD, POST, PATCH" }); response.end("Method not allowed");
  } catch (error) { console.error(error); sendJson(response, 500, { message: "Внутренняя ошибка сервера." }); }
});

server.listen(port, "0.0.0.0", () => console.log(`тише is listening on port ${port}, payments: ${paymentMode}`));
