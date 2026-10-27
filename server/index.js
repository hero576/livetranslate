import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

await store.init();
await seedAdmin();

/* ------------------------------------------------------------------ *
 * 认证（内存会话 token，7 天有效；数据落库）
 * ------------------------------------------------------------------ */
const SESSIONS = new Map();
const SESSION_TTL = 7 * 24 * 3600 * 1000;

async function seedAdmin() {
  if (!(await store.getUserByUsername("hero576"))) {
    const u = await store.createUser("hero576", "guoming");
    await store.pool.query("UPDATE users SET role='admin', status='active' WHERE id=?", [u.id]);
    console.log("[auth] 已创建初始管理员 hero576");
  }
}

function tokenOf(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

async function currentUser(req) {
  const t = tokenOf(req);
  if (!t) return null;
  const s = SESSIONS.get(t);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(t); return null; }
  return store.getUserById(s.userId);
}

async function requireAuth(req, res, next) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "未登录" });
  if (u.status !== "active") return res.status(403).json({ ok: false, error: "账号待审批或被禁用" });
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ ok: false, error: "需要管理员权限" });
  }
  next();
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, status: u.status, createdAt: u.createdAt };
}

/* ---------------------------- 认证 API ---------------------------- */
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const u = await store.getUserByUsername(username || "");
  if (!u || !store.verifyPassword(u, password || "")) {
    return res.status(401).json({ ok: false, error: "用户名或密码错误" });
  }
  if (u.status === "pending") return res.status(403).json({ ok: false, error: "账号待管理员审批" });
  if (u.status === "rejected") return res.status(403).json({ ok: false, error: "账号注册被拒绝" });

  const token = crypto.randomBytes(24).toString("hex");
  SESSIONS.set(token, { userId: u.id, expires: Date.now() + SESSION_TTL });
  await store.touchLogin(u.id);
  return res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: "用户名和密码不能为空" });
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ ok: false, error: "用户名需 3-32 位字母/数字/_./-" });
  }
  if (String(password).length < 6) return res.status(400).json({ ok: false, error: "密码至少 6 位" });
  if (await store.getUserByUsername(username)) return res.status(409).json({ ok: false, error: "用户名已存在" });

  await store.createUser(username, password);
  return res.json({ ok: true, message: "注册成功，等待管理员审批" });
});

app.post("/api/auth/logout", (req, res) => {
  const t = tokenOf(req);
  if (t) SESSIONS.delete(t);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

/** 修改密码 */
app.post("/api/auth/password", requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next) return res.status(400).json({ ok: false, error: "请输入当前密码和新密码" });
  if (String(next).length < 6) return res.status(400).json({ ok: false, error: "新密码至少 6 位" });
  if (!store.verifyPassword(req.user, current)) {
    return res.status(400).json({ ok: false, error: "当前密码错误" });
  }
  await store.updatePassword(req.user.id, next);
  res.json({ ok: true, message: "密码已更新" });
});

/* ---------------------------- 会话 API ---------------------------- */
app.get("/api/conv", requireAuth, async (req, res) => {
  res.json({ ok: true, conversations: await store.listConversations(req.user.id) });
});

app.post("/api/conv", requireAuth, async (req, res) => {
  const title = (req.body && req.body.title) || undefined;
  const c = await store.createConversation(req.user.id, title);
  res.json({ ok: true, conversation: c });
});

app.patch("/api/conv/:id", requireAuth, async (req, res) => {
  const c = await store.renameConversation(req.params.id, req.user.id, (req.body || {}).title || "");
  if (!c) return res.status(404).json({ ok: false, error: "会话不存在" });
  res.json({ ok: true, conversation: c });
});

app.delete("/api/conv/:id", requireAuth, async (req, res) => {
  const ok = await store.deleteConversation(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ ok: false, error: "会话不存在" });
  res.json({ ok: true });
});

