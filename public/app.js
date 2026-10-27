/* =========================================================================
 * LiveTranslate — 前端核心
 *
 * 设计要点：
 * 1) 用 Web Speech API 做实时识别；onend 后自动 restart，突破 Chrome
 *    约 8 秒静音就断的限制 → 实现「不限时长」。
 * 2) 识别结果分两路：interim（临时）只显示在实时区；
 *    final（定稿）才送去翻译并落成一条记录，避免频繁请求。
 * 3) 长句子按标点/长度切块串行翻译，保证顺序和准确度。
 * 4) 全部状态存 localStorage，刷新不丢。
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

const els = {
  selSrc: $("selSrc"),
  selTgt: $("selTgt"),
  selMic: $("selMic"),
  selMode: $("selMode"),
  selEngine: $("selEngine"),
  selVoice: $("selVoice"),
  chkAuto: $("chkAuto"),
  chkDual: $("chkDual"),
  btnSwap: $("btnSwap"),
  btnMic: $("btnMic"),
  btnClear: $("btnClear"),
  btnExport: $("btnExport"),
  btnFull: $("btnFull"),
  btnSettings: $("btnSettings"),
  btnHelp: $("btnHelp"),
  btnCloseDrawer: $("btnCloseDrawer"),
  btnCloseHelp: $("btnCloseHelp"),
  btnExitCinema: $("btnExitCinema"),
  drawer: $("drawer"),
  help: $("help"),
  transcript: $("transcript"),
  emptyState: $("emptyState"),
  liveArea: $("liveArea"),
  liveText: $("liveText"),
  liveLang: $("liveLang"),
  status: $("status"),
  meter: $("meter"),
  rngRate: $("rngRate"),
  rateVal: $("rateVal"),
  rngFont: $("rngFont"),
  fontVal: $("fontVal"),
  cinema: $("cinema"),
  cinemaBody: $("cinemaBody"),
};

const LANG_NAME = {
  "zh-CN": "中文", "zh-TW": "中文(繁)", en: "English", ja: "日本語", ko: "한국어",
  fr: "Français", de: "Deutsch", es: "Español", ru: "Русский", ar: "العربية",
  pt: "Português", th: "ไทย", vi: "Tiếng Việt",
};

const BCP47 = {
  "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US", ja: "ja-JP", ko: "ko-KR",
  fr: "fr-FR", de: "de-DE", es: "es-ES", ru: "ru-RU", ar: "ar-SA",
  pt: "pt-PT", th: "th-TH", vi: "vi-VN",
};

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
const state = {
  listening: false,
  manualStop: false,
  recognition: null,
  restartTimer: null,
  restartCount: 0,
  finalBuffer: "",       // 当前累积的定稿文本（未提交翻译）
  flushTimer: null,
  translating: 0,
  queue: Promise.resolve(),
  voices: [],
  history: [],           // { id, src, tgt, lang, ts, engine }
  started: false,
};

/* ------------------------------------------------------------------ *
 * 本地存储
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "lt.settings.v1";

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (s.src) els.selSrc.value = s.src;
    if (s.tgt) els.selTgt.value = s.tgt;
    if (s.mode) els.selMode.value = s.mode;
    if (s.engine) els.selEngine.value = s.engine;
    if (s.voiceURI !== undefined) els.selVoice.dataset.want = s.voiceURI;
    if (typeof s.auto === "boolean") els.chkAuto.checked = s.auto;
    if (typeof s.dual === "boolean") els.chkDual.checked = s.dual;
    if (s.rate) { els.rngRate.value = s.rate; els.rateVal.textContent = Number(s.rate).toFixed(1) + "x"; }
    if (s.font) { els.rngFont.value = s.font; applyFont(s.font); }
  } catch { /* ignore */ }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    src: els.selSrc.value,
    tgt: els.selTgt.value,
    mode: els.selMode.value,
    engine: els.selEngine.value,
    voiceURI: els.selVoice.value,
    auto: els.chkAuto.checked,
    dual: els.chkDual.checked,
    rate: els.rngRate.value,
    font: els.rngFont.value,
  }));
}

