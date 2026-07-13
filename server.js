"use strict";
/* =====================================================================
   Pizza on Wood Oven — ordering backend
   Zero-dependency Node.js (built-in http module only). Node 18+.

   Endpoints
     GET  /api/menu         -> menu + store info
     POST /api/orders       -> validate & price an order server-side
     GET  /api/orders/:id   -> order status lookup
     GET  /*                -> static files from ./public

   Security posture
     - Client-sent prices are IGNORED. Every line is re-priced from
       data/menu.json on the server. Unknown item/extra ids -> 400.
     - JSON body capped at 50 KB; strings length-capped; qty capped.
     - Orders persisted to data/orders.json (swap for a real DB in prod).
===================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MENU_PATH = path.join(ROOT, "data", "menu.json");
const ORDERS_PATH = path.join(ROOT, "data", "orders.json");
const MAX_BODY = 50 * 1024;
const MAX_QTY = 20;
const MAX_LINES = 40;

/* ---------- data ---------- */
const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
const itemById = new Map();
for (const cat of menu.categories) for (const it of cat.items) itemById.set(it.id, it);
const extraById = new Map(menu.extras.map(e => [e.id, e]));
const cents = n => Math.round(n * 100);
const unitCents = it => it.discountPct
  ? Math.round(cents(it.price) * (100 - it.discountPct) / 100)
  : cents(it.price);

let orders = {};
try { orders = JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8")); } catch { orders = {}; }
let saveTimer = null;
function persistOrders() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(ORDERS_PATH, JSON.stringify(orders, null, 2), err => {
      if (err) console.error("order persist failed:", err.message);
    });
  }, 50);
}