app.get("/api/conv/:id/messages", requireAuth, async (req, res) => {
  const msgs = await store.listMessages(req.params.id, req.user.id);
  if (msgs === null) return res.status(404).json({ ok: false, error: "会话不存在" });
  res.json({ ok: true, messages: msgs });
});

app.post("/api/conv/:id/messages", requireAuth, async (req, res) => {
  const c = await store.getConversation(req.params.id);
  if (!c || c.userId !== req.user.id) return res.status(404).json({ ok: false, error: "会话不存在" });
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const saved = [];
  for (const it of items.slice(0, 50)) {
    if (!it || typeof it.src !== "string" || typeof it.tgt !== "string") continue;
    saved.push(
      await store.addMessage({
        convId: c.id,
        userId: req.user.id,
        src: it.src.slice(0, 2000),
        tgt: it.tgt.slice(0, 4000),
        fromLang: it.fromLang || null,
        toLang: it.toLang || null,
        engine: it.engine || null,
      })
    );
  }
  res.json({ ok: true, saved: saved.length, ids: saved.map((m) => m.id) });
});

/** 修正重译：更新某条消息的原文/译文 */
app.patch("/api/conv/:id/messages/:msgId", requireAuth, async (req, res) => {
  const c = await store.getConversation(req.params.id);
  if (!c || c.userId !== req.user.id) return res.status(404).json({ ok: false, error: "会话不存在" });
  const { src, tgt, fromLang, toLang, engine } = req.body || {};
  if (typeof src !== "string" || typeof tgt !== "string") {
    return res.status(400).json({ ok: false, error: "src/tgt required" });
  }
  const ok = await store.updateMessage(req.params.msgId, req.user.id, {
    src: src.slice(0, 2000),
    tgt: tgt.slice(0, 4000),
    fromLang: fromLang || null,
    toLang: toLang || null,
    engine: engine || null,
  });
  if (!ok) return res.status(404).json({ ok: false, error: "消息不存在" });
  res.json({ ok: true });
});

/* ---------------------------- 管理员 API ---------------------------- */
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const users = [];
  for (const u of await store.listUsers()) {
    users.push({ ...u, ...(await store.usage(u.id)) });
  }
  res.json({ ok: true, users });
});

app.post("/api/admin/users/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const status = (req.body || {}).status;
  if (!["active", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ ok: false, error: "非法状态" });
  }
  const u = await store.setUserStatus(req.params.id, status);
  if (!u) return res.status(404).json({ ok: false, error: "用户不存在" });
  res.json({ ok: true, user: publicUser(u) });
});

app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  res.json({ ok: true, stats: await store.stats() });
});

app.get("/api/admin/usage/:userId", requireAuth, requireAdmin, async (req, res) => {
  const u = await store.getUserById(req.params.userId);
  if (!u) return res.status(404).json({ ok: false, error: "用户不存在" });
  res.json({
    ok: true,
    user: publicUser(u),
    usage: await store.usage(u.id),
    conversations: await store.listConversations(u.id),
  });
});

app.get("/api/admin/conversations/:convId", requireAuth, requireAdmin, async (req, res) => {
  const c = await store.getConversation(req.params.convId);
  if (!c) return res.status(404).json({ ok: false, error: "会话不存在" });
  const owner = await store.getUserById(c.userId);
  res.json({
    ok: true,
    conversation: c,
    owner: owner ? publicUser(owner) : null,
    messages: await store.getMessagesByConv(c.id),
  });
});

/* ------------------------------------------------------------------ *
 * 翻译引擎（Bing 优先，Google/MyMemory/有道降级）
 * ------------------------------------------------------------------ */
const LANG_MAP_GOOGLE = {
  "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en", ja: "ja", ko: "ko", fr: "fr",
  de: "de", es: "es", ru: "ru", ar: "ar", pt: "pt", it: "it", th: "th", vi: "vi",
};