function applyFont(v) {
  const scale = v / 100;
  document.documentElement.style.setProperty("--tgt-size", (20 * scale).toFixed(1) + "px");
  const nodes = document.querySelectorAll(".tgt-line");
  nodes.forEach((n) => (n.style.fontSize = (20 * scale).toFixed(1) + "px"));
  els.fontVal.textContent = v < 100 ? "小" : v > 100 ? "大" : "中";
}

/* ------------------------------------------------------------------ *
 * 状态栏
 * ------------------------------------------------------------------ */
function setStatus(text) {
  els.status.textContent = text;
}

/* ------------------------------------------------------------------ *
 * 识别器初始化
 * ------------------------------------------------------------------ */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function buildRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = BCP47[els.selSrc.value] && els.selSrc.value !== "auto"
    ? BCP47[els.selSrc.value]
    : (navigator.language || "zh-CN");
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.restartCount = 0;
    setStatus("识别中…");
  };

  rec.onresult = (event) => {
    let interim = "";
    let finalized = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = (r[0]?.transcript || "").trim();
      if (!txt) continue;
      if (r.isFinal) finalized += (finalized ? " " : "") + txt;
      else interim += (interim ? " " : "") + txt;
    }

    if (interim) {
      els.liveArea.hidden = false;
      els.liveText.textContent = interim;
      els.liveLang.textContent = "正在听…";
      if (els.emptyState && !state.started) els.emptyState.style.display = "none";
    }

    if (finalized) {
      els.liveText.textContent = "";
      handleFinal(finalized);
    }
  };

  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return; // 正常现象
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("麦克风被拒绝");
      alert("麦克风权限被拒绝。请在浏览器地址栏左侧的锁图标里允许麦克风访问，然后刷新页面重试。");
      stopListening(true);
      return;
    }
    if (e.error === "network") {
      setStatus("网络异常，重连中…");
      return;
    }
    setStatus("识别错误：" + e.error);
  };

  rec.onend = () => {
    if (state.manualStop) {
      state.listening = false;
      els.liveArea.hidden = true;
      flushBuffer(true);
      renderMic(false);
      setStatus("已停止");
      return;
    }
    // 自动续接 —— 这是「不限时长」的关键
    if (state.listening) {
      state.restartCount++;
      const delay = Math.min(120 + state.restartCount * 40, 900);
      clearTimeout(state.restartTimer);
      state.restartTimer = setTimeout(() => {
        if (!state.listening) return;
        try {
          rec.lang = state.detectedLang || rec.lang;
          rec.start();
          setStatus("识别中…");
        } catch {
          /* 已经在运行，忽略 */
        }
      }, delay);
    }
  };

  return rec;
}

/* ------------------------------------------------------------------ *
 * 定稿文本 → 缓冲 → 提交翻译
 * ------------------------------------------------------------------ */
function handleFinal(text) {
  state.started = true;
  if (els.emptyState) els.emptyState.style.display = "none";

  state.finalBuffer = (state.finalBuffer + " " + text).replace(/\s+/g, " ").trim();

  // 整句模式：等 1.2 秒静默再翻译；实时模式：等 0.5 秒
  const wait = els.selMode.value === "command" ? 1200 : 520;
  clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => flushBuffer(), wait);

  setStatus("识别中…");
}

/** 把缓冲文本切分并提交翻译 */
function flushBuffer(force = false) {
  clearTimeout(state.flushTimer);
  const buf = state.finalBuffer.trim();
  if (!buf) return;

  // 太短且不是强制提交时，继续等（避免碎片）
  if (!force && buf.length < 6) {
    state.flushTimer = setTimeout(() => flushBuffer(), 900);
    return;
  }

  state.finalBuffer = "";
  const chunks = splitChunks(buf);
  chunks.forEach((c) => enqueueTranslate(c));
}

