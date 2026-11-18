'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'inventory.sqlite'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT NOT NULL UNIQUE,
   salt TEXT NOT NULL,
   password_hash TEXT NOT NULL,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL UNIQUE COLLATE NOCASE,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS brands (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL UNIQUE COLLATE NOCASE,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS technicians (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   phone TEXT NOT NULL DEFAULT '',
   active INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   name TEXT NOT NULL,
   kind TEXT NOT NULL DEFAULT 'part_seller' CHECK(kind IN ('supplier','part_seller')),
   phone TEXT NOT NULL DEFAULT '',
   notes TEXT NOT NULL DEFAULT '',
   active INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   sku TEXT NOT NULL UNIQUE,
   name TEXT NOT NULL,
   model TEXT NOT NULL DEFAULT '',
   details TEXT NOT NULL DEFAULT '',
   category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
   brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
   mode TEXT NOT NULL DEFAULT 'stock' CHECK(mode IN ('stock','direct')),
   default_usd_price REAL NOT NULL DEFAULT 0,
   stock_qty REAL NOT NULL DEFAULT 0,
   min_stock REAL NOT NULL DEFAULT 0,
   active INTEGER NOT NULL DEFAULT 1,
   created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS movements (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   kind TEXT NOT NULL CHECK(kind IN ('stock_in','sale','direct_use')),
   product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
   item_name_snapshot TEXT NOT NULL,
   category_id INTEGER,
   category_name_snapshot TEXT NOT NULL DEFAULT '',
   brand_id INTEGER,
   brand_name_snapshot TEXT NOT NULL DEFAULT '',
   quantity REAL NOT NULL,
   usd_unit_price REAL NOT NULL,
   irr_rate REAL NOT NULL,
   irr_unit_price REAL NOT NULL,
   total_irr REAL NOT NULL,
   technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
   technician_name_snapshot TEXT NOT NULL DEFAULT '',
   supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
   supplier_name_snapshot TEXT NOT NULL DEFAULT '',
   note TEXT NOT NULL DEFAULT '',
   created_at TEXT NOT NULL,
   created_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
   key TEXT PRIMARY KEY,
   value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_created_date ON movements(created_date);
CREATE INDEX IF NOT EXISTS idx_movements_kind ON movements(kind);
CREATE INDEX IF NOT EXISTS idx_products_search ON products(name, model, sku);
`);
// Backward-compatible migration: keep the existing movements table and its history intact.
const movementColumns = new Set(db.prepare('PRAGMA table_info(movements)').all().map(column => column.name));
if (!movementColumns.has('original_movement_id')) {
   db.exec('ALTER TABLE movements ADD COLUMN original_movement_id INTEGER REFERENCES movements(id) ON DELETE SET NULL');
}
if (!movementColumns.has('is_return')) {
   db.exec('ALTER TABLE movements ADD COLUMN is_return INTEGER NOT NULL DEFAULT 0');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_movements_original_return ON movements(original_movement_id, is_return)');
function nowIso() { return new Date().toISOString(); }
function tehranDate(date = new Date()) {
   const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
   const o = Object.fromEntries(p.map(x => [x.type, x.value]));
   return `${o.year}-${o.month}-${o.day}`;
}
function scryptHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function settingGet(key) { return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; }
function settingSet(key, value) {
   db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USER);
if (!existingAdmin) {
   const salt = crypto.randomBytes(16).toString('hex');
   db.prepare('INSERT INTO users(username,salt,password_hash,created_at) VALUES(?,?,?,?)')
      .run(ADMIN_USER, salt, scryptHash(ADMIN_PASSWORD, salt), nowIso());
}
const defaultCategories = ['ال‌سی‌دی', 'درب پشت', 'سوکت شارژ', 'میکروفون', 'باتری', 'دوربین', 'فلت و کابل', 'اسپیکر', 'سایر'];
const defaultBrands = ['سامسونگ', 'آیفون', 'هواوی', 'شیائومی'];
for (const name of defaultCategories) db.prepare('INSERT OR IGNORE INTO categories(name,created_at) VALUES(?,?)').run(name, nowIso());
for (const name of defaultBrands) db.prepare('INSERT OR IGNORE INTO brands(name,created_at) VALUES(?,?)').run(name, nowIso());
const sessions = new Map();
const loginAttempts = new Map();
const RATE_TTL_MS = 5 * 60 * 1000;
let rateCache = null;
const persistedRatePrice = Number(settingGet('last_rate_price'));
if (Number.isFinite(persistedRatePrice) && persistedRatePrice > 0) {
   const savedFetchedAt = Date.parse(settingGet('last_rate_fetched_at') || '');
   rateCache = {
      price: persistedRatePrice,
      sourceTime: settingGet('last_rate_time'),
      fetchedAt: Number.isFinite(savedFetchedAt) ? savedFetchedAt : 0,
      stale: true,
      warning: 'آخرین نرخ ذخیره‌شده نمایش داده می‌شود؛ برای دریافت نرخ تازه از دکمه به‌روزرسانی استفاده کنید.'
   };
}
async function getRate(force = false) {
   if (!force && rateCache && Date.now() - rateCache.fetchedAt < RATE_TTL_MS) return { ...rateCache, stale: Boolean(rateCache.stale) };
   const controller = new AbortController();
   const timeout = setTimeout(() => controller.abort(), 7000);
   try {
      const endpoint = new URL('https://backend.gheymat.online/api/prices');
      endpoint.search = new URLSearchParams({
         base_currency: 'USDT',
         quote_currency: 'IRT',
         price_source: 'GHEYMAT'
      });
      const response = await fetch(endpoint, {
         headers: { 'Accept': 'application/json', 'User-Agent': 'GhatehYarInventory/1.1' },
         signal: controller.signal
      });
      if (!response.ok) throw new Error(`Currency API responded ${response.status}`);
      const payload = await response.json();
      const quote = Array.isArray(payload.data)
         ? payload.data.find(item => item.symbol === 'USDT-IRT' && item.price_source?.symbol === 'GHEYMAT') || payload.data[0]
         : null;
      // sell_price is the rial amount required to buy one USDT.
      const price = Number(quote?.sell_price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('Unexpected currency API response');
      rateCache = { price, sourceTime: quote.created_at || nowIso(), fetchedAt: Date.now(), source: 'GHEYMAT' };
      settingSet('last_rate_price', price);
      settingSet('last_rate_time', rateCache.sourceTime);
      settingSet('last_rate_fetched_at', new Date().toISOString());
      return { ...rateCache, stale: false };
   } catch (error) {
      const savedPrice = Number(settingGet('last_rate_price'));
      const savedTime = settingGet('last_rate_time');
      if (rateCache?.price) {
         rateCache = { ...rateCache, fetchedAt: Date.now(), stale: true, warning: 'ارتباط با سرویس قیمت گیمت برقرار نشد؛ نرخ ذخیره‌شده نمایش داده می‌شود.' };
         return { ...rateCache };
      }
      if (Number.isFinite(savedPrice) && savedPrice > 0) {
         rateCache = { price: savedPrice, sourceTime: savedTime, fetchedAt: Date.now(), stale: true, warning: 'ارتباط با سرویس قیمت گیمت برقرار نشد؛ آخرین نرخ ذخیره‌شده نمایش داده می‌شود.' };
         return { ...rateCache };
      }
      rateCache = { price: null, sourceTime: null, fetchedAt: Date.now(), stale: true, warning: 'سرویس قیمت گیمت در دسترس نیست و هنوز نرخ قبلی ذخیره نشده است.' };
      return { ...rateCache };
   } finally { clearTimeout(timeout); }
}
function sendJson(res, status, payload, extraHeaders = {}) {
   const body = JSON.stringify(payload);
   res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extraHeaders });
   res.end(body);
}
function parseCookies(header = '') {
   const out = {};
   for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
   }
   return out;
}
function getSession(req) {
   const sid = parseCookies(req.headers.cookie).sid;
   if (!sid) return null;
   const s = sessions.get(sid);
   if (!s || s.expiresAt < Date.now()) { sessions.delete(sid); return null; }
   s.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
   return s;
}
function parseBody(req) {
   return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
         data += chunk;
         if (data.length > 1_000_000) { reject(Object.assign(new Error('حجم درخواست بیش از حد مجاز است.'), { status: 413 })); req.destroy(); }
      });
      req.on('end', () => {
         if (!data) return resolve({});
         try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('بدنه درخواست JSON معتبر نیست.'), { status: 400 })); }
      });
      req.on('error', reject);
   });
}
function requireText(value, label, max = 160) {
   const v = String(value ?? '').trim();
   if (!v) throw Object.assign(new Error(`${label} الزامی است.`), { status: 400 });
   if (v.length > max) throw Object.assign(new Error(`${label} نباید بیشتر از ${max} کاراکتر باشد.`), { status: 400 });
   return v;
}
function optionalText(value, max = 500) {
   const v = String(value ?? '').trim();
   if (v.length > max) throw Object.assign(new Error(`متن واردشده نباید بیشتر از ${max} کاراکتر باشد.`), { status: 400 });
   return v;
}
function positiveNumber(value, label, allowZero = false) {
   const n = Number(value);
   if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0) || n > 1_000_000_000) {
      throw Object.assign(new Error(`${label} معتبر نیست.`), { status: 400 });
   }
   return n;
}
function optionalId(value, table, label) {
   if (value === '' || value == null) return null;
   const id = Number(value);
   if (!Number.isInteger(id) || id < 1 || !db.prepare(`SELECT id FROM ${table} WHERE id = ? ${['technicians','suppliers'].includes(table) ? 'AND active = 1' : ''}`).get(id)) {
      throw Object.assign(new Error(`${label} انتخاب‌شده معتبر نیست.`), { status: 400 });
   }
   return id;
}
function findProduct(id) {
   const product = db.prepare(`SELECT p.*, c.name AS category_name, b.name AS brand_name
      FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
      WHERE p.id=? AND p.active=1`).get(id);
   if (!product) throw Object.assign(new Error('محصول پیدا نشد.'), { status: 404 });
   return product;
}
function findPerson(id, table, label) {
   if (id == null) return null;
   const person = db.prepare(`SELECT * FROM ${table} WHERE id=? AND active=1`).get(id);
   if (!person) throw Object.assign(new Error(`${label} پیدا نشد.`), { status: 400 });
   return person;
}
function recordMovement({ kind, product = null, itemName, categoryId = null, categoryName = '', brandId = null, brandName = '', quantity, usdPrice, rate, technician = null, supplier = null, note = '', originalMovementId = null, isReturn = false }) {
   const irrUnit = usdPrice * rate.price;
   const totalIrr = quantity * irrUnit;
   db.prepare(`INSERT INTO movements(
      kind,product_id,item_name_snapshot,category_id,category_name_snapshot,brand_id,brand_name_snapshot,
      quantity,usd_unit_price,irr_rate,irr_unit_price,total_irr,technician_id,technician_name_snapshot,
      supplier_id,supplier_name_snapshot,note,created_at,created_date,original_movement_id,is_return
   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      kind, product?.id ?? null, itemName, categoryId, categoryName, brandId, brandName,
      quantity, usdPrice, rate.price, irrUnit, totalIrr, technician?.id ?? null, technician?.name ?? '',
      supplier?.id ?? null, supplier?.name ?? '', note, nowIso(), tehranDate(), originalMovementId, isReturn ? 1 : 0
   );
}
function beginTransaction(fn) {
   db.exec('BEGIN IMMEDIATE');
   try { const result = fn(); db.exec('COMMIT'); return result; }
   catch (err) { db.exec('ROLLBACK'); throw err; }
}
function allRefs(table) {
   if (table === 'categories' || table === 'brands') return db.prepare(`SELECT id,name,created_at FROM ${table} ORDER BY name COLLATE NOCASE`).all();
   if (table === 'technicians') return db.prepare('SELECT id,name,phone,active,created_at FROM technicians WHERE active=1 ORDER BY name').all();
   return db.prepare('SELECT id,name,kind,phone,notes,active,created_at FROM suppliers WHERE active=1 ORDER BY name').all();
}
async function apiHandler(req, res, url) {
   const pathname = url.pathname;
   const method = req.method;
   if (pathname === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true, service: 'ghateh-yar' });
   if (pathname === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const bucket = loginAttempts.get(ip) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
      if (bucket.until < Date.now()) { bucket.count = 0; bucket.until = Date.now() + 15 * 60 * 1000; }
      if (bucket.count >= 10) return sendJson(res, 429, { error: 'تعداد تلاش‌ها زیاد است؛ ۱۵ دقیقه دیگر امتحان کنید.' });
      const body = await parseBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      const candidate = user ? scryptHash(password, user.salt) : scryptHash(password, 'fixed-dummy-salt');
      const matched = !!user && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex'));
      if (!matched) {
         bucket.count += 1; loginAttempts.set(ip, bucket);
         return sendJson(res, 401, { error: 'نام کاربری یا رمز عبور اشتباه است.' });
      }
      loginAttempts.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, { userId: user.id, username: user.username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
      const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
      return sendJson(res, 200, { ok: true, username: user.username }, { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}` });
   }
   if (pathname === '/api/logout' && method === 'POST') {
      const sid = parseCookies(req.headers.cookie).sid;
      if (sid) sessions.delete(sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
   }
   if (pathname === '/api/session' && method === 'GET') {
      const session = getSession(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, { authenticated: true, username: session.username });
   }
   const session = getSession(req);
   if (!session) return sendJson(res, 401, { error: 'برای ادامه وارد حساب کاربری شوید.' });
   if (pathname === '/api/rate' && method === 'GET') return sendJson(res, 200, await getRate(url.searchParams.get('refresh') === '1'));
   if (pathname === '/api/change-password' && method === 'POST') {
      const body = await parseBody(req);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.userId);
      const candidate = scryptHash(currentPassword, user.salt);
      const matched = crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex'));
      if (!matched) throw Object.assign(new Error('رمز فعلی درست نیست.'), { status: 400 });
      if (newPassword.length < 12) throw Object.assign(new Error('رمز جدید باید حداقل ۱۲ کاراکتر باشد.'), { status: 400 });
      if (newPassword === currentPassword) throw Object.assign(new Error('رمز جدید باید با رمز فعلی متفاوت باشد.'), { status: 400 });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?').run(salt, scryptHash(newPassword, salt), session.userId);
      return sendJson(res, 200, { ok: true });
   }
   if (pathname === '/api/dashboard' && method === 'GET') {
      const rate = await getRate();
      const today = tehranDate();
      const productStats = db.prepare(`SELECT COUNT(*) AS products_count,
         COALESCE(SUM(CASE WHEN mode='stock' THEN stock_qty ELSE 0 END),0) AS stock_units,
         COALESCE(SUM(CASE WHEN mode='stock' THEN stock_qty*default_usd_price ELSE 0 END),0) AS stock_value_usd,
         SUM(CASE WHEN mode='stock' AND stock_qty<=min_stock THEN 1 ELSE 0 END) AS low_stock_count
         FROM products WHERE active=1`).get();
      const todayStats = db.prepare(`SELECT
         COUNT(*) AS tx_count,
         COALESCE(SUM(CASE WHEN is_return=1 THEN -total_irr ELSE total_irr END),0) AS total_irr,
         COALESCE(SUM(CASE WHEN is_return=1 THEN -quantity ELSE quantity END),0) AS units
         FROM movements
         WHERE created_date=? AND (kind IN ('sale','direct_use') OR is_return=1)`).get(today);
      const latest = db.prepare('SELECT * FROM movements ORDER BY id DESC LIMIT 8').all();
      return sendJson(res, 200, { rate, today, stats: { ...productStats, today_tx_count: todayStats.tx_count, today_total_irr: todayStats.total_irr, today_units: todayStats.units }, latest });
   }
   if (['categories','brands','technicians','suppliers'].some(t => pathname === `/api/${t}`)) {
      const table = pathname.split('/').pop();
      if (method === 'GET') return sendJson(res, 200, allRefs(table));
      if (method === 'POST') {
         const body = await parseBody(req);
         const name = requireText(body.name, 'نام');
         try {
            if (table === 'categories' || table === 'brands') {
               const info = db.prepare(`INSERT INTO ${table}(name,created_at) VALUES(?,?)`).run(name, nowIso());
               return sendJson(res, 201, db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(info.lastInsertRowid)));
            }
            if (table === 'technicians') {
               const info = db.prepare('INSERT INTO technicians(name,phone,created_at) VALUES(?,?,?)').run(name, optionalText(body.phone, 50), nowIso());
               return sendJson(res, 201, db.prepare('SELECT id,name,phone,active,created_at FROM technicians WHERE id=?').get(Number(info.lastInsertRowid)));
            }
            const kind = body.kind === 'supplier' ? 'supplier' : 'part_seller';
            const info = db.prepare('INSERT INTO suppliers(name,kind,phone,notes,created_at) VALUES(?,?,?,?,?)').run(name, kind, optionalText(body.phone, 50), optionalText(body.notes, 500), nowIso());
            return sendJson(res, 201, db.prepare('SELECT * FROM suppliers WHERE id=?').get(Number(info.lastInsertRowid)));
         } catch (error) {
            if (String(error.message).includes('UNIQUE constraint failed')) return sendJson(res, 409, { error: 'این نام قبلاً ثبت شده است.' });
            throw error;
         }
      }
   }
   if (pathname === '/api/products' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const like = `%${q}%`;
      const rows = db.prepare(`SELECT p.*,c.name AS category_name,b.name AS brand_name
         FROM products p LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id
         WHERE p.active=1 AND (?='' OR p.name LIKE ? OR p.model LIKE ? OR p.sku LIKE ? OR c.name LIKE ? OR b.name LIKE ?)
         ORDER BY p.id DESC LIMIT 1000`).all(q, like, like, like, like, like);
      return sendJson(res, 200, rows);
   }
   if (pathname === '/api/products' && method === 'POST') {
      const body = await parseBody(req);
      const name = requireText(body.name, 'نام محصول');
      const model = optionalText(body.model, 160);
      const details = optionalText(body.details, 500);
      const categoryId = optionalId(body.category_id, 'categories', 'دسته‌بندی');
      const brandId = optionalId(body.brand_id, 'brands', 'برند');
      const mode = body.mode === 'direct' ? 'direct' : 'stock';
      const usd = positiveNumber(body.default_usd_price, 'قیمت دلاری', true);
      const qty = mode === 'stock' ? positiveNumber(body.stock_qty ?? 0, 'موجودی اولیه', true) : 0;
      const minStock = mode === 'stock' ? positiveNumber(body.min_stock ?? 0, 'حداقل موجودی', true) : 0;
      const sku = `P-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const openingRate = qty > 0 ? await getRate() : null;
      if (qty > 0 && !openingRate?.price) throw Object.assign(new Error('برای ثبت موجودی اولیه به نرخ دلار نیاز است؛ فعلاً موجودی را صفر بگذارید و پس از دریافت نرخ از بخش شارژ انبار استفاده کنید.'), { status: 503 });
      let productId;
      beginTransaction(() => {
         const info = db.prepare(`INSERT INTO products(sku,name,model,details,category_id,brand_id,mode,default_usd_price,stock_qty,min_stock,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(sku, name, model, details, categoryId, brandId, mode, usd, qty, minStock, nowIso());
         productId = Number(info.lastInsertRowid);
         if (qty > 0) {
            const product = findProduct(productId);
            recordMovement({ kind: 'stock_in', product, itemName: product.name, categoryId: product.category_id, categoryName: product.category_name || '', brandId: product.brand_id, brandName: product.brand_name || '', quantity: qty, usdPrice: usd, rate: openingRate, note: 'موجودی اولیه هنگام تعریف محصول' });
         }
      });
      return sendJson(res, 201, findProduct(productId));
   }
  const productMatch = pathname.match(/^\/api\/products\/(\d+)$/);
   if (productMatch && method === 'PATCH') {
      const body = await parseBody(req);
      const id = Number(productMatch[1]);
      const old = findProduct(id);
      const name = body.name === undefined ? old.name : requireText(body.name, 'نام محصول');
      const model = body.model === undefined ? old.model : optionalText(body.model, 160);
      const details = body.details === undefined ? old.details : optionalText(body.details, 500);
      const categoryId = body.category_id === undefined ? old.category_id : optionalId(body.category_id, 'categories', 'دسته‌بندی');
      const brandId = body.brand_id === undefined ? old.brand_id : optionalId(body.brand_id, 'brands', 'برند');
      const usd = body.default_usd_price === undefined ? old.default_usd_price : positiveNumber(body.default_usd_price, 'قیمت دلاری', true);
      const min = body.min_stock === undefined ? old.min_stock : positiveNumber(body.min_stock, 'حداقل موجودی', true);
      db.prepare('UPDATE products SET name=?,model=?,details=?,category_id=?,brand_id=?,default_usd_price=?,min_stock=? WHERE id=?')
         .run(name, model, details, categoryId, brandId, usd, min, id);
      return sendJson(res, 200, findProduct(id));
   }
   if (productMatch && method === 'DELETE') {
      const id = Number(productMatch[1]); findProduct(id);
      db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
      return sendJson(res, 200, { ok: true });
   }
   if (pathname === '/api/stock-in' && method === 'POST') {
      const body = await parseBody(req);
      const product = findProduct(Number(body.product_id));
      if (product.mode !== 'stock') throw Object.assign(new Error('این محصول در دسته مصرف مستقیم است و نباید وارد موجودی انبار شود.'), { status: 400 });
      const quantity = positiveNumber(body.quantity, 'تعداد');
      const usdPrice = body.usd_unit_price === '' || body.usd_unit_price == null ? product.default_usd_price : positiveNumber(body.usd_unit_price, 'قیمت دلاری', true);
      const supplierId = optionalId(body.supplier_id, 'suppliers', 'تأمین‌کننده');
      const supplier = findPerson(supplierId, 'suppliers', 'تأمین‌کننده');
      const rate = await getRate();
      if (!rate.price) throw Object.assign(new Error('نرخ دلار دریافت نشد؛ تا وصل‌شدن سرویس نمی‌توان عملیات مالی را ثبت کرد.'), { status: 503 });
      beginTransaction(() => {
         db.prepare('UPDATE products SET stock_qty=stock_qty+?,default_usd_price=? WHERE id=?').run(quantity, usdPrice, product.id);
         recordMovement({ kind: 'stock_in', product, itemName: product.name, categoryId: product.category_id, categoryName: product.category_name || '', brandId: product.brand_id, brandName: product.brand_name || '', quantity, usdPrice, rate, supplier, note: optionalText(body.note, 500) });
      });
      return sendJson(res, 201, { ok: true, product: findProduct(product.id), rate });
   }
   if (pathname === '/api/sales' && method === 'POST') {
      const body = await parseBody(req);
      const product = findProduct(Number(body.product_id));
      if (product.mode !== 'stock') throw Object.assign(new Error('این محصول برای تأمین و مصرف مستقیم تعریف شده است؛ از بخش مصرف مستقیم استفاده کنید.'), { status: 400 });
      const quantity = positiveNumber(body.quantity, 'تعداد');
      if (Number(product.stock_qty) < quantity) throw Object.assign(new Error(`موجودی کافی نیست. موجودی فعلی: ${product.stock_qty}`), { status: 409 });
      const technicianId = optionalId(body.technician_id, 'technicians', 'تعمیرکار');
      if (!technicianId) throw Object.assign(new Error('انتخاب تعمیرکار الزامی است.'), { status: 400 });
      const technician = findPerson(technicianId, 'technicians', 'تعمیرکار');
      const usdPrice = body.usd_unit_price === '' || body.usd_unit_price == null ? product.default_usd_price : positiveNumber(body.usd_unit_price, 'قیمت دلاری', true);
      const rate = await getRate();
      if (!rate.price) throw Object.assign(new Error('نرخ دلار دریافت نشد؛ تا وصل‌شدن سرویس نمی‌توان عملیات مالی را ثبت کرد.'), { status: 503 });
      beginTransaction(() => {
         db.prepare('UPDATE products SET stock_qty=stock_qty-? WHERE id=?').run(quantity, product.id);
         recordMovement({ kind: 'sale', product, itemName: product.name, categoryId: product.category_id, categoryName: product.category_name || '', brandId: product.brand_id, brandName: product.brand_name || '', quantity, usdPrice, rate, technician, note: optionalText(body.note, 500) });
      });
      return sendJson(res, 201, { ok: true, product: findProduct(product.id), rate });
   }
   if (pathname === '/api/returnable-sales' && method === 'GET') {
      const rows = db.prepare(`SELECT
            m.id, m.product_id, m.item_name_snapshot, m.quantity, m.usd_unit_price,
            m.irr_rate, m.irr_unit_price, m.total_irr, m.technician_name_snapshot,
            m.created_at, m.created_date,
            COALESCE(SUM(r.quantity),0) AS returned_quantity,
            (m.quantity - COALESCE(SUM(r.quantity),0)) AS remaining_quantity
         FROM movements m
         LEFT JOIN movements r ON r.original_movement_id=m.id AND r.is_return=1
         WHERE m.kind='sale' AND m.is_return=0 AND m.product_id IS NOT NULL
         GROUP BY m.id
         HAVING remaining_quantity > 0.0000001
         ORDER BY m.id DESC
         LIMIT 500`).all();
      return sendJson(res, 200, rows);
   }
   if (pathname === '/api/sales/return' && method === 'POST') {
      const body = await parseBody(req);
      const saleId = Number(body.sale_movement_id);
      if (!Number.isInteger(saleId) || saleId < 1) throw Object.assign(new Error('فروش مرجع معتبر نیست.'), { status: 400 });
      const quantity = positiveNumber(body.quantity, 'تعداد مرجوعی');
      const note = optionalText(body.note, 500);
      let result;
      beginTransaction(() => {
         const sale = db.prepare(`SELECT m.*, p.mode AS product_mode, p.active AS product_active
            FROM movements m LEFT JOIN products p ON p.id=m.product_id
            WHERE m.id=?`).get(saleId);
         if (!sale || sale.kind !== 'sale' || sale.is_return === 1 || sale.product_id == null) {
            throw Object.assign(new Error('فروش انتخاب‌شده معتبر نیست.'), { status: 404 });
         }
         if (sale.product_mode !== 'stock') {
            throw Object.assign(new Error('فقط کالاهای انباری قابل مرجوعی هستند.'), { status: 400 });
         }
         const returned = db.prepare('SELECT COALESCE(SUM(quantity),0) AS quantity FROM movements WHERE original_movement_id=? AND is_return=1').get(saleId);
         const remaining = Number(sale.quantity) - Number(returned.quantity || 0);
         if (quantity > remaining + 0.0000001) {
            throw Object.assign(new Error(`تعداد مرجوعی بیشتر از مانده فروش است. حداکثر قابل مرجوعی: ${remaining}`), { status: 409 });
         }
         db.prepare('UPDATE products SET stock_qty=stock_qty+? WHERE id=?').run(quantity, sale.product_id);
         const returnNote = [`مرجوعی از فروش #${sale.id}`, note].filter(Boolean).join(' · ');
         const info = db.prepare(`INSERT INTO movements(
            kind,product_id,item_name_snapshot,category_id,category_name_snapshot,brand_id,brand_name_snapshot,
            quantity,usd_unit_price,irr_rate,irr_unit_price,total_irr,technician_id,technician_name_snapshot,
            supplier_id,supplier_name_snapshot,note,created_at,created_date,original_movement_id,is_return
         ) VALUES('stock_in',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
            sale.product_id, sale.item_name_snapshot, sale.category_id, sale.category_name_snapshot,
            sale.brand_id, sale.brand_name_snapshot, quantity, sale.usd_unit_price, sale.irr_rate,
            sale.irr_unit_price, quantity * Number(sale.irr_unit_price),
            sale.technician_id, sale.technician_name_snapshot, null, '', returnNote,
            nowIso(), tehranDate(), sale.id
         );
         result = { id: Number(info.lastInsertRowid), product_id: sale.product_id, quantity, original_movement_id: sale.id };
      });
      const product = db.prepare('SELECT id,name,sku,stock_qty,default_usd_price FROM products WHERE id=?').get(result.product_id);
      return sendJson(res, 201, { ok: true, return: result, product });
   }
   if (pathname === '/api/direct-use' && method === 'POST') {
      const body = await parseBody(req);
      const itemName = requireText(body.item_name, 'نام قطعه');
      const categoryId = optionalId(body.category_id, 'categories', 'دسته‌بندی');
      const brandId = optionalId(body.brand_id, 'brands', 'برند');
      const category = categoryId ? db.prepare('SELECT name FROM categories WHERE id=?').get(categoryId) : null;
      const brand = brandId ? db.prepare('SELECT name FROM brands WHERE id=?').get(brandId) : null;
      const quantity = positiveNumber(body.quantity, 'تعداد');
      const usdPrice = positiveNumber(body.usd_unit_price, 'قیمت دلاری', true);
      const technicianId = optionalId(body.technician_id, 'technicians', 'تعمیرکار');
      const supplierId = optionalId(body.supplier_id, 'suppliers', 'قطعه‌فروش یا تأمین‌کننده');
      if (!technicianId) throw Object.assign(new Error('انتخاب تعمیرکار الزامی است.'), { status: 400 });
      if (!supplierId) throw Object.assign(new Error('انتخاب قطعه‌فروش یا تأمین‌کننده الزامی است.'), { status: 400 });
      const technician = findPerson(technicianId, 'technicians', 'تعمیرکار');
      const supplier = findPerson(supplierId, 'suppliers', 'قطعه‌فروش یا تأمین‌کننده');
      const rate = await getRate();
      if (!rate.price) throw Object.assign(new Error('نرخ دلار دریافت نشد؛ تا وصل‌شدن سرویس نمی‌توان عملیات مالی را ثبت کرد.'), { status: 503 });
      recordMovement({ kind: 'direct_use', itemName, categoryId, categoryName: category?.name || '', brandId, brandName: brand?.name || '', quantity, usdPrice, rate, technician, supplier, note: optionalText(body.note, 500) });
      return sendJson(res, 201, { ok: true, rate });
   }
   if (pathname === '/api/reports' && method === 'GET') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      const technicianId = url.searchParams.get('technician_id') || '';
      const brandId = url.searchParams.get('brand_id') || '';
      const categoryId = url.searchParams.get('category_id') || '';
      const supplierId = url.searchParams.get('supplier_id') || '';
      const kind = url.searchParams.get('kind') || '';
      const where = []; const params = [];
      const dateRx = /^\d{4}-\d{2}-\d{2}$/;
      if (from) { if (!dateRx.test(from)) throw Object.assign(new Error('تاریخ شروع معتبر نیست.'), { status: 400 }); where.push('created_date>=?'); params.push(from); }
      if (to) { if (!dateRx.test(to)) throw Object.assign(new Error('تاریخ پایان معتبر نیست.'), { status: 400 }); where.push('created_date<=?'); params.push(to); }
      if (technicianId) { where.push('technician_id=?'); params.push(Number(technicianId)); }
      if (brandId) { where.push('brand_id=?'); params.push(Number(brandId)); }
      if (categoryId) { where.push('category_id=?'); params.push(Number(categoryId)); }
      if (supplierId) { where.push('supplier_id=?'); params.push(Number(supplierId)); }
      if (kind) {
         if (kind === 'sale_return') where.push('is_return=1');
         else {
            if (!['stock_in','sale','direct_use'].includes(kind)) throw Object.assign(new Error('نوع گزارش معتبر نیست.'), { status: 400 });
            where.push('kind=? AND is_return=0'); params.push(kind);
         }
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM movements ${sqlWhere} ORDER BY created_at DESC LIMIT 20000`).all(...params);
      const summary = rows.reduce((a, r) => {
         const sign = r.is_return ? -1 : 1;
         a.count += 1;
         a.quantity += Number(r.quantity);
         a.total_usd += sign * Number(r.quantity) * Number(r.usd_unit_price);
         a.total_irr += sign * Number(r.total_irr);
         if (r.kind === 'sale' && !r.is_return) a.sales_irr += Number(r.total_irr);
         if (r.is_return) { a.sales_irr -= Number(r.total_irr); a.returns_irr += Number(r.total_irr); a.returns_quantity += Number(r.quantity); }
         if (r.kind === 'stock_in' && !r.is_return) a.stock_in_irr += Number(r.total_irr);
         if (r.kind === 'direct_use') a.direct_use_irr += Number(r.total_irr);
         return a;
      }, { count: 0, quantity: 0, total_usd: 0, total_irr: 0, sales_irr: 0, stock_in_irr: 0, direct_use_irr: 0, returns_irr: 0, returns_quantity: 0 });
      // Current inventory valuation is independent of the selected report filters.
      // It uses each stocked product's current default_usd_price.
      const inventory = db.prepare(`
        SELECT
          COALESCE(SUM(stock_qty), 0) AS stock_units,
          COUNT(*) AS stocked_product_count,
          COALESCE(SUM(stock_qty * default_usd_price), 0) AS current_stock_value_usd
        FROM products
        WHERE active = 1 AND mode = 'stock' AND stock_qty > 0
      `).get();

      // Comparison only: original stock-ins minus net sales (sales less returns).
      // This is not an accounting cost valuation because sales prices may differ from purchase costs.
      const movementTotals = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'stock_in' AND is_return = 0 THEN quantity * usd_unit_price ELSE 0 END), 0) AS stock_in_usd,
          COALESCE(SUM(CASE WHEN kind = 'sale' AND is_return = 0 THEN quantity * usd_unit_price ELSE 0 END), 0) AS sales_usd,
          COALESCE(SUM(CASE WHEN is_return = 1 THEN quantity * usd_unit_price ELSE 0 END), 0) AS returns_usd
        FROM movements
      `).get();

      const stockInUsd = Number(movementTotals.stock_in_usd || 0);
      const salesUsd = Number(movementTotals.sales_usd || 0);
      const returnsUsd = Number(movementTotals.returns_usd || 0);
      const movementNetUsd = stockInUsd - salesUsd + returnsUsd;
      const comparison = {
        stock_in_usd: stockInUsd,
        sales_usd: salesUsd,
        returns_usd: returnsUsd,
        net_difference_usd: movementNetUsd
      };

      return sendJson(res, 200, { rows, summary, inventory: {
        ...inventory,
        stock_units: Number(inventory.stock_units || 0),
        stocked_product_count: Number(inventory.stocked_product_count || 0),
        current_stock_value_usd: Number(inventory.current_stock_value_usd || 0),
        all_stock_in_usd: stockInUsd,
        all_sales_usd: salesUsd,
        all_returns_usd: returnsUsd,
        movement_net_usd: movementNetUsd,
        comparison
      }, truncated: rows.length === 20000, filters: { from, to, technician_id: technicianId, brand_id: brandId, category_id: categoryId, supplier_id: supplierId, kind } });
   }
   sendJson(res, 404, { error: 'مسیر درخواستی پیدا نشد.' });
}
function mimeType(file) {
   const ext = path.extname(file).toLowerCase();
   return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' })[ext] || 'application/octet-stream';
}
function serveStatic(req, res, url) {
   let pathname = decodeURIComponent(url.pathname);
   if (pathname === '/') pathname = '/index.html';
   const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
   if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
      res.writeHead(403); return res.end('Forbidden');
   }
   fs.readFile(filePath, (err, buffer) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': mimeType(filePath), 'Content-Length': buffer.length, 'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(buffer);
   });
}
const server = http.createServer(async (req, res) => {
   res.setHeader('X-Content-Type-Options', 'nosniff');
   res.setHeader('X-Frame-Options', 'DENY');
   res.setHeader('Referrer-Policy', 'same-origin');
   res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
   res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
   const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
   try {
      if (url.pathname.startsWith('/api/')) await apiHandler(req, res, url);
      else if (['GET','HEAD'].includes(req.method)) serveStatic(req, res, url);
      else sendJson(res, 405, { error: 'متد پشتیبانی نمی‌شود.' });
   } catch (error) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}:`, error.message);
      if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'خطای داخلی سرور رخ داد.' });
      else res.end();
   }
});
server.listen(PORT, HOST, () => {
   console.log(`GhatehYar is running at http://${HOST}:${PORT}`);
   console.log(`Login username: ${ADMIN_USER}`);
   if (ADMIN_PASSWORD === 'admin12345') console.warn('IMPORTANT: Default admin password is active. Set ADMIN_PASSWORD before first run on a shared network.');
});
function shutdown() {
   server.close(() => { try { db.close(); } finally { process.exit(0); } });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);