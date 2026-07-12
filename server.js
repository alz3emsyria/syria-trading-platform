const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const DEV_AUTO_ACTIVATE = String(process.env.DEV_AUTO_ACTIVATE || "false") === "true";
const PUBLIC_DIR = path.join(__dirname, "public");

if (DEV_AUTO_ACTIVATE) {
  console.warn("تحذير: DEV_AUTO_ACTIVATE=true — الاشتراك يتفعل تلقائيا بدون دفع حقيقي عبر Stripe. لا تستخدم هذا في الإنتاج.");
}

if (!process.env.DATABASE_URL) {
  console.error("خطأ: متغير DATABASE_URL غير مضبوط. أضف قاعدة بيانات PostgreSQL على Render واربطها بهذه الخدمة.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false
});

let dbReadyPromise = ensureDb();

const server = http.createServer(async (req, res) => {
  try {
    await dbReadyPromise;
    if (req.method === "OPTIONS") return corsPreflight(req, res);
    const url = new URL(req.url, APP_URL);

    if (req.method === "POST" && url.pathname === "/api/signup") return signup(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
    if (req.method === "POST" && url.pathname === "/api/logout") return logout(res);
    if (req.method === "GET" && url.pathname === "/api/me") return me(req, res);
    if (req.method === "POST" && url.pathname === "/api/subscribe") return subscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/analyze") return analyze(req, res);
    if (req.method === "GET" && url.pathname === "/api/admin/users") return adminUsers(req, res);
    if (req.method === "POST" && url.pathname === "/api/stripe/webhook") return stripeWebhook(req, res);

    return serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, 500, { error: "حدث خطأ غير متوقع.", detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`SYRIA TRADING is running at ${APP_URL}`);
});

function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      subscribed BOOLEAN NOT NULL DEFAULT false,
      plan TEXT NOT NULL DEFAULT '',
      subscription_until TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      provider TEXT NOT NULL,
      event_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    subscribed: row.subscribed,
    plan: row.plan,
    subscriptionUntil: row.subscription_until,
    createdAt: row.created_at
  };
}

async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  return rowToUser(rows[0]);
}