/* ---------- helpers ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}
const bad = (res, msg) => json(res, 400, { error: msg });

function readBody(req, res, cb) {
  let size = 0, chunks = [];
  req.on("data", c => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return json(res, 413, { error: "Request too large." }); }
    chunks.push(c);
  });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { return bad(res, "Body must be valid JSON."); }
    cb(parsed);
  });
  req.on("error", () => {});
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validAuPhone = p => /^(\+?61|0)\d{9}$/.test(String(p).replace(/[\s\-()]/g, ""));

/* ---------- order validation & pricing ---------- */
function priceOrder(payload) {
  const errors = [];
  const fulfilment = payload.fulfilment === "delivery" ? "delivery" : payload.fulfilment === "pickup" ? "pickup" : null;
  if (!fulfilment) errors.push("fulfilment must be 'pickup' or 'delivery'.");

  const c = payload.customer || {};
  const customer = {
    name: str(c.name, 80),
    phone: str(c.phone, 25),
    address: str(c.address, 200)
  };
  if (customer.name.length < 2) errors.push("Customer name is required.");
  if (!validAuPhone(customer.phone)) errors.push("A valid Australian phone number is required.");
  if (fulfilment === "delivery" && customer.address.length < 8) errors.push("A delivery address is required.");

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) errors.push("Order has no items.");
  if (Array.isArray(payload.lines) && payload.lines.length > MAX_LINES) errors.push("Too many order lines.");

  const lines = [];
  let subtotal = 0;
  if (Array.isArray(payload.lines)) {
    for (const [i, raw] of payload.lines.slice(0, MAX_LINES).entries()) {
      const qty = Number.isInteger(raw.qty) && raw.qty >= 1 && raw.qty <= MAX_QTY ? raw.qty : null;
      if (!qty) { errors.push(`Line ${i + 1}: qty must be an integer between 1 and ${MAX_QTY}.`); continue; }

      if (raw.type === "deal") {
        if (raw.dealId !== menu.deal.id) { errors.push(`Line ${i + 1}: unknown deal.`); continue; }
        const pizzas = Array.isArray(raw.pizzas) ? raw.pizzas : [];
        if (pizzas.length !== menu.deal.pizzaCount) { errors.push(`Line ${i + 1}: the deal needs exactly ${menu.deal.pizzaCount} pizzas.`); continue; }
        const names = [];
        let pizzasOk = true;
        for (const pid of pizzas) {
          const it = itemById.get(pid);
          if (!it || !it.isPizza) { errors.push(`Line ${i + 1}: '${String(pid).slice(0, 40)}' is not a valid pizza.`); pizzasOk = false; break; }
          names.push(it.name);
        }
        if (!pizzasOk) continue;
        const lineCents = cents(menu.deal.price) * qty;
        subtotal += lineCents;
        lines.push({ type: "deal", name: menu.deal.name, detail: names.join(" + ") + " + Garlic Bread", qty, unitCents: cents(menu.deal.price), lineCents });
        continue;
      }

      // regular item — price is recomputed here, client price ignored
      const it = itemById.get(raw.itemId);
      if (!it) { errors.push(`Line ${i + 1}: unknown item '${String(raw.itemId).slice(0, 40)}'.`); continue; }
      let unit = unitCents(it);
      const extraNames = [];
      const extras = Array.isArray(raw.extras) ? raw.extras.slice(0, 10) : [];
      if (extras.length && !it.isPizza) { errors.push(`Line ${i + 1}: extras are only available on pizzas.`); continue; }
      let extrasOk = true;
      for (const exId of extras) {
        const ex = extraById.get(exId);
        if (!ex) { errors.push(`Line ${i + 1}: unknown extra '${String(exId).slice(0, 40)}'.`); extrasOk = false; break; }
        unit += cents(ex.price);
        extraNames.push(ex.name);
      }
      if (!extrasOk) continue;
      const lineCents = unit * qty;
      subtotal += lineCents;
      lines.push({ type: "item", name: it.name, detail: extraNames.join(", "), notes: str(raw.notes, 200), qty, unitCents: unit, lineCents });
    }
  }

  const deliveryFee = fulfilment === "delivery" ? cents(menu.store.deliveryFee) : 0;
  if (fulfilment === "delivery" && subtotal < cents(menu.store.deliveryMinimum)) {
    errors.push(`Delivery orders need a minimum subtotal of $${menu.store.deliveryMinimum.toFixed(2)}.`);
  }

  return { errors, fulfilment, customer, lines, totals: { sub: subtotal, deliveryFee, grand: subtotal + deliveryFee } };
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function serveStatic(req, res, urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[\/\\])+/, "");
  let file = path.join(PUBLIC_DIR, clean === "/" || clean === "\\" ? "index.html" : clean);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  });
}

/* ---------- router ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/menu" && req.method === "GET") return json(res, 200, menu);

  if (p === "/api/orders" && req.method === "POST") {
    return readBody(req, res, payload => {
      if (res.writableEnded) return;
      const priced = priceOrder(payload);
      if (priced.errors.length) return json(res, 400, { error: priced.errors[0], errors: priced.errors });
      const orderId = "PWO-" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const order = {
        orderId,
        status: "received",
        placedAt: new Date().toISOString(),
        fulfilment: priced.fulfilment,
        customer: priced.customer,
        lines: priced.lines,
        totals: priced.totals,
        etaMinutes: priced.fulfilment === "delivery" ? 40 : 25
      };
      orders[orderId] = order;
      persistOrders();
      console.log(`[order] ${orderId} ${order.fulfilment} $${(order.totals.grand / 100).toFixed(2)} — ${order.customer.name}`);
      json(res, 201, { orderId, etaMinutes: order.etaMinutes, totals: order.totals, status: order.status });
    });
  }

  const m = p.match(/^\/api\/orders\/([A-Za-z0-9\-]{1,24})$/);
  if (m && req.method === "GET") {
    const order = orders[m[1]];
    if (!order) return json(res, 404, { error: "Order not found." });
    const { customer, ...publicOrder } = order; // don't echo PII on lookup
    return json(res, 200, publicOrder);
  }

  if (p.startsWith("/api/")) return json(res, 404, { error: "Not found." });
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  serveStatic(req, res, p);
});

server.listen(PORT, () => console.log(`Pizza on Wood Oven ordering site → http://localhost:${PORT}`));