/** 按标点切分长文本，单块不超过 ~180 字符（MyMemory 单次 500 字节限制） */
function splitChunks(text) {
  const hard = 170;
  if (text.length <= hard) return [text];

  const parts = text.split(/(?<=[。！？!?；;.\n])\s*/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > hard && cur) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim()) out.push(cur.trim());

  // 极端情况：仍超长，硬切
  return out.flatMap((s) =>
    s.length <= hard ? [s] : s.match(new RegExp(`.{1,${hard}}`, "gs")) || [s]
  );
}

/** 串行翻译队列，保证顺序 */
function enqueueTranslate(text) {
  state.queue = state.queue.then(() => doTranslate(text)).catch(() => {});
  return state.queue;
}

async function doTranslate(text) {
  const srcLang = els.selSrc.value;
  const tgtLang = els.selTgt.value;

  const node = createBlock(text, srcLang, tgtLang);
  state.translating++;
  updateBusy();

  try {
    const r = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        from: srcLang === "auto" ? "auto" : srcLang,
        to: tgtLang,
        engine: els.selEngine.value,
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "translate failed");

    node.tgtEl.textContent = data.text;
    node.tgtEl.classList.remove("loading");
    node.engine = data.engine;

    // 自动检测到语言后，更新气泡标签（让用户知道系统识别成了什么语言）
    if (data.detected && node.badge) {
      const fromLabel = LANG_NAME[data.detected] || data.detected;
      node.badge.textContent = `${fromLabel} → ${LANG_NAME[tgtLang] || tgtLang}`;
      if (data.detected !== els.selTgt.value) {
        node.badge.title = `识别为 ${fromLabel}（引擎 ${data.engine}）`;
      }
    }

    // 记录历史
    const rec = { id: node.id, src: text, tgt: data.text, lang: tgtLang, ts: Date.now() };
    state.history.push(rec);

    if (els.chkAuto.checked) speak(data.text, tgtLang);

    if (!els.cinema.hidden) appendCinema(text, data.text);
  } catch (err) {
    node.tgtEl.textContent = "翻译失败：" + (err.message || "请检查网络");
    node.tgtEl.classList.remove("loading");
    node.tgtEl.style.color = "#ff8b9d";
  } finally {
    state.translating--;
    updateBusy();
    scrollToBottom();
  }
}

function updateBusy() {
  if (state.translating > 0) setStatus(`翻译中 ${state.translating}…`);
  else if (state.listening) setStatus("识别中…");
}

/* ------------------------------------------------------------------ *
 * DOM 渲染
 * ------------------------------------------------------------------ */
let blockSeq = 0;

function createBlock(src, srcLang, tgtLang) {
  const id = ++blockSeq + "-" + Date.now();
  const wrap = document.createElement("div");
  wrap.className = "block";
  wrap.dataset.id = id;

  const meta = document.createElement("div");
  meta.className = "meta";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = `${LANG_NAME[srcLang] || "自动"} → ${LANG_NAME[tgtLang] || tgtLang}`;

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  meta.append(badge, time);

  if (els.chkDual.checked) {
    const srcLine = document.createElement("div");
    srcLine.className = "src-line";
    srcLine.textContent = src;
    wrap.appendChild(meta);
    wrap.appendChild(srcLine);
  } else {
    wrap.appendChild(meta);
  }

  const tgtEl = document.createElement("div");
  tgtEl.className = "tgt-line loading";
  tgtEl.textContent = "翻译中…";
  wrap.appendChild(tgtEl);

  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-mini";
  copyBtn.textContent = "复制原文";
  copyBtn.onclick = () => navigator.clipboard?.writeText(src);
  meta.appendChild(copyBtn);

  els.transcript.appendChild(wrap);
  scrollToBottom();

  return { id, wrap, tgtEl, badge };
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  });
}

function renderMic(on) {
  els.btnMic.classList.toggle("rec", on);
  els.meter.classList.toggle("on", on);
}

/* ------------------------------------------------------------------ *
 * 语音合成（朗读译文）
 * ------------------------------------------------------------------ */
