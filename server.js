const http = require("http");
const WebSocket = require("ws");
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

// مهم جدا: بدون هذا المعالج، أي انقطاع مؤقت باتصال قاعدة البيانات
// (شي طبيعي ويصير من وقت لآخر) كان يسبب انهيار السيرفر بالكامل (Crash)
// لأن Node.js يرمي استثناء غير معالج ويوقف العملية كلها.
pool.on("error", (err) => {
  console.error("خطأ غير متوقع من اتصال قاعدة البيانات الخامل:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

let dbReadyPromise = ensureDb();

const server = http.createServer(async (req, res) => {
  try {
    await dbReadyPromise;
    if (req.method === "OPTIONS") return corsPreflight(req, res);
    const url = new URL(req.url, APP_URL);

    if (req.method === "POST" && url.pathname === "/api/signup") return signup(req, res);
    if (req.method === "POST" && url.pathname === "/api/verify-email") return verifyEmail(req, res);
    if (req.method === "POST" && url.pathname === "/api/resend-verification") return resendVerification(req, res);
    if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
    if (req.method === "POST" && url.pathname === "/api/logout") return logout(res);
    if (req.method === "GET" && url.pathname === "/api/me") return me(req, res);
    if (req.method === "POST" && url.pathname === "/api/subscribe") return subscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/analyze") return analyze(req, res);
    if (req.method === "GET" && url.pathname === "/api/admin/users") return adminUsers(req, res);
    if (req.method === "POST" && url.pathname === "/api/admin/subscription") return adminSetSubscription(req, res);
    if (req.method === "POST" && url.pathname === "/api/admin/keys/generate") return adminGenerateKey(req, res);
    if (req.method === "GET" && url.pathname === "/api/admin/keys") return adminListKeys(req, res);
    if (req.method === "POST" && url.pathname === "/api/redeem") return redeemKey(req, res);
    if (req.method === "POST" && url.pathname === "/api/stripe/webhook") return stripeWebhook(req, res);
    if (req.method === "GET" && url.pathname === "/api/daily-results") return dailyResults(req, res);
    if (req.method === "GET" && url.pathname === "/api/live-stream") return liveStream(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/price") return priceTick(req, res, url);

    return serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, 500, { error: "حدث خطأ غير متوقع.", detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`SYRIA TRADING is running at ${APP_URL}`);
});

// فحص فوري عند البدء (بعد جهوزية القاعدة)، ثم كل 5 دقائق: يتابع الصفقات المفتوحة ويحدد هل وصلت لهدف أو وقف
dbReadyPromise.then(checkOpenSignals).catch(() => {});
setInterval(checkOpenSignals, 5 * 60 * 1000);

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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT;`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      code TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_by TEXT,
      used_by_email TEXT,
      used_at TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_signals (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      provider TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry DOUBLE PRECISION NOT NULL,
      stop_loss DOUBLE PRECISION NOT NULL,
      tp1 DOUBLE PRECISION NOT NULL,
      tp2 DOUBLE PRECISION NOT NULL,
      tp3 DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      result_r DOUBLE PRECISION,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      is_scalp BOOLEAN NOT NULL DEFAULT false
    );
  `);
  await pool.query(`ALTER TABLE trade_signals ADD COLUMN IF NOT EXISTS is_scalp BOOLEAN NOT NULL DEFAULT false;`);
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
    createdAt: row.created_at,
    emailVerified: row.email_verified,
    verifyCode: row.verify_code,
    verifyExpires: row.verify_expires,
    telegramChatId: row.telegram_chat_id,
    telegramLinkCode: row.telegram_link_code
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
    subscriptionUntil: user.subscriptionUntil || "",
    emailVerified: Boolean(user.emailVerified),
    telegramLinked: Boolean(user.telegramChatId)
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
  const verifyCode = String(crypto.randomInt(100000, 999999));
  const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
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
    `INSERT INTO users (id, name, email, password_hash, role, subscribed, plan, subscription_until, created_at, verify_code, verify_expires)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [user.id, user.name, user.email, user.passwordHash, user.role, user.subscribed, user.plan, user.subscriptionUntil, user.createdAt, verifyCode, verifyExpires]
  );
  await createSession(res, user.id);
  sendVerificationEmail(user.email, user.name, verifyCode).catch(() => {});
  return json(res, 201, { user: publicUser({ ...user, emailVerified: false }) });
}

async function verifyEmail(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  if (user.emailVerified) return json(res, 200, { user: publicUser(user) });
  const { code } = await bodyJson(req);
  const cleanCode = String(code || "").trim();
  if (!user.verifyCode || !cleanCode || cleanCode !== user.verifyCode) {
    return json(res, 400, { error: "رمز التحقق غير صحيح." });
  }
  if (user.verifyExpires && new Date(user.verifyExpires).getTime() < Date.now()) {
    return json(res, 400, { error: "انتهت صلاحية الرمز، اطلب رمزا جديدا." });
  }
  await pool.query("UPDATE users SET email_verified = true, verify_code = NULL WHERE id = $1", [user.id]);
  const updated = await findUserById(user.id);
  return json(res, 200, { user: publicUser(updated) });
}

async function resendVerification(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  if (user.emailVerified) return json(res, 200, { ok: true });
  const verifyCode = String(crypto.randomInt(100000, 999999));
  const verifyExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await pool.query("UPDATE users SET verify_code = $1, verify_expires = $2 WHERE id = $3", [verifyCode, verifyExpires, user.id]);
  sendVerificationEmail(user.email, user.name, verifyCode).catch(() => {});
  return json(res, 200, { ok: true });
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

function computeHistoricalSignals(closes, highs, lows, volumes, times, ema20Arr, ema50Arr, rsiArr, macdData, bb, stochRsiArr, volAvg) {
  const markers = [];
  let lastDirection = "none";
  const start = 55; // بداية بعد ما تستقر كل المؤشرات (EMA50 وغيرها)
  for (let i = start; i < closes.length; i++) {
    if (ema20Arr[i] == null || ema50Arr[i] == null || rsiArr[i] == null) continue;
    let score = 0, count = 0;
    score += ema20Arr[i] > ema50Arr[i] ? 1 : -1; count++;
    score += closes[i] > ema20Arr[i] ? 1 : -1; count++;
    score += macdData.line[i] > macdData.signal[i] ? 1 : -1; count++;
    score += rsiArr[i] > 50 ? 1 : -1; count++;
    if (stochRsiArr[i] != null) { score += stochRsiArr[i] < 20 ? 1 : stochRsiArr[i] > 80 ? -1 : 0; count++; }
    if (bb.upper[i] != null) { score += closes[i] > bb.upper[i] ? 1 : closes[i] < bb.lower[i] ? -1 : 0; count++; }
    if (volAvg[i] != null) {
      const priceUp = closes[i] > closes[i - 1];
      const volConfirms = volumes[i] > volAvg[i] * 1.2;
      score += volConfirms ? (priceUp ? 1 : -1) : 0; count++;
    }
    // عتبة أخف من قرار التداول الحي، لأن هذي إشارات توضيحية على الشارت فقط وليست قرار تداول فعلي
    const threshold = Math.max(2, Math.ceil(count * 0.45));
    const direction = score >= threshold ? "buy" : score <= -threshold ? "sell" : "none";
    if (direction !== "none" && direction !== lastDirection) {
      markers.push({ time: times[i], type: direction, price: direction === "buy" ? lows[i] : highs[i] });
      lastDirection = direction;
    }
  }
  return markers.slice(-12); // آخر 12 إشارة تاريخية بس لتفادي الازدحام
}

async function analyze(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  if (!user.subscribed && user.role !== "admin") return json(res, 403, { error: "هذه الميزة للأعضاء المشتركين فقط." });

  const { symbol, interval, provider } = await bodyJson(req);
  const cleanProvider = provider === "yahoo" ? "yahoo" : "binance";
  const symbolPattern = cleanProvider === "yahoo" ? /^[A-Z0-9^.=\-]{1,20}$/i : /^[A-Z0-9]{5,20}$/;
  if (!symbolPattern.test(String(symbol || ""))) return json(res, 400, { error: "رمز الأداة غير صحيح." });
  if (!/^(1m|5m|15m|30m|1h|4h|1d|1w)$/.test(String(interval || ""))) return json(res, 400, { error: "الفريم غير صحيح." });

  const isRealCrypto = cleanProvider === "binance" && symbol !== "PAXGUSDT";
  const [marketData, htfResult, fngResult] = await Promise.all([
    fetchMarketData(symbol, interval, cleanProvider),
    fetchHigherTimeframeTrend(symbol, interval, cleanProvider),
    isRealCrypto ? fetchFearGreedIndex() : Promise.resolve(null)
  ]);
  if (!marketData) return json(res, 502, { error: "تعذر الاتصال بمزود البيانات أو الرمز غير مدعوم حاليا." });

  const { times, opens, closes, highs, lows, volumes, currentPrice } = marketData;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsiArr = rsi(closes, 14);
  const macdData = macd(closes);
  const atrArr = atr(highs, lows, closes, 14);
  const bb = bollinger(closes, 20, 2);
  const stochRsiArr = stochasticRsi(rsiArr, 14);
  const volAvg = sma(volumes, 20);
  const last = closes.length - 1;

  const indicators = {
    ema20: ema20[last],
    ema50: ema50[last],
    rsi: rsiArr[last],
    macd: macdData.line[last],
    macdSignal: macdData.signal[last],
    atr: atrArr[last],
    bbUpper: bb.upper[last],
    bbMid: bb.mid[last],
    bbLower: bb.lower[last],
    stochRsi: stochRsiArr[last],
    volume: volumes[last],
    volumeAvg: volAvg[last]
  };

  // نظام تقييم موزون: كل مؤشر يصوت بشكل مستقل، والاتجاه النهائي هو محصلة الأصوات
  const signals = [];
  signals.push({ name: "اتجاه EMA20/EMA50", value: indicators.ema20 > indicators.ema50 ? 1 : -1 });
  signals.push({ name: "السعر مقابل EMA20", value: currentPrice > indicators.ema20 ? 1 : -1 });
  signals.push({ name: "MACD", value: indicators.macd > indicators.macdSignal ? 1 : -1 });
  signals.push({ name: "RSI", value: indicators.rsi > 50 ? 1 : -1 });
  if (indicators.stochRsi !== null) {
    signals.push({ name: "Stochastic RSI", value: indicators.stochRsi < 20 ? 1 : indicators.stochRsi > 80 ? -1 : 0 });
  }
  if (indicators.bbUpper !== null) {
    signals.push({ name: "نطاقات Bollinger", value: currentPrice > indicators.bbUpper ? 1 : currentPrice < indicators.bbLower ? -1 : 0 });
  }
  if (indicators.volumeAvg !== null) {
    const priceUp = currentPrice > closes[last - 1];
    const volumeConfirms = indicators.volume > indicators.volumeAvg * 1.2;
    signals.push({ name: "تأكيد الحجم", value: volumeConfirms ? (priceUp ? 1 : -1) : 0 });
  }
  let htfTrend = null;
  if (htfResult) {
    htfTrend = htfResult;
    signals.push({ name: `اتجاه الفريم الأعلى (${htfResult.timeframe})`, value: htfResult.bullish ? 1 : -1 });
  }
  let fearGreed = null;
  if (fngResult) {
    fearGreed = fngResult;
    // منطق عكسي: خوف شديد = فرصة تراكم محتملة، طمع شديد = حذر من تصحيح
    const fngSignal = fngResult.value <= 25 ? 1 : fngResult.value >= 75 ? -1 : 0;
    signals.push({ name: "مؤشر الخوف والطمع", value: fngSignal });
  }

  const smc = analyzeSmartMoney(opens, highs, lows, closes, times, currentPrice);
  if (smc.trend !== "neutral") {
    signals.push({ name: "هيكل السوق SMC", value: smc.trend === "bullish" ? 1 : -1 });
  }
  if (smc.bos) {
    signals.push({ name: `كسر هيكل ${smc.bos.type === "bullish" ? "صاعد" : "هابط"} (BOS)`, value: smc.bos.type === "bullish" ? 1 : -1 });
  }
  if (smc.nearFvg) {
    signals.push({ name: "داخل فجوة سيولة FVG", value: smc.nearFvg.type === "bullish" ? 1 : -1 });
  }
  if (smc.nearOrderBlock) {
    signals.push({ name: "عند Order Block", value: smc.nearOrderBlock.type === "bullish" ? 1 : -1 });
  }

  const score = signals.reduce((s, x) => s + x.value, 0);
  const maxPossible = signals.length;
  const confidencePct = maxPossible > 0 ? Math.round((Math.abs(score) / maxPossible) * 100) : 0;
  const confidenceLabel = confidencePct >= 75 ? "قوي جدا" : confidencePct >= 55 ? "قوي" : confidencePct >= 35 ? "متوسط" : "ضعيف";

  // وضع سكالب: يفعّل تلقائيًا على فريمي 1 و5 دقائق - عتبة أخف لصفقات أكثر تكرارا،
  // مع وقف وأهداف أضيق تناسب حركة سريعة (لا يوجد أي "ضمان" ربح، هذا تخفيف عتبة فقط)
  const isScalp = interval === "1m" || interval === "5m";

  // شرط دخول عادي (فريمات أكبر): مشدد 60%+ لتقليل الضجيج ويبقي فقط الفرص عالية الجودة
  const strongThreshold = isScalp
    ? Math.max(2, Math.ceil(maxPossible * 0.4))
    : Math.max(3, Math.ceil(maxPossible * 0.6));
  const minConfidence = isScalp ? 40 : 60;
  const direction = (score >= strongThreshold && confidencePct >= minConfidence) ? "buy"
    : (score <= -strongThreshold && confidencePct >= minConfidence) ? "sell"
    : "none";
  const verdict = direction === "buy" ? `${isScalp ? "سكالب شراء" : "شراء"} (${confidenceLabel})` : direction === "sell" ? `${isScalp ? "سكالب بيع" : "بيع"} (${confidenceLabel})` : "لا توجد صفقة كافية القوة - انتظار";

  const pIdx = closes.length - 2;
  const pivot = (highs[pIdx] + lows[pIdx] + closes[pIdx]) / 3;
  const swingWindow = 30;
  const recentHighs = highs.slice(-swingWindow, -1);
  const recentLows = lows.slice(-swingWindow, -1);
  const pivots = {
    r2: pivot + (highs[pIdx] - lows[pIdx]),
    r1: 2 * pivot - lows[pIdx],
    pivot,
    s1: 2 * pivot - highs[pIdx],
    s2: pivot - (highs[pIdx] - lows[pIdx]),
    swingHigh: Math.max(...recentHighs),
    swingLow: Math.min(...recentLows)
  };

  let levels = null;
  if (direction !== "none") {
    const entry = currentPrice;
    const atrValue = indicators.atr;
    let stopLoss;
    if (isScalp) {
      // سكالب: وقف ضيق ثابت (0.6-1x ATR) بدون الاعتماد على هيكل بعيد، لصفقات سريعة
      const dir = direction === "buy" ? -1 : 1;
      stopLoss = entry + dir * atrValue * 0.8;
    } else if (direction === "buy") {
      // وقف خسارة ذكي: خلف آخر قمة/قاع فعلي بالهيكل بدل رقم ثابت،
      // مع حد أدنى وأقصى مبني على ATR لتفادي وقف ضيق جدا أو واسع جدا
      const structuralStop = pivots.swingLow - atrValue * 0.3;
      const minStop = entry - atrValue * 1.2;
      const maxStop = entry - atrValue * 2.5;
      stopLoss = Math.min(minStop, Math.max(structuralStop, maxStop));
    } else {
      const structuralStop = pivots.swingHigh + atrValue * 0.3;
      const minStop = entry + atrValue * 1.2;
      const maxStop = entry + atrValue * 2.5;
      stopLoss = Math.max(minStop, Math.min(structuralStop, maxStop));
    }
    // الأهداف = مضاعفات من المخاطرة الفعلية (R): سكالب أهداف أقرب لصفقات أسرع، عادي أهداف أبعد
    const risk = Math.abs(entry - stopLoss);
    const dir = direction === "buy" ? 1 : -1;
    const mult = isScalp ? [1, 1.8, 2.5] : [1.5, 3, 5];
    levels = {
      entry,
      stopLoss,
      takeProfit1: entry + dir * risk * mult[0],
      takeProfit2: entry + dir * risk * mult[1],
      takeProfit3: entry + dir * risk * mult[2],
      riskAmount: risk,
      riskReward: isScalp ? "1:1 / 1:1.8 / 1:2.5" : "1:1.5 / 1:3 / 1:5",
      isScalp
    };
  }

  if (levels) {
    await logTradeSignal(symbol, cleanProvider, direction, levels, isScalp);
  }

  const chartLen = 150;
  const chartStart = Math.max(0, closes.length - chartLen);
  const candles = [];
  for (let i = chartStart; i < closes.length; i++) {
    candles.push({ time: times[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i] });
  }

  const historyMarkers = computeHistoricalSignals(closes, highs, lows, volumes, times, ema20, ema50, rsiArr, macdData, bb, stochRsiArr, volAvg);

  return json(res, 200, {
    currentPrice, score, confidencePct, confidenceLabel, verdict, direction,
    indicators, pivots, levels, signals, htfTrend, fearGreed, smc, candles, historyMarkers
  });
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
      createdAt: u.createdAt,
      emailVerified: Boolean(u.emailVerified),
      telegramLinked: Boolean(u.telegramChatId)
    }))
  });
}

async function adminSetSubscription(req, res) {
  const admin = await authUser(req);
  if (!admin || admin.role !== "admin") return json(res, 403, { error: "هذه الصفحة للمدير فقط." });

  const { userId, action, plan } = await bodyJson(req);
  if (!userId || !["activate", "deactivate"].includes(action)) {
    return json(res, 400, { error: "بيانات غير صحيحة." });
  }

  const target = await findUserById(userId);
  if (!target) return json(res, 404, { error: "العضو غير موجود." });

  if (action === "activate") {
    const cleanPlan = plan === "yearly" ? "yearly" : "monthly";
    const subscriptionUntil = addPlanDate(cleanPlan);
    await pool.query(
      "UPDATE users SET subscribed = true, plan = $1, subscription_until = $2 WHERE id = $3",
      [cleanPlan, subscriptionUntil, userId]
    );
    await pool.query(
      "INSERT INTO payments (id, user_id, plan, provider, event_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), userId, cleanPlan, "manual", null, new Date().toISOString()]
    );
  } else {
    await pool.query(
      "UPDATE users SET subscribed = false, plan = '', subscription_until = '' WHERE id = $1",
      [userId]
    );
  }

  const updated = await findUserById(userId);
  return json(res, 200, { user: publicUser(updated) });
}

function generateKeyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون أحرف/أرقام ملتبسة (0,O,1,I)
  const group = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join("");
  return `ST-${group()}-${group()}-${group()}`;
}

async function adminGenerateKey(req, res) {
  const admin = await authUser(req);
  if (!admin || admin.role !== "admin") return json(res, 403, { error: "هذه الصفحة للمدير فقط." });

  const { plan } = await bodyJson(req);
  const cleanPlan = plan === "yearly" ? "yearly" : "monthly";
  const code = generateKeyCode();
  await pool.query(
    "INSERT INTO access_keys (code, plan, created_at) VALUES ($1,$2,$3)",
    [code, cleanPlan, new Date().toISOString()]
  );
  return json(res, 201, { code, plan: cleanPlan });
}

async function adminListKeys(req, res) {
  const admin = await authUser(req);
  if (!admin || admin.role !== "admin") return json(res, 403, { error: "هذه الصفحة للمدير فقط." });

  const { rows } = await pool.query("SELECT * FROM access_keys ORDER BY created_at DESC LIMIT 200");
  return json(res, 200, {
    keys: rows.map(r => ({
      code: r.code,
      plan: r.plan,
      createdAt: r.created_at,
      usedByEmail: r.used_by_email,
      usedAt: r.used_at
    }))
  });
}

async function redeemKey(req, res) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });

  const { code } = await bodyJson(req);
  const cleanCode = String(code || "").trim().toUpperCase();
  if (!cleanCode) return json(res, 400, { error: "أدخل مفتاح التفعيل." });

  const { rows } = await pool.query("SELECT * FROM access_keys WHERE code = $1", [cleanCode]);
  const key = rows[0];
  if (!key) return json(res, 404, { error: "المفتاح غير صحيح." });
  if (key.used_by) return json(res, 409, { error: "هذا المفتاح مستخدم مسبقا." });

  const subscriptionUntil = addPlanDate(key.plan);
  await pool.query(
    "UPDATE users SET subscribed = true, plan = $1, subscription_until = $2 WHERE id = $3",
    [key.plan, subscriptionUntil, user.id]
  );
  await pool.query(
    "UPDATE access_keys SET used_by = $1, used_by_email = $2, used_at = $3 WHERE code = $4",
    [user.id, user.email, new Date().toISOString(), cleanCode]
  );

  const updated = await findUserById(user.id);
  return json(res, 200, { user: publicUser(updated) });
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

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function stochasticRsi(rsiArr, period = 14) {
  const out = new Array(rsiArr.length).fill(null);
  for (let i = period - 1; i < rsiArr.length; i++) {
    const slice = rsiArr.slice(i - period + 1, i + 1);
    if (slice.some(v => v === null)) continue;
    const hi = Math.max(...slice);
    const lo = Math.min(...slice);
    out[i] = hi === lo ? 50 : ((rsiArr[i] - lo) / (hi - lo)) * 100;
  }
  return out;
}

const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; SyriaTradingBot/1.0)" };

// ===== Smart Money Concepts (ICT/SMC) =====

function detectSwingPoints(highs, lows, lookback = 3) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    const leftH = highs.slice(i - lookback, i);
    const rightH = highs.slice(i + 1, i + 1 + lookback);
    if (leftH.every(h => h <= highs[i]) && rightH.every(h => h <= highs[i])) {
      swingHighs.push({ index: i, price: highs[i] });
    }
    const leftL = lows.slice(i - lookback, i);
    const rightL = lows.slice(i + 1, i + 1 + lookback);
    if (leftL.every(l => l >= lows[i]) && rightL.every(l => l >= lows[i])) {
      swingLows.push({ index: i, price: lows[i] });
    }
  }
  return { swingHighs, swingLows };
}

function detectMarketStructure(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return { trend: "neutral", lastSwingHigh: null, lastSwingLow: null };
  const [h1, h2] = swingHighs.slice(-2);
  const [l1, l2] = swingLows.slice(-2);
  let trend = "neutral";
  if (h2.price > h1.price && l2.price > l1.price) trend = "bullish";
  else if (h2.price < h1.price && l2.price < l1.price) trend = "bearish";
  return { trend, lastSwingHigh: h2, lastSwingLow: l2 };
}

function detectBOS(closes, times, structure) {
  const last = closes.length - 1;
  if (!structure.lastSwingHigh || !structure.lastSwingLow) return null;
  if (closes[last] > structure.lastSwingHigh.price) {
    return { type: "bullish", price: structure.lastSwingHigh.price, time: times[last] };
  }
  if (closes[last] < structure.lastSwingLow.price) {
    return { type: "bearish", price: structure.lastSwingLow.price, time: times[last] };
  }
  return null;
}

function detectFairValueGaps(highs, lows, times, lookback = 60) {
  const fvgs = [];
  const start = Math.max(2, highs.length - lookback);
  for (let i = start; i < highs.length; i++) {
    if (highs[i - 2] < lows[i]) fvgs.push({ type: "bullish", top: lows[i], bottom: highs[i - 2], time: times[i - 1] });
    if (lows[i - 2] > highs[i]) fvgs.push({ type: "bearish", top: lows[i - 2], bottom: highs[i], time: times[i - 1] });
  }
  return fvgs.slice(-6);
}

function detectOrderBlocks(opens, closes, times, lookback = 60) {
  const blocks = [];
  const start = Math.max(1, closes.length - lookback);
  const recentCloses = closes.slice(-30);
  const avgMove = recentCloses.reduce((s, c, idx, arr) => (idx > 0 ? s + Math.abs(arr[idx] - arr[idx - 1]) : s), 0) / Math.max(1, recentCloses.length - 1);
  for (let i = start; i < closes.length - 1; i++) {
    const bodyNext = Math.abs(closes[i + 1] - opens[i + 1]);
    const isImpulsive = bodyNext > avgMove * 1.5;
    const currentBearish = closes[i] < opens[i];
    const currentBullish = closes[i] > opens[i];
    if (isImpulsive && closes[i + 1] > opens[i + 1] && currentBearish) {
      blocks.push({ type: "bullish", top: opens[i], bottom: closes[i], time: times[i] });
    }
    if (isImpulsive && closes[i + 1] < opens[i + 1] && currentBullish) {
      blocks.push({ type: "bearish", top: closes[i], bottom: opens[i], time: times[i] });
    }
  }
  return blocks.slice(-4);
}

function detectLiquidityPools(highs, lows, lookback = 60, tolerance = 0.0015) {
  const start = Math.max(0, highs.length - lookback);
  const pools = [];
  for (let i = start; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[i] - highs[j]) / highs[i] < tolerance) {
        pools.push({ type: "sellside", price: (highs[i] + highs[j]) / 2 });
      }
      if (Math.abs(lows[i] - lows[j]) / lows[i] < tolerance) {
        pools.push({ type: "buyside", price: (lows[i] + lows[j]) / 2 });
      }
    }
  }
  return pools.slice(-6);
}

function analyzeSmartMoney(opens, highs, lows, closes, times, currentPrice) {
  const { swingHighs, swingLows } = detectSwingPoints(highs, lows, 3);
  const structure = detectMarketStructure(swingHighs, swingLows);
  const bos = detectBOS(closes, times, structure);
  const fvgs = detectFairValueGaps(highs, lows, times);
  const orderBlocks = detectOrderBlocks(opens, closes, times);
  const liquidity = detectLiquidityPools(highs, lows);
  const nearFvg = fvgs.find(f => currentPrice <= f.top * 1.01 && currentPrice >= f.bottom * 0.99) || null;
  const nearOrderBlock = orderBlocks.find(o => currentPrice <= o.top * 1.01 && currentPrice >= o.bottom * 0.99) || null;
  return { trend: structure.trend, bos, fvgs, orderBlocks, liquidity, nearFvg, nearOrderBlock };
}

function aggregateCandles(rows, groupSize) {
  const out = [];
  for (let i = 0; i < rows.length; i += groupSize) {
    const chunk = rows.slice(i, i + groupSize);
    if (!chunk.length) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0)
    });
  }
  return out;
}

async function fetchBinanceKlines(symbol, interval, limit = 210) {
  const [klineRes, priceRes] = await Promise.all([
    fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),
    fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`)
  ]);
  if (!klineRes.ok || !priceRes.ok) return null;
  const klines = await klineRes.json();
  const priceData = await priceRes.json();
  if (!Array.isArray(klines) || klines.length < 60) return null;
  return {
    times: klines.map(k => Math.floor(Number(k[0]) / 1000)),
    opens: klines.map(k => Number(k[1])),
    highs: klines.map(k => Number(k[2])),
    lows: klines.map(k => Number(k[3])),
    closes: klines.map(k => Number(k[4])),
    volumes: klines.map(k => Number(k[5])),
    currentPrice: Number(priceData.price)
  };
}

