import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* ------------------------------------------------------------------ *
 * 翻译引擎
 * 所有引擎都是「免费 / 无需用户自己申请 Key」的公共接口。
 * 按优先级依次尝试，失败自动降级，保证被墙或限流时依然能用。
 * ------------------------------------------------------------------ */

const LANG_MAP_GOOGLE = {
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  en: "en",
  ja: "ja",
  ko: "ko",
  fr: "fr",
  de: "de",
  es: "es",
  ru: "ru",
  ar: "ar",
  pt: "pt",
  it: "it",
  th: "th",
  vi: "vi",
};

const LANG_MAP_MYMEMORY = {
  "zh-CN": "zh-CN",
  "zh-TW": "zh-TW",
  en: "en-GB",
  ja: "ja-JP",
  ko: "ko-KR",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  ru: "ru-RU",
  ar: "ar-SA",
  pt: "pt-PT",
  it: "it-IT",
  th: "th-TH",
  vi: "vi-VN",
};

/** 谷歌翻译免费端点（大陆网络通常不可达，作为第一优先，超时 2.5s） */
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

/** MyMemory 公共接口：完全免费，匿名每天 5000 字符，带 email 可到 50000 字符/天 */
async function myMemoryTranslate(text, from, to, email) {
  const src = LANG_MAP_MYMEMORY[from] || from;
  const tgt = LANG_MAP_MYMEMORY[to] || to;
  const params = new URLSearchParams({
    q: text.slice(0, 480), // 单次 500 字节上限，分段在客户端完成
    langpair: `${src}|${tgt}`,
  });
  if (email) params.set("de", email);
  const res = await fetch("https://api.mymemory.translated.net/get?" + params, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error("mymemory " + res.status);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error("mymemory quota");
  return { text: out, engine: "mymemory" };
}

/** 有道免费端点（国内可达性好），失败静默 */
async function youdaoTranslate(text, from, to) {
  const map = { "zh-CN": "zh-CHS", "zh-TW": "zh-CHT", en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es", ru: "ru" };
  const params = new URLSearchParams({
    q: text,
    from: map[from] || "auto",
    to: map[to] || to,
  });
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

/* ------------------------------------------------------------------ *
 * Bing（微软翻译）公共 Web 接口
 * 优点：无需 API Key、国内可直连、自带语言检测、质量接近 GPT 级
 * 实现：先 GET /translator 拿到 IG + 反滥用 token，再 POST /ttranslatev3
 * ------------------------------------------------------------------ */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BING_LANG = {
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
  en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es",
  ru: "ru", ar: "ar", pt: "pt", it: "it", th: "th", vi: "vi",
};
const BING_LANG_REVERSE = Object.fromEntries(
  Object.entries(BING_LANG).map(([k, v]) => [v, k])
);

let bingCred = null; // { ig, token, key, ts, host, cookies }

/* 国内 IP 用 cn.bing.com，海外 IP 用 www.bing.com；自动探测切换 */
const BING_HOSTS = ["www.bing.com", "cn.bing.com"];

async function refreshBingCred(host) {
  const res = await fetch(`https://${host}/translator`, {
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error("bing page " + res.status);
  // 海外 IP 必须带 Cookie 才能调用 ttranslatev3
  const cookies = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(";")[0])
    .join("; ");
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
      fromLang: src,
      to: tgt,
      text,
      token: bingCred.token,
      key: bingCred.key,
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
  // token 过期或空响应 → 换主机 + 刷新凭据重试
  if (!data?.[0]?.translations && (data?.statusCode === 400 || data?.ShowCaptcha || data?.length === 0)) {
    const next =
      BING_HOSTS[(BING_HOSTS.indexOf(bingCred.host) + 1) % BING_HOSTS.length];
    await refreshBingCred(next);
    data = await doPost();
  }
  const out = data?.[0]?.translations?.[0]?.text;
  if (!out) throw new Error("bing empty " + JSON.stringify(data).slice(0, 80));

  const detected = data?.[0]?.detectedLanguage?.language;
  return {
    text: out,
    engine: "bing",
    detected: detected ? BING_LANG_REVERSE[detected] || detected : undefined,
  };
}

/** 简单语言检测：自动模式下用。基于 Unicode 区段 + 常见特征词 */
function detectLang(text) {
  const t = text.trim();
  if (!t) return "en";
  // 日文假名优先于汉字
  if (/[\u3040-\u30ff]/.test(t)) return "ja";
  if (/[\uac00-\ud7af]/.test(t)) return "ko";
  if (/[\u0400-\u04ff]/.test(t)) return "ru";
  if (/[\u0600-\u06ff]/.test(t)) return "ar";
  if (/[\u0e00-\u0e7f]/.test(t)) return "th";
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.match(/[a-zA-Z]/g) || []).length;
  // 中英混合：返回 mixed，由支持 auto-detect 的引擎整体处理（不能直通）
  if (cjk > 0 && latin >= 4 && latin / (cjk + latin) > 0.25) return "mixed";
  if (cjk > 0) {
    // 繁体特征字
    if (/[這個說話們時來對開關門長東車馬鳥語髮後裡見聽覺買賣錢紙書學體點餐廳]/.test(t)) return "zh-TW";
    return "zh-CN";
  }
  if (/[\u00e0-\u00ff]/.test(t)) {
    // 西欧带音符：粗分法/葡
    if (/[ãõâêôç]/i.test(t)) return "pt";
    return "fr";
  }
  if (/[äöüß]/i.test(t)) return "de";
  if (/[áéíóúñ¿¡]/i.test(t)) return "es";
  return "en";
}const ENGINES = {
  bing: bingTranslate,
  google: googleTranslate,
  youdao: youdaoTranslate,
  mymemory: (t, f, to) => myMemoryTranslate(t, f, to, process.env.MYMEMORY_EMAIL),
};

/* ---------------- 翻译缓存：同样的句子不重复请求 ---------------- */
const cache = new Map();
const CACHE_MAX = 800;

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > 30 * 60 * 1000) { cache.delete(key); return null; }
  cache.delete(key); // LRU 提升
  cache.set(key, v);
  return v;
}

function cacheSet(key, val) {
  cache.set(key, { ...val, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

app.post("/api/translate", async (req, res) => {
  const { text, from = "auto", to = "zh-CN", engine = "auto" } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ ok: false, error: "text required" });
  }

  const clean = text.trim().slice(0, 2000);
  const ck = `${from}|${to}|${clean}`;

  // 缓存命中（同样句子常说，会议场景命中率很高）
  const hit = cacheGet(ck);
  if (hit) return res.json({ ok: true, ...hit, cached: true });

  // 自动模式下先本地检测语言，让不支持 auto 的引擎也能工作
  const resolvedFrom = from === "auto" ? detectLang(clean) : from;

  // 中英混合：不能直通，交给支持 auto-detect 的引擎整体处理
  if (resolvedFrom === "mixed") {
    try {
      const r = await bingTranslate(clean, "auto", to);
      const payload = { text: r.text, engine: r.engine, detected: "mixed" };
      cacheSet(ck, { ...payload });
      return res.json({ ok: true, ...payload });
    } catch (e) {
      // 降级：按主语言（CJK 居多判中文）再走常规链路
    }
  }

  // 源语言 == 目标语言：直接返回原文，不浪费请求（中文对中文场景）
  if (resolvedFrom === to) {
    return res.json({
      ok: true,
      text: clean,
      engine: "passthrough",
      detected: resolvedFrom,
      skipped: true,
    });
  }

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
      // bing 支持原生 auto-detect；mixed 时强制用 bing（上面已处理，走到这里说明 bing 挂了）
      // 其他引擎传本地检测结果；mixed 时降级为按 CJK 判定
      const srcArg =
        name === "bing" ? from : resolvedFrom === "mixed" ? "zh-CN" : resolvedFrom;
      const r = await fn(clean, srcArg, to);
      const payload = {
        text: r.text,
        engine: r.engine,
        detected: r.detected || (from === "auto" ? resolvedFrom : undefined),
      };
      cacheSet(ck, { ...payload });
      return res.json({ ok: true, ...payload });
    } catch (e) {
      errors.push(`${name}:${e.message}`);
    }
  }
  res.status(502).json({ ok: false, error: "all engines failed", detail: errors });
});

/** 健康检查 */
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/** 前端路由兜底 */
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, () => console.log(`LiveTranslate listening on :${PORT}`));