async function findUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rowToUser(rows[0]);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(),
    ...headers
  });
  res.end(JSON.stringify(body));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "null",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Stripe-Signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function corsPreflight(req, res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

async function bodyJson(req) {
  const raw = await bodyRaw(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function bodyRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        req.destroy();
        reject(new Error("Body is too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions (id, user_id, token_hash, created_at) VALUES ($1, $2, $3, $4)",
    [crypto.randomUUID(), userId, hashToken(token), new Date().toISOString()]
  );
  const packed = `${token}.${sign(token)}`;
  res.setHeader("Set-Cookie", `st_session=${encodeURIComponent(packed)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function authUser(req) {
  const packed = getCookie(req, "st_session");
  if (!packed || !packed.includes(".")) return null;
  const [token, mac] = packed.split(".");
  const expectedMac = sign(token);
  if (mac.length !== expectedMac.length || !crypto.timingSafeEqual(Buffer.from(expectedMac), Buffer.from(mac))) return null;

  const { rows } = await pool.query("SELECT * FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  const session = rows[0];
  if (!session) return null;
  return findUserById(session.user_id);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    subscribed: Boolean(user.subscribed),
    plan: user.plan || "",
    subscriptionUntil: user.subscriptionUntil || ""
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function signup(req, res) {
  const { name, email, password } = await bodyJson(req);
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!name || !cleanEmail || !password || String(password).length < 8) {
    return json(res, 400, { error: "أدخل الاسم والبريد وكلمة مرور من 8 أحرف على الأقل." });
  }
  const existing = await findUserByEmail(cleanEmail);
  if (existing) {
    return json(res, 409, { error: "هذا البريد مسجل بالفعل." });
  }
  const user = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    email: cleanEmail,
    passwordHash: hashPassword(String(password)),
    role: cleanEmail === ADMIN_EMAIL ? "admin" : "member",
    subscribed: false,
    plan: "",
    subscriptionUntil: "",
    createdAt: new Date().toISOString()
  };
  await pool.query(
    `INSERT INTO users (id, name, email, password_hash, role, subscribed, plan, subscription_until, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.id, user.name, user.email, user.passwordHash, user.role, user.subscribed, user.plan, user.subscriptionUntil, user.createdAt]
  );
  await createSession(res, user.id);
  return json(res, 201, { user: publicUser(user) });
}

async function login(req, res) {
  const { email, password } = await bodyJson(req);
  const cleanEmail = String(email || "").trim().toLowerCase();
  const user = await findUserByEmail(cleanEmail);
  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) {
    return json(res, 401, { error: "بيانات الدخول غير صحيحة." });
  }
  await createSession(res, user.id);
  return json(res, 200, { user: publicUser(user) });
}

function logout(res) {
  res.setHeader("Set-Cookie", "st_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return json(res, 200, { ok: true });
}

async function me(req, res) {
  const user = await authUser(req);
  return json(res, 200, { user: user ? publicUser(user) : null });
}

async function subscribe(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  const { plan } = await bodyJson(req);
  const cleanPlan = plan === "yearly" ? "yearly" : "monthly";

  if (DEV_AUTO_ACTIVATE) {
    const subscriptionUntil = addPlanDate(cleanPlan);
    await pool.query(
      "UPDATE users SET subscribed = true, plan = $1, subscription_until = $2 WHERE id = $3",
      [cleanPlan, subscriptionUntil, user.id]
    );
    const updated = await findUserById(user.id);
    return json(res, 200, { activated: true, user: publicUser(updated) });
  }

  const checkoutUrl = await createStripeCheckout(user, cleanPlan);
  return json(res, 200, { activated: false, redirectUrl: checkoutUrl });
}

async function createStripeCheckout(user, plan) {
  const key = process.env.STRIPE_SECRET_KEY || "";
  const price = plan === "yearly" ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
  if (!key || !price) throw new Error("لم يتم ضبط Stripe Secret Key أو سعر الباقة.");

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  params.set("customer_email", user.email);
  params.set("client_reference_id", user.id);
  params.set("metadata[userId]", user.id);
  params.set("metadata[plan]", plan);
  params.set("success_url", `${APP_URL}/?payment=success`);
  params.set("cancel_url", `${APP_URL}/?payment=cancel`);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const data = await response.json();
  if (!response.ok || !data.url) throw new Error(data.error && data.error.message ? data.error.message : "تعذر إنشاء جلسة الدفع.");
  return data.url;
}

function addPlanDate(plan) {
  const d = new Date();
  if (plan === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

async function analyze(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  if (!user.subscribed && user.role !== "admin") return json(res, 403, { error: "هذه الميزة للأعضاء المشتركين فقط." });

  const { binanceSymbol, interval } = await bodyJson(req);
  if (!/^[A-Z0-9]{5,20}$/.test(String(binanceSymbol || ""))) return json(res, 400, { error: "رمز العملة غير صحيح." });
  if (!/^(1m|5m|15m|30m|1h|4h|1d|1w)$/.test(String(interval || ""))) return json(res, 400, { error: "الفريم غير صحيح." });

  const klinesUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=210`;
  const priceUrl = `https://data-api.binance.vision/api/v3/ticker/price?symbol=${binanceSymbol}`;
  const [klineRes, priceRes] = await Promise.all([fetch(klinesUrl), fetch(priceUrl)]);
  if (!klineRes.ok || !priceRes.ok) return json(res, 502, { error: "تعذر الاتصال بمزود البيانات." });

  const klines = await klineRes.json();
  const priceData = await priceRes.json();
  if (!Array.isArray(klines) || klines.length < 60) return json(res, 422, { error: "البيانات غير كافية للتحليل." });

  const closes = klines.map(k => Number(k[4]));
  const highs = klines.map(k => Number(k[2]));
  const lows = klines.map(k => Number(k[3]));
  const currentPrice = Number(priceData.price);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiArr = rsi(closes, 14);
  const macdData = macd(closes);
  const atrArr = atr(highs, lows, closes, 14);
  const last = closes.length - 1;

  const indicators = {
    ema20: ema20[last],
    ema50: ema50[last],
    rsi: rsiArr[last],
    macd: macdData.line[last],
    macdSignal: macdData.signal[last],
    atr: atrArr[last]
  };

  let score = 0;
  score += indicators.ema20 > indicators.ema50 ? 1 : -1;
  score += currentPrice > indicators.ema20 ? 1 : -1;
  score += indicators.macd > indicators.macdSignal ? 1 : -1;
  score += indicators.rsi > 50 ? 1 : -1;

  const direction = score >= 1 ? "buy" : score <= -1 ? "sell" : "none";
  const verdict = score >= 3 ? "شراء قوي" : score >= 1 ? "شراء" : score <= -3 ? "بيع قوي" : score <= -1 ? "بيع" : "محايد";
  const pIdx = klines.length - 2;
  const pivot = (highs[pIdx] + lows[pIdx] + closes[pIdx]) / 3;
  const pivots = {
    r2: pivot + (highs[pIdx] - lows[pIdx]),
    r1: 2 * pivot - lows[pIdx],
    pivot,
    s1: 2 * pivot - highs[pIdx],
    s2: pivot - (highs[pIdx] - lows[pIdx])
  };

  let levels = null;
  if (direction !== "none") {
    const entry = currentPrice;
    const atrValue = indicators.atr;
    levels = {
      entry,
      stopLoss: direction === "buy" ? entry - atrValue : entry + atrValue,
      takeProfit1: direction === "buy" ? entry + atrValue : entry - atrValue,
      takeProfit2: direction === "buy" ? entry + atrValue * 2 : entry - atrValue * 2,
      takeProfit3: direction === "buy" ? entry + atrValue * 3 : entry - atrValue * 3
    };
  }

  return json(res, 200, { currentPrice, score, verdict, direction, indicators, pivots, levels });
}

async function adminUsers(req, res) {
  const user = await authUser(req);
  if (!user || user.role !== "admin") return json(res, 403, { error: "هذه الصفحة للمدير فقط." });
  const { rows } = await pool.query("SELECT * FROM users ORDER BY created_at DESC");
  return json(res, 200, {
    users: rows.map(rowToUser).map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      subscribed: u.subscribed,
      plan: u.plan,
      subscriptionUntil: u.subscriptionUntil,
      createdAt: u.createdAt
    }))
  });
}

async function stripeWebhook(req, res) {
  const raw = await bodyRaw(req);
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (secret && !verifyStripeSignature(raw, req.headers["stripe-signature"] || "", secret)) {
    return json(res, 400, { error: "Stripe signature failed." });
  }

  const event = JSON.parse(raw || "{}");
  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object ? event.data.object : {};
    const userId = session.client_reference_id || (session.metadata && session.metadata.userId);
    const plan = session.metadata && session.metadata.plan === "yearly" ? "yearly" : "monthly";
    if (userId) {
      const user = await findUserById(userId);
      if (user) {
        const subscriptionUntil = addPlanDate(plan);
        await pool.query(
          "UPDATE users SET subscribed = true, plan = $1, subscription_until = $2 WHERE id = $3",
          [plan, subscriptionUntil, userId]
        );
        await pool.query(
          "INSERT INTO payments (id, user_id, plan, provider, event_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [crypto.randomUUID(), userId, plan, "stripe", event.id, new Date().toISOString()]
        );
      }
    }
  }
  return json(res, 200, { received: true });
}

function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries(header.split(",").map(item => item.split("=", 2)));
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${payload}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return serveStatic("/index.html", res);
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const out = new Array(period).fill(null);
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const line = values.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(line, 9);
  return { line, signal };
}

function atr(highs, lows, closes, period = 14) {
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return ema(trs, period);
}