async function fetchYahooKlines(symbol, interval) {
  const map = {
    "1m": { yInterval: "1m", range: "5d" },
    "5m": { yInterval: "5m", range: "1mo" },
    "15m": { yInterval: "15m", range: "1mo" },
    "30m": { yInterval: "30m", range: "3mo" },
    "1h": { yInterval: "60m", range: "6mo" },
    "4h": { yInterval: "60m", range: "1y" },
    "1d": { yInterval: "1d", range: "2y" },
    "1w": { yInterval: "1wk", range: "5y" }
  };
  const cfg = map[interval] || map["1h"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${cfg.range}&interval=${cfg.yInterval}`;
  const r = await fetch(url, { headers: YAHOO_HEADERS });
  if (!r.ok) return null;
  const data = await r.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.timestamp || !result.indicators || !result.indicators.quote) return null;
  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  let rows = ts
    .map((t, i) => ({ time: t, open: q.open[i], close: q.close[i], high: q.high[i], low: q.low[i], volume: q.volume[i] }))
    .filter(r => r.close != null && r.high != null && r.low != null && r.open != null);
  if (interval === "4h") rows = aggregateCandles(rows, 4);
  rows = rows.slice(-210);
  if (rows.length < 60) return null;
  const currentPrice = result.meta && result.meta.regularMarketPrice != null
    ? Number(result.meta.regularMarketPrice)
    : rows[rows.length - 1].close;
  return {
    times: rows.map(r => r.time),
    opens: rows.map(r => r.open),
    closes: rows.map(r => r.close),
    highs: rows.map(r => r.high),
    lows: rows.map(r => r.low),
    volumes: rows.map(r => r.volume || 0),
    currentPrice
  };
}

async function fetchMarketData(symbol, interval, provider) {
  return provider === "yahoo" ? fetchYahooKlines(symbol, interval) : fetchBinanceKlines(symbol, interval);
}

async function fetchHigherTimeframeTrend(symbol, interval, provider) {
  const map = { "1m": "15m", "5m": "1h", "15m": "4h", "30m": "4h", "1h": "4h", "4h": "1d", "1d": "1w", "1w": "1w" };
  const higherTf = map[interval] || "4h";
  try {
    const data = await fetchMarketData(symbol, higherTf, provider);
    if (!data || data.closes.length < 55) return null;
    const e20 = ema(data.closes, 20);
    const e50 = ema(data.closes, 50);
    const last = data.closes.length - 1;
    return { timeframe: higherTf, bullish: e20[last] > e50[last] };
  } catch {
    return null;
  }
}

async function fetchFearGreedIndex() {
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!r.ok) return null;
    const d = await r.json();
    const item = d && d.data && d.data[0];
    if (!item) return null;
    return { value: Number(item.value), classification: item.value_classification };
  } catch {
    return null;
  }
}

// ===== التحقق بالإيميل والإشعارات =====

function fmtNum(n) {
  const v = Number(n);
  return v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : v < 100 ? 4 : 2 });
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY غير مضبوط - تم تخطي إرسال الإيميل إلى " + to);
    return;
  }
  const from = process.env.RESEND_FROM_EMAIL || "SYRIA TRADING <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    if (!r.ok) console.error("فشل إرسال الإيميل:", await r.text());
  } catch (e) {
    console.error("خطأ إرسال الإيميل:", e.message);
  }
}

async function sendVerificationEmail(email, name, code) {
  await sendEmail(
    email,
    "رمز تفعيل حسابك - SYRIA TRADING",
    `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;text-align:right;background:#0d1117;color:#e6edf3;padding:24px">
      <h2 style="color:#f0c76f">مرحبا ${name}</h2>
      <p>رمز تفعيل حسابك على <b>SYRIA TRADING</b> هو:</p>
      <p style="font-size:34px;font-weight:900;letter-spacing:6px;color:#f0c76f;direction:ltr;text-align:center">${code}</p>
      <p>هذا الرمز صالح لمدة 15 دقيقة فقط. إذا لم تطلب هذا الرمز، تجاهل هذا الإيميل.</p>
    </div>`
  );
}

async function liveStream(req, res, url) {
  const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
  const interval = String(url.searchParams.get("interval") || "1h");
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !/^(1m|5m|15m|30m|1h|4h|1d|1w)$/.test(interval)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("bad request");
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders()
  });
  res.write(":ok\n\n");

  let closed = false;
  let upstream = null;

  function connectUpstream() {
    if (closed) return;
    try {
      const wsBase = process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443";
      upstream = new WebSocket(`${wsBase}/ws/${symbol.toLowerCase()}@kline_${interval}`);
      upstream.on("message", raw => {
        try {
          const msg = JSON.parse(raw.toString());
          const k = msg.k;
          if (!k) return;
          const payload = { time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c) };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {}
      });
      upstream.on("close", () => { if (!closed) setTimeout(connectUpstream, 3000); });
      upstream.on("error", () => { try { upstream.close(); } catch {} });
    } catch {
      if (!closed) setTimeout(connectUpstream, 3000);
    }
  }
  connectUpstream();

  const pingInterval = setInterval(() => { try { res.write(":ping\n\n"); } catch {} }, 20000);

  req.on("close", () => {
    closed = true;
    clearInterval(pingInterval);
    if (upstream) { try { upstream.close(); } catch {} }
  });
}



async function fetchCurrentPriceOnly(symbol, provider) {
  try {
    if (provider === "yahoo") {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`, { headers: YAHOO_HEADERS });
      if (!r.ok) return null;
      const data = await r.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const price = result && result.meta && result.meta.regularMarketPrice;
      return price != null ? Number(price) : null;
    }
    const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) return null;
    const d = await r.json();
    return Number(d.price);
  } catch {
    return null;
  }
}