const LANG_MAP_MYMEMORY = {
  "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-GB", ja: "ja-JP", ko: "ko-KR",
  fr: "fr-FR", de: "de-DE", es: "es-ES", ru: "ru-RU", ar: "ar-SA", pt: "pt-PT",
  it: "it-IT", th: "th-TH", vi: "vi-VN",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BING_LANG = {
  "zh-CN": "zh-Hans", "zh-TW": "zh-Hant", en: "en", ja: "ja", ko: "ko", fr: "fr",
  de: "de", es: "es", ru: "ru", ar: "ar", pt: "pt", it: "it", th: "th", vi: "vi",
};
const BING_LANG_REVERSE = Object.fromEntries(Object.entries(BING_LANG).map(([k, v]) => [v, k]));
const BING_HOSTS = ["www.bing.com", "cn.bing.com"];
let bingCred = null;

async function googleTranslate(text, from, to) {
  const sl = LANG_MAP_GOOGLE[from] || "auto";
  const tl = LANG_MAP_GOOGLE[to] || to;
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error("google " + res.status);
  const data = await res.json();
  const out = (data?.[0] || []).map((seg) => seg?.[0] || "").join("");
  if (!out) throw new Error("google empty");
  return { text: out, engine: "google" };
}

async function myMemoryTranslate(text, from, to) {
  const src = LANG_MAP_MYMEMORY[from] || from;
  const tgt = LANG_MAP_MYMEMORY[to] || to;
  const params = new URLSearchParams({ q: text.slice(0, 480), langpair: `${src}|${tgt}` });
  const res = await fetch("https://api.mymemory.translated.net/get?" + params, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error("mymemory " + res.status);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error("mymemory quota");
  return { text: out, engine: "mymemory" };
}

async function youdaoTranslate(text, from, to) {
  const map = { "zh-CN": "zh-CHS", "zh-TW": "zh-CHT", en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es", ru: "ru" };
  const params = new URLSearchParams({ q: text, from: map[from] || "auto", to: map[to] || to });
  const res = await fetch("https://fanyi.youdao.com/translate?doctype=json&type=AUTO&" + params, {
    signal: AbortSignal.timeout(3500),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error("youdao " + res.status);
  const data = await res.json();
  const out = (data?.translateResult?.[0] || []).map((s) => s.tgt).join("");
  if (!out) throw new Error("youdao empty");
  return { text: out, engine: "youdao" };
}

async function refreshBingCred(host) {
  const res = await fetch(`https://${host}/translator`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error("bing page " + res.status);
  const cookies = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const html = await res.text();
  const ig = (html.match(/IG:"([0-9A-F]+)"/) || [])[1];
  const m = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),"([^"]+)"/);
  if (!ig || !m) throw new Error("bing cred parse failed");
  bingCred = { ig, key: m[1], token: m[2], ts: Date.now(), host, cookies };
  return bingCred;
}

async function bingTranslate(text, from, to) {
  if (!bingCred || Date.now() - bingCred.ts > 12 * 60 * 1000) {
    await refreshBingCred(BING_HOSTS[0]);
  }
  const tgt = BING_LANG[to] || to;
  const src = from === "auto" ? "auto-detect" : BING_LANG[from] || from;

  const doPost = async () => {
    const body = new URLSearchParams({
      fromLang: src, to: tgt, text,
      token: bingCred.token, key: bingCred.key,
    });
    const r = await fetch(
      `https://${bingCred.host}/ttranslatev3?isVertical=1&IG=${bingCred.ig}&IID=translator.5023.1`,
      {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Referer: `https://${bingCred.host}/translator`,
          Origin: `https://${bingCred.host}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(bingCred.cookies ? { Cookie: bingCred.cookies } : {}),
        },
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(7000),
      }
    );
    return r.json();
  };

  let data = await doPost();
  if (!data?.[0]?.translations && (data?.statusCode === 400 || data?.ShowCaptcha || data?.length === 0)) {
    const next = BING_HOSTS[(BING_HOSTS.indexOf(bingCred.host) + 1) % BING_HOSTS.length];
    await refreshBingCred(next);
    data = await doPost();
  }
  const out = data?.[0]?.translations?.[0]?.text;
  if (!out) throw new Error("bing empty " + JSON.stringify(data).slice(0, 80));
  const detected = data?.[0]?.detectedLanguage?.language;
  return { text: out, engine: "bing", detected: detected ? BING_LANG_REVERSE[detected] || detected : undefined };
}

function detectLang(text) {
  const t = text.trim();
  if (!t) return "en";
  if (/[\u3040-\u30ff]/.test(t)) return "ja";
  if (/[\uac00-\ud7af]/.test(t)) return "ko";
  if (/[\u0400-\u04ff]/.test(t)) return "ru";
  if (/[\u0600-\u06ff]/.test(t)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(t)) return "th";
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[a-zA-Z]/g) || []).length;
  if (cjk > 0 && latin >= 4 && latin / (cjk + latin) > 0.25) return "mixed";
  if (cjk > 0) {
    if (/[這個說話們時來對開關門長東車馬鳥語髮後裡見聽覺買賣錢紙書學體點餐廳]/.test(t)) return "zh-TW";
    return "zh-CN";
  }
  if (/[\u00e0-\u00ff]/.test(t)) {
    if (/[ãõâêôç]/i.test(t)) return "pt";
    return "fr";
  }
  if (/[äöüß]/i.test(t)) return "de";
  if (/[áéíóúñ¿¡]/i.test(t)) return "es";
  return "en";
}

const ENGINES = {
  bing: bingTranslate,
  google: googleTranslate,
  youdao: youdaoTranslate,
  mymemory: myMemoryTranslate,
};

const cache = new Map();
const CACHE_MAX = 800;

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > 30 * 60 * 1000) { cache.delete(key); return null; }
  cache.delete(key);
  cache.set(key, v);
  return v;
}
function cacheSet(key, val) {
  cache.set(key, { ...val, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

app.post("/api/translate", (req, res) => {
  const { text, from = "auto", to = "zh-CN", engine = "auto" } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ ok: false, error: "text required" });
  }
  const clean = text.trim().slice(0, 2000);
  const ck = `${from}|${to}|${clean}`;

  const hit = cacheGet(ck);
  if (hit) return res.json({ ok: true, ...hit, cached: true });

  const resolvedFrom = from === "auto" ? detectLang(clean) : from;

  if (resolvedFrom === "mixed") {
    bingTranslate(clean, "auto", to)
      .then((r) => {
        const payload = { text: r.text, engine: r.engine, detected: "mixed" };
        cacheSet(ck, { ...payload });
        res.json({ ok: true, ...payload });
      })
      .catch(() => doTranslate(res, clean, resolvedFrom, to, engine, ck));
    return;
  }

  if (resolvedFrom === to) {
    return res.json({ ok: true, text: clean, engine: "passthrough", detected: resolvedFrom, skipped: true });
  }

  doTranslate(res, clean, resolvedFrom, to, engine, ck);
});

async function doTranslate(res, clean, resolvedFrom, to, engine, ck) {
  const order =
    engine === "auto"
      ? ["bing", "google", "mymemory", "youdao"]
      : engine === "mymemory"
        ? ["mymemory", "bing"]
        : [engine, "bing", "mymemory"];

  const errors = [];
  for (const name of order) {
    const fn = ENGINES[name];
    if (!fn) continue;
    try {
      const srcArg = name === "bing" ? "auto" : resolvedFrom === "mixed" ? "zh-CN" : resolvedFrom;
      const r = await fn(clean, srcArg, to);
      const payload = { text: r.text, engine: r.engine, detected: r.detected || resolvedFrom };
      cacheSet(ck, { ...payload });
      return res.json({ ok: true, ...payload });
    } catch (e) {
      errors.push(`${name}:${e.message}`);
    }
  }
  res.status(502).json({ ok: false, error: "all engines failed", detail: errors });
}

/* ---------------------------- 基础 ---------------------------- */
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, () => console.log(`LiveTranslate listening on :${PORT}`));