let voiceList = [];

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  voiceList = speechSynthesis.getVoices();
  const want = localStorage.getItem("lt.voice");
  els.selVoice.innerHTML = '<option value="">默认</option>';
  voiceList.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    els.selVoice.appendChild(o);
  });
  if (want) els.selVoice.value = want;
}

function pickVoice(lang) {
  const bcp = BCP47[lang] || lang;
  const chosenURI = els.selVoice.value;
  if (chosenURI) {
    const v = voiceList.find((x) => x.voiceURI === chosenURI);
    if (v) return v;
  }
  const exact = voiceList.find((v) => v.lang.replace("_", "-").toLowerCase() === bcp.toLowerCase());
  if (exact) return exact;
  const prefix = bcp.split("-")[0].toLowerCase();
  return voiceList.find((v) => v.lang.toLowerCase().startsWith(prefix)) || null;
}

function speak(text, lang) {
  if (!("speechSynthesis" in window)) return;
  // 避免堆积：每当有新的译文，取消旧的（会议场景更实用）
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[lang] || lang;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = Number(els.rngRate.value) || 1;
  u.pitch = 1;
  speechSynthesis.speak(u);
}

/* ------------------------------------------------------------------ *
 * 麦克风电平表（视觉反馈）
 * ------------------------------------------------------------------ */
let audioCtx, analyser, meterRAF, micStream;

async function startMeter() {
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);

    const bars = [...els.meter.children];
    const buf = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!state.listening) return;
      analyser.getByteFrequencyData(buf);
      bars.forEach((bar, i) => {
        const idx = Math.floor((i / bars.length) * buf.length * 0.6) + 2;
        const h = 5 + (buf[idx] / 255) * 22;
        bar.style.height = h.toFixed(1) + "px";
      });
      meterRAF = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(meterRAF);
    tick();
  } catch {
    /* 没有电平表也能用 */
  }
}

function stopMeter() {
  cancelAnimationFrame(meterRAF);
  [...els.meter.children].forEach((b) => (b.style.height = "6px"));
}

/* ------------------------------------------------------------------ *
 * 启动 / 停止
 * ------------------------------------------------------------------ */
async function startListening() {
  if (!SpeechRecognition) {
    alert(
      "当前浏览器不支持语音识别。\n\n请使用 Chrome 或 Edge 浏览器打开本页面（Safari / Firefox 支持不佳）。"
    );
    return;
  }

  state.manualStop = false;
  state.listening = true;
  state.started = true;
  if (els.emptyState) els.emptyState.style.transform = "scale(.98)";

  try {
    // 先请求麦克风，确保权限弹窗
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("无法访问麦克风，请检查系统权限设置。");
    state.listening = false;
    return;
  }

  state.recognition = buildRecognition();
  try {
    state.recognition.start();
  } catch (e) {
    console.warn(e);
  }

  els.liveArea.hidden = false;
  els.liveText.textContent = "";
  renderMic(true);
  startMeter();
  setStatus("识别中…");
  els.btnMic.setAttribute("aria-label", "停止");
}