async function logTradeSignal(symbol, provider, direction, levels, isScalp) {
  try {
    const dedupMinutes = isScalp ? 15 : 360; // سكالب: نافذة قصيرة تسمح بصفقات متكررة أسرع
    const cutoff = new Date(Date.now() - dedupMinutes * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      "SELECT id FROM trade_signals WHERE symbol = $1 AND status = 'open' AND created_at > $2 LIMIT 1",
      [symbol, cutoff]
    );
    if (rows.length) return; // فيه صفقة مفتوحة حديثة لنفس الرمز، لا داعي لتكرارها
    await pool.query(
      `INSERT INTO trade_signals (id, symbol, provider, direction, entry, stop_loss, tp1, tp2, tp3, status, created_at, is_scalp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11)`,
      [crypto.randomUUID(), symbol, provider, direction, levels.entry, levels.stopLoss, levels.takeProfit1, levels.takeProfit2, levels.takeProfit3, new Date().toISOString(), Boolean(isScalp)]
    );
    // ملاحظة: إشعارات تلغرام/الإيميل معطّلة حاليًا بطلب صاحب الموقع
  } catch (e) {
    console.error("تعذر تسجيل الصفقة:", e.message);
  }
}

async function checkOpenSignals() {
  try {
    const { rows } = await pool.query("SELECT * FROM trade_signals WHERE status = 'open' LIMIT 100");
    for (const s of rows) {
      const price = await fetchCurrentPriceOnly(s.symbol, s.provider);
      if (price == null) continue;
      let status = null, resultR = null;
      const mult = s.is_scalp ? [1, 1.8, 2.5] : [1.5, 3, 5];
      if (s.direction === "buy") {
        if (price <= s.stop_loss) { status = "sl"; resultR = -1; }
        else if (price >= s.tp3) { status = "tp3"; resultR = mult[2]; }
        else if (price >= s.tp2) { status = "tp2"; resultR = mult[1]; }
        else if (price >= s.tp1) { status = "tp1"; resultR = mult[0]; }
      } else {
        if (price >= s.stop_loss) { status = "sl"; resultR = -1; }
        else if (price <= s.tp3) { status = "tp3"; resultR = mult[2]; }
        else if (price <= s.tp2) { status = "tp2"; resultR = mult[1]; }
        else if (price <= s.tp1) { status = "tp1"; resultR = mult[0]; }
      }
      if (status) {
        await pool.query(
          "UPDATE trade_signals SET status = $1, result_r = $2, closed_at = $3 WHERE id = $4",
          [status, resultR, new Date().toISOString(), s.id]
        );
      }
    }
  } catch (e) {
    console.error("خطأ أثناء فحص الصفقات المفتوحة:", e.message);
  }
}

async function priceTick(req, res, url) {
  const user = await authUser(req);
  if (!user) return json(res, 401, { error: "سجل الدخول أولا." });
  const symbol = url.searchParams.get("symbol");
  const provider = url.searchParams.get("provider") === "yahoo" ? "yahoo" : "binance";
  if (!symbol) return json(res, 400, { error: "الرمز مطلوب." });
  const price = await fetchCurrentPriceOnly(symbol, provider);
  if (price == null) return json(res, 502, { error: "تعذر جلب السعر." });
  return json(res, 200, { price, time: Math.floor(Date.now() / 1000) });
}

async function dailyResults(req, res) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { rows } = await pool.query(
    "SELECT * FROM trade_signals WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 100",
    [todayStart.toISOString()]
  );
  const closed = rows.filter(r => r.status !== "open");
  const wins = closed.filter(r => r.status !== "sl");
  const losses = closed.filter(r => r.status === "sl");
  const totalR = closed.reduce((s, r) => s + (Number(r.result_r) || 0), 0);
  return json(res, 200, {
    date: todayStart.toISOString().slice(0, 10),
    totalSignals: rows.length,
    openCount: rows.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    totalR: Math.round(totalR * 100) / 100,
    trades: rows.slice(0, 15).map(r => ({
      symbol: r.symbol, direction: r.direction, status: r.status,
      resultR: r.result_r, createdAt: r.created_at
    }))
  });
}