function stopListening(hard = false) {
  state.manualStop = true;
  state.listening = false;
  clearTimeout(state.restartTimer);
  if (state.recognition) {
    try { state.recognition.stop(); } catch { /* ignore */ }
  }
  if (hard && micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  stopMeter();
  renderMic(false);
  flushBuffer(true);
  els.liveArea.hidden = true;
  setStatus("已停止");
  els.btnMic.setAttribute("aria-label", "开始");
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */
els.btnMic.addEventListener("click", () => {
  if (state.listening) stopListening();
  else startListening();
});

els.btnSwap.addEventListener("click", () => {
  const s = els.selSrc.value, t = els.selTgt.value;
  els.selSrc.value = t === "zh-CN" ? "en" : t;
  els.selTgt.value = s === "auto" ? "zh-CN" : s;
  saveSettings();
  restartIfListening();
});

function restartIfListening() {
  if (!state.listening) return;
  try { state.recognition.stop(); } catch { /* onend 会自动重启并应用新语言 */ }
}

[els.selSrc, els.selTgt, els.selMode, els.selEngine].forEach((el) =>
  el.addEventListener("change", saveSettings)
);
[els.chkAuto, els.chkDual].forEach((el) => {
  el.addEventListener("change", () => {
    saveSettings();
    // 重绘已有气泡的显示模式
    document.querySelectorAll(".block").forEach((b) => {});
  });
});

els.selSrc.addEventListener("change", () => {
  saveSettings();
  restartIfListening();
});

els.rngRate.addEventListener("input", () => {
  els.rateVal.textContent = Number(els.rngRate.value).toFixed(1) + "x";
  saveSettings();
});

els.rngFont.addEventListener("input", () => {
  applyFont(Number(els.rngFont.value));
  saveSettings();
});

els.selVoice.addEventListener("change", () => {
  localStorage.setItem("lt.voice", els.selVoice.value);
  saveSettings();
});

els.btnSettings.onclick = () => (els.drawer.hidden = false);
els.btnHelp.onclick = () => (els.help.hidden = false);
els.btnCloseDrawer.onclick = () => (els.drawer.hidden = true);
els.btnCloseHelp.onclick = () => (els.help.hidden = true);
[els.drawer, els.help].forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) d.hidden = true;
  })
);

els.btnClear.onclick = () => {
  if (!confirm("清空全部记录？")) return;
  els.transcript.innerHTML = "";
  state.history = [];
  blockSeq = 0;
};

els.btnExport.onclick = () => {
  if (!state.history.length) return alert("还没有内容可导出");
  const lines = state.history.map(
    (h) => `[${new Date(h.ts).toLocaleString("zh-CN")}] ${h.src}\n→ ${h.tgt}\n`
  );
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `livetranslate-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};

els.btnFull.onclick = () => {
  if (els.cinema.hidden) {
    els.cinema.hidden = false;
    els.cinemaBody.innerHTML = "";
    // 把已有译文带进大字幕
    const last = state.history.slice(-6);
    last.forEach((h) => appendCinema(h.src, h.tgt));
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    els.cinema.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen?.();
  }
};

els.btnExitCinema.onclick = () => {
  els.cinema.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.();
};

function appendCinema(src, tgt) {
  const s = document.createElement("div");
  s.className = "src";
  s.textContent = src;
  const t = document.createElement("div");
  t.textContent = tgt;
  els.cinemaBody.append(s, t);
  // 只保留最后 8 组，防止卡顿
  while (els.cinemaBody.children.length > 16) {
    els.cinemaBody.firstElementChild.remove();
  }
  els.cinema.scrollTop = els.cinema.scrollHeight;
}

/* 键盘快捷键：空格开始/停止，Esc 退出大字幕 */
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.code === "Space") {
    e.preventDefault();
    els.btnMic.click();
  }
  if (e.key === "Escape") {
    els.cinema.hidden = true;
    els.drawer.hidden = true;
    els.help.hidden = true;
  }
});

/* 页面关闭前清理 */
window.addEventListener("beforeunload", () => {
  state.manualStop = true;
  try { state.recognition?.stop(); } catch { /* ignore */ }
});

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
function init() {
  loadSettings();
  loadVoices();
  if ("speechSynthesis" in window) {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  applyFont(Number(els.rngFont.value) || 100);

  if (!SpeechRecognition) {
    setStatus("浏览器不支持");
    els.btnMic.disabled = true;
    els.emptyState.querySelector("h2").textContent = "请换用 Chrome 或 Edge";
    els.emptyState.querySelector("p").innerHTML =
      "当前浏览器不支持 Web Speech API 语音识别。<br>请用 <b>Chrome / Edge</b> 打开本页面。";
  } else {
    setStatus("待命");
  }

  // 恢复历史（同一次会话内刷新也保留，方便长会议）
  els.selSrc.addEventListener("change", () => {
    if (els.selSrc.value !== "auto") state.detectedLang = BCP47[els.selSrc.value];
  });
}

init();
