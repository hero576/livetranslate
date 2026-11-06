/* =========================================================================
 * LiveTranslate 前端
 * 登录/注册 + 会话管理（新建/改名/切换/恢复）+ 实时同步 + 后台管理
 * ========================================================================= */

const $ = (id) => document.getElementById(id);

/* ---------------------------- 常量 ---------------------------- */
const API = ""; // 同源
const LANG_NAME = {
  "zh-CN": "中文", "zh-TW": "中文(繁)", en: "English", ja: "日本語", ko: "한국어",
  fr: "Français", de: "Deutsch", es: "Español", ru: "Русский", yue: "粤语",
  mixed: "中英混合",
};

/* 识别语言 → BCP47（浏览器语音识别用） */
const BCP47 = {
  "zh-CN": "zh-CN", "zh-TW": "zh-TW", yue: "yue-Hant-HK", en: "en-US",
  ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES", ru: "ru-RU",
};

const els = {
  authOverlay: $("authOverlay"), authForm: $("authForm"), authUser: $("authUser"),
  authPass: $("authPass"), authMsg: $("authMsg"), authSubmit: $("authSubmit"),
  authHint: $("authHint"), tabLogin: $("tabLogin"), tabRegister: $("tabRegister"),
  pwdOverlay: $("pwdOverlay"), pwdForm: $("pwdForm"), pwdNew1: $("pwdNew1"),
  pwdNew2: $("pwdNew2"), pwdMsg: $("pwdMsg"), pwdSubmit: $("pwdSubmit"),
  app: $("app"), btnAdmin: $("btnAdmin"), btnSettings: $("btnSettings"), btnHelp: $("btnHelp"),
  btnLogout: $("btnLogout"), userAvatar: $("userAvatar"), userName: $("userName"),
  sidebar: $("sidebar"), convList: $("convList"), btnNewConv: $("btnNewConv"),
  selSrc: $("selSrc"), selTgt: $("selTgt"), selAsr: $("selAsr"), selMode: $("selMode"), selEngine: $("selEngine"),
  selVoice: $("selVoice"), chkAuto: $("chkAuto"), chkDual: $("chkDual"),
  btnSwap: $("btnSwap"), btnMic: $("btnMic"), btnClear: $("btnClear"), btnExport: $("btnExport"),
  btnFull: $("btnFull"), txtInput: $("txtInput"), btnSend: $("btnSend"),
  transcript: $("transcript"), emptyState: $("emptyState"), liveArea: $("liveArea"),
  liveText: $("liveText"), liveLang: $("liveLang"), status: $("status"),
  drawer: $("drawer"), help: $("help"), btnCloseDrawer: $("btnCloseDrawer"), btnCloseHelp: $("btnCloseHelp"),
  rngRate: $("rngRate"), rateVal: $("rateVal"), rngFont: $("rngFont"), fontVal: $("fontVal"),
  selTheme: $("selTheme"), accName: $("accName"), pwCur: $("pwCur"), pwNew: $("pwNew"),
  pwNew2: $("pwNew2"), pwMsg: $("pwMsg"), btnChangePw: $("btnChangePw"),
  adminPanel: $("adminPanel"), adminBody: $("adminBody"), btnCloseAdmin: $("btnCloseAdmin"),
  cinema: $("cinema"), cinemaBody: $("cinemaBody"), btnExitCinema: $("btnExitCinema"),
};

/* ---------------------------- 状态 ---------------------------- */
const state = {
  token: localStorage.getItem("lt.token") || null,
  user: null,
  authMode: "login",
  convs: [],
  currentConvId: null,
  listening: false,
  manualStop: false,
  recognition: null,
  restartTimer: null,
  pauseTimer: null,
  translating: 0,
  queue: Promise.resolve(),
  voices: [],
  started: false,
  /* 识别控制器状态（见 docs/asr/v2.0.1-recognition-integrity.md）
     phase: idle | starting | listening | restart_wait | stopping | stopped
     failures: 连续出错次数（决定退避时长，收到识别结果后清零）
     downSince/downReason: 当前这次识别中断从何时开始、因为什么 */
  asr: { phase: "idle", failures: 0, downSince: 0, downReason: "", startWatchdog: null, stopFallback: null },
  srv: null,          // 服务端识别会话（麦克风 + AudioWorklet + WebSocket）
  asrServer: false,   // 服务端识别是否可用（/api/asr/status）
  provisional: null, // 当前临时气泡（interim 的先行翻译，等 final 原地替换）
};

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ---------------------------- API 封装 ---------------------------- */
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const res = await fetch(API + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401) {
    doLogout(false);
    throw new Error("未登录");
  }
  if (!res.ok) throw new Error((data && data.error) || "请求失败");
  return data;
}

/* ---------------------------- 认证 ---------------------------- */
function setAuthMode(mode) {
  state.authMode = mode;
  els.tabLogin.classList.toggle("active", mode === "login");
  els.tabRegister.classList.toggle("active", mode === "register");
  els.authSubmit.textContent = mode === "login" ? "登录" : "注册";
  els.authHint.textContent = mode === "login" ? "没有账号？注册后需管理员审批。" : "已有账号？直接登录。";
  els.authMsg.textContent = "";
}

els.tabLogin.onclick = () => setAuthMode("login");
els.tabRegister.onclick = () => setAuthMode("register");

els.authForm.onsubmit = async (e) => {
  e.preventDefault();
  const username = els.authUser.value.trim();
  const password = els.authPass.value;
  if (!username || !password) { els.authMsg.textContent = "请输入用户名和密码"; return; }
  els.authSubmit.disabled = true;
  els.authMsg.textContent = state.authMode === "login" ? "登录中…" : "注册中…";
  try {
    if (state.authMode === "login") {
      const d = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      state.token = d.token;
      localStorage.setItem("lt.token", d.token);
      state.user = d.user;
      if (d.mustChangePassword) showForcePwd();
      else enterApp();
    } else {
      const d = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
      els.authMsg.textContent = "✅ " + (d.message || "注册成功") + "，请等待管理员审批后登录。";
      setAuthMode("login");
    }
  } catch (err) {
    els.authMsg.textContent = "⚠️ " + err.message;
  } finally {
    els.authSubmit.disabled = false;
  }
};

function doLogout(redirect = true) {
  api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.token = null;
  state.user = null;
  localStorage.removeItem("lt.token");
  if (redirect) showAuth();
}

els.btnLogout.onclick = () => doLogout();

async function initAuth() {
  if (!state.token) return showAuth();
  try {
    const d = await api("/api/auth/me");
    state.user = d.user;
    if (d.mustChangePassword) showForcePwd();
    else enterApp();
  } catch {
    showAuth();
  }
}

function showAuth() {
  els.app.hidden = true;
  els.authOverlay.hidden = false;
  els.pwdOverlay.hidden = true;
  setAuthMode("login");
}

/* 强制修改初始密码：登录后若标记了 mustChangePassword 则弹出 */
function showForcePwd() {
  els.authOverlay.hidden = true;
  els.app.hidden = true;
  els.pwdOverlay.hidden = false;
  els.pwdNew1.value = els.pwdNew2.value = "";
  els.pwdMsg.textContent = "";
}

els.pwdForm.onsubmit = async (e) => {
  e.preventDefault();
  const next = els.pwdNew1.value, next2 = els.pwdNew2.value;
  if (!next || next.length < 6) { els.pwdMsg.textContent = "⚠️ 新密码至少 6 位"; return; }
  if (next !== next2) { els.pwdMsg.textContent = "⚠️ 两次输入的新密码不一致"; return; }
  els.pwdSubmit.disabled = true;
  els.pwdMsg.textContent = "保存中…";
  try {
    await api("/api/auth/password", { method: "POST", body: JSON.stringify({ next }) });
    els.pwdOverlay.hidden = true;
    els.pwdNew1.value = els.pwdNew2.value = "";
    enterApp();
  } catch (err) {
    els.pwdMsg.textContent = "⚠️ " + err.message;
  } finally {
    els.pwdSubmit.disabled = false;
  }
};

function enterApp() {
  els.authOverlay.hidden = true;
  els.app.hidden = false;
  els.userName.textContent = state.user.username;
  els.accName.textContent = state.user.username;
  els.userAvatar.textContent = state.user.username.slice(0, 1).toUpperCase();
  if (state.user.role === "admin") els.btnAdmin.hidden = false;
  loadConversations();
  loadAsrStatus();
}

/* ---------------------------- 会话管理 ---------------------------- */
async function loadConversations() {
  try {
    const d = await api("/api/conv");
    state.convs = d.conversations;
    renderConvList();
    if (state.convs.length > 0) {
      selectConversation(state.convs[0].id);
    } else {
      // 自动新建一个「对话1」
      await ensureConversation();
    }
  } catch (e) {
    setStatus("加载会话失败: " + e.message);
  }
}

function renderConvList() {
  els.convList.innerHTML = "";
  if (!state.convs.length) {
    els.convList.innerHTML = '<div class="conv-empty">暂无对话</div>';
    return;
  }
  state.convs.forEach((c) => {
    const item = document.createElement("div");
    item.className = "conv-item" + (c.id === state.currentConvId ? " active" : "");
    item.dataset.id = c.id;

    const title = document.createElement("div");
    title.className = "conv-title";
    title.textContent = c.title;

    const count = document.createElement("span");
    count.className = "conv-count";
    count.textContent = c.msgCount || 0;

    const actions = document.createElement("div");
    actions.className = "conv-actions";
    const renameBtn = document.createElement("button");
    renameBtn.className = "conv-btn"; renameBtn.textContent = "✎"; renameBtn.title = "重命名";
    renameBtn.onclick = (ev) => { ev.stopPropagation(); renameConv(c); };
    const delBtn = document.createElement("button");
    delBtn.className = "conv-btn"; delBtn.textContent = "✕"; delBtn.title = "删除";
    delBtn.onclick = (ev) => { ev.stopPropagation(); deleteConv(c); };
    actions.append(renameBtn, delBtn);

    item.append(title, count, actions);
    item.onclick = () => selectConversation(c.id);
    els.convList.appendChild(item);
  });
}

async function selectConversation(id) {
  state.currentConvId = id;
  renderConvList();
  els.transcript.innerHTML = "";
  try {
    const d = await api(`/api/conv/${id}/messages`);
    d.messages.forEach((m) => renderMessage(m));
    if (!d.messages.length) {
      els.emptyState.style.display = "";
    } else {
      els.emptyState.style.display = "none";
    }
    scrollToBottom();
  } catch (e) {
    setStatus("加载对话失败: " + e.message);
  }
}

async function ensureConversation() {
  if (state.currentConvId) return state.currentConvId;
  const d = await api("/api/conv", { method: "POST", body: JSON.stringify({}) });
  state.convs.unshift(d.conversation);
  state.currentConvId = d.conversation.id;
  renderConvList();
  return d.conversation.id;
}

els.btnNewConv.onclick = async () => {
  try {
    await ensureConversation();
    // 强制新建一个全新对话
    const d = await api("/api/conv", { method: "POST", body: JSON.stringify({}) });
    state.convs.unshift(d.conversation);
    state.currentConvId = d.conversation.id;
    renderConvList();
    els.transcript.innerHTML = "";
    els.emptyState.style.display = "";
  } catch (e) { setStatus(e.message); }
};

function renameConv(c) {
  const name = prompt("对话名称：", c.title);
  if (!name || name === c.title) return;
  api(`/api/conv/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: name }) })
    .then(() => loadConversations())
    .catch((e) => setStatus(e.message));
}

function deleteConv(c) {
  if (!confirm(`删除「${c.title}」？其中的翻译记录也会删除。`)) return;
  api(`/api/conv/${c.id}`, { method: "DELETE" })
    .then(() => {
      if (state.currentConvId === c.id) {
        state.currentConvId = null;
        els.transcript.innerHTML = "";
      }
      loadConversations();
    })
    .catch((e) => setStatus(e.message));
}

/* ---------------------------- 消息同步 ---------------------------- */
async function syncMessage(m) {
  const id = await ensureConversation();
  const d = await api(`/api/conv/${id}/messages`, { method: "POST", body: JSON.stringify(m) });
  return d.ids && d.ids[0] ? d.ids[0] : null;
}

/* ---------------------------- 语音识别 ---------------------------- */
/* 设计说明见 docs/asr/v2.0.1-recognition-integrity.md
   核心规则：
   1. 只有浏览器 isFinal 的结果进入正式记录（落库、朗读、大字幕）。
   2. interim 只用于「正在听」区和「临时气泡」，可以随时被修订、替换。
   3. 会话结束时浏览器没给 final 的残留 interim 不丢弃，以「待校对」写入。
   4. 识别中断（重启、出错）有状态机 + 退避，并把中断时长记录下来、显示出来。 */

/* ASR 延迟埋点：评估浏览器识别的上限（决定是否值得接入流式 ASR 引擎时看数据）
   - first   首字延迟：每次会话(重)启后，到第一个有效结果的时间
   - confirm 停顿确认延迟：final 定稿与上一个识别事件的间隔（端点检测+网络的和）
   - recover 恢复延迟：onend 到自动重启成功的间隔
   控制台输入 asrReport() 查看均值与样本数。 */
const asrMetrics = { first: [], confirm: [], recover: [], _sessStart: 0, _firstSeen: false, _lastResultAt: 0, _endAt: 0 };
function asrPush(arr, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  arr.push(Math.round(ms));
  if (arr.length > 50) arr.shift();
}
window.asrReport = function () {
  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  const gaps = asrTrace.gaps;
  const report = {
    首字延迟ms: { avg: avg(asrMetrics.first), n: asrMetrics.first.length },
    停顿确认ms: { avg: avg(asrMetrics.confirm), n: asrMetrics.confirm.length },
    恢复延迟ms: { avg: avg(asrMetrics.recover), n: asrMetrics.recover.length },
    识别中断: { 次数: gaps.length, 总时长ms: gaps.reduce((s, g) => s + g.ms, 0) },
  };
  console.table(report);
  return JSON.stringify(report);
};

/* ------------------------------------------------------------------ *
 * ASR 事件记录（追踪丢内容发生在哪一层）
 * 只在内存环形缓冲，不落库。控制台：
 *   asrEvents(n)  最近 n 条识别结果与决策（final 采纳/判重/残留/状态切换/错误）
 *   asrGaps()     本次页面内所有识别中断（开始时间、时长、原因）
 * ------------------------------------------------------------------ */
const asrTrace = { events: [], gaps: [], session: 0 };
function asrLog(e) {
  asrTrace.events.push({ t: Math.round(performance.now()), run: asrTrace.session, ...e });
  if (asrTrace.events.length > 600) asrTrace.events.shift();
}
function asrNote(kind, text = "") { asrLog({ kind, text: String(text) }); }
window.asrEvents = function (n = 30) {
  const out = asrTrace.events.slice(-n).map((e) => ({
    t: e.t, run: e.run, kind: e.kind || "result", idx: e.idx ?? "", ri: e.ri ?? "",
    final: e.isFinal ? "Y" : "", text: (e.text || "").slice(0, 60), alt: e.alts ?? "",
  }));
  console.table(out);
  return out.length;
};
window.asrGaps = function () {
  console.table(asrTrace.gaps);
  return asrTrace.gaps.length;
};

/* 识别控制器参数 */
const ASR_RESTART_DELAY = 150;   // 正常结束（静音超时等）后的重启间隔
const ASR_BACKOFF_BASE = 500;    // 连续出错时的退避起点，按 2 倍递增
const ASR_BACKOFF_MAX = 8000;    // 退避上限：最长 8 秒重试一次，避免长时间不识别
const ASR_START_TIMEOUT = 4000;  // start() 后迟迟没有 onstart 视为启动失败
const ASR_STOP_TIMEOUT = 2000;   // 手动停止后最多等最后一个 final 这么久
const GAP_NOTICE_MS = 2000;      // 超过该时长的识别中断在记录里插入提示
/* 浏览器可能把同一条 final 重复上报。判重窗口按长度区分：
   长句在短时间内被一字不差说两次的可能性很低，窗口放宽；
   「好的」「对」这类短句很可能真被连说，窗口很短，宁可偶尔重复也不吞内容。 */
const FINAL_REPEAT_LONG = 10000;
const FINAL_REPEAT_SHORT = 1500;
const FINAL_LONG_LEN = 8;

function asrSetPhase(phase, info = "") {
  state.asr.phase = phase;
  asrNote("phase", info ? `${phase} · ${info}` : phase);
}

function joinText(acc, piece) {
  const needsSpace = acc && piece && !/[\u4e00-\u9fff]$/.test(acc) && !/^[\u4e00-\u9fff]/.test(piece);
  return needsSpace ? acc + " " + piece : acc + piece;
}

function isRepeatFinal(run, txt) {
  const now = Date.now();
  run.recentFinals = run.recentFinals.filter((f) => now - f.at < FINAL_REPEAT_LONG);
  const win = txt.length >= FINAL_LONG_LEN ? FINAL_REPEAT_LONG : FINAL_REPEAT_SHORT;
  if (run.recentFinals.some((f) => f.text === txt && now - f.at < win)) return true;
  run.recentFinals.push({ text: txt, at: now });
  return false;
}

/**
 * 从事件读取「本次新定稿的 final」和「当前完整 interim」。
 *
 * - final：规范保证 resultIndex 之前的结果没有变化（早已上报过），只看 resultIndex 及之后；
 *   另有按内容 + 时间窗口的兜底判重，应对部分浏览器重复上报同一条 final。
 * - interim：每次从完整 results 重建，以最后一次上报为准（会被修订，不能增量拼接）。
 * 每个 final 单独返回，不拼接、不按前缀截断。
 */
function readSnapshot(event, run) {
  const finals = [];
  let interimText = "";
  for (let i = 0; i < event.results.length; i++) {
    const r = event.results[i];
    const txt = (r[0]?.transcript || "").trim();
    if (!txt) continue;
    if (!r.isFinal) { interimText = joinText(interimText, txt); continue; }
    if (i < event.resultIndex) continue;
    if (isRepeatFinal(run, txt)) { asrNote("final-dup", txt); continue; }
    finals.push(txt);
  }
  return { finals, interimText };
}

function buildRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = recognitionLang();
  // 多候选：部分浏览器可返回多个识别候选（asrEvents 的 alt 列可看到实际返回数量）
  rec.maxAlternatives = 3;

  /* 每次 start() 是一个识别 run：interim、判重集合都只在 run 内有效 */
  const run = { id: 0, startedAt: 0, interim: "", interimSeen: "", recentFinals: [], lastError: "" };
  rec._run = run;

  rec.onstart = () => {
    clearTimeout(state.asr.startWatchdog);
    run.id = ++asrTrace.session;
    run.interim = "";
    run.interimSeen = "";
    run.recentFinals = [];
    run.lastError = "";
    asrMetrics._sessStart = performance.now();
    asrMetrics._firstSeen = false;
    if (asrMetrics._endAt) {
      asrPush(asrMetrics.recover, performance.now() - asrMetrics._endAt);
      asrMetrics._endAt = 0;
    }
    run.startedAt = Date.now();
    if (rec !== state.recognition || !state.listening) {
      // 启动过程中用户已停止 / 已被新实例替换
      try { rec.stop(); } catch { /* ignore */ }
      return;
    }
    asrSetPhase("listening");
    setStatus("识别中…");
  };

  rec.onresult = (event) => {
    const nowTs = performance.now();
    if (!asrMetrics._firstSeen && asrMetrics._sessStart) {
      asrMetrics._firstSeen = true;
      asrPush(asrMetrics.first, nowTs - asrMetrics._sessStart);
    }
    state.asr.failures = 0; // 收到识别结果，说明链路正常，清零退避
    closeGap(run);

    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = (r[0]?.transcript || "").trim();
      if (txt) asrLog({ idx: i, ri: event.resultIndex, isFinal: r.isFinal, text: txt, alts: r.length });
    }

    const { finals, interimText } = readSnapshot(event, run);
    if (finals.length) {
      asrPush(asrMetrics.confirm, nowTs - (asrMetrics._lastResultAt || nowTs));
      for (const f of finals) {
        asrNote("final", f);
        commitFinal(f);
      }
    }
    asrMetrics._lastResultAt = nowTs;

    run.interim = interimText;
    renderInterim(run);
  };

  rec.onerror = (e) => {
    run.lastError = e.error;
    asrNote("error", e.error + (e.message ? ` ${e.message}` : ""));
    switch (e.error) {
      case "no-speech":   // 静音超时：正常现象，onend 后直接重启
      case "aborted":     // 我们自己调用了 abort/stop
        return;
      case "not-allowed":
      case "service-not-allowed":
        setStatus("麦克风被拒绝");
        alert("麦克风权限被拒绝。请在地址栏左侧锁图标里允许麦克风，然后刷新。");
        stopListening(true);
        return;
      case "audio-capture":
        state.asr.failures++;
        setStatus("没有检测到麦克风，重试中…");
        return;
      case "network":
        state.asr.failures++;
        setStatus("网络异常，重连中…");
        return;
      default:
        state.asr.failures++;
        setStatus("识别错误：" + e.error);
    }
  };

  rec.onend = () => {
    clearTimeout(state.asr.startWatchdog);
    asrMetrics._endAt = performance.now();
    asrNote("end", run.lastError || "ended");
    // 浏览器到会话结束都没有给 final 的 interim：以「待校对」保留，不静默丢弃
    flushResidual(run);

    if (rec !== state.recognition) return; // 已被新实例替换的旧实例，只负责收尾
    if (!state.listening) { finishStop(); return; }
    // 本次 run 没出错（含静音超时）说明此前的中断在它启动时就已恢复
    if (!run.lastError || run.lastError === "no-speech") closeGap(run);
    if (!state.asr.downSince) {
      state.asr.downSince = Date.now();
      state.asr.downReason = run.lastError || "ended";
    } else if (run.lastError && run.lastError !== "no-speech") {
      state.asr.downReason = run.lastError; // 中断期间重试又失败，原因以最近的错误为准
    }
    scheduleRestart(rec);
  };

  return rec;
}

/* 自动重启：正常结束快速重启；连续出错指数退避，最长 ASR_BACKOFF_MAX */
function scheduleRestart(rec) {
  const n = state.asr.failures;
  const delay = n === 0 ? ASR_RESTART_DELAY : Math.min(ASR_BACKOFF_BASE * 2 ** (n - 1), ASR_BACKOFF_MAX);
  asrSetPhase("restart_wait", `${delay}ms · failures=${n}`);
  if (n >= 3) setStatus(`识别中断，${(delay / 1000).toFixed(1)} 秒后第 ${n} 次重试…`);
  clearTimeout(state.restartTimer);
  state.restartTimer = setTimeout(() => startRecognition(rec), delay);
}

function startRecognition(rec) {
  if (!state.listening || rec !== state.recognition) return;
  if (state.asr.phase === "starting" || state.asr.phase === "listening") return; // 防重复 start()
  asrSetPhase("starting");
  try {
    rec.lang = recognitionLang();
    rec.start();
  } catch (e) {
    asrNote("start-failed", e && e.name);
    if (e && e.name === "InvalidStateError") { asrSetPhase("listening", "already started"); return; }
    state.asr.failures++;
    scheduleRestart(rec);
    return;
  }
  clearTimeout(state.asr.startWatchdog);
  state.asr.startWatchdog = setTimeout(() => {
    if (state.asr.phase !== "starting" || rec !== state.recognition || !state.listening) return;
    asrNote("start-timeout");
    state.asr.failures++;
    if (!state.asr.downSince) { state.asr.downSince = Date.now(); state.asr.downReason = "start-timeout"; }
    try { rec.abort(); } catch { /* ignore */ }
    state.asr.phase = "restart_wait";
    scheduleRestart(rec);
  }, ASR_START_TIMEOUT);
}

/* 一次中断 = 从识别结束到「之后第一个健康 run」启动；
   重启后立刻又出错的 run 不算恢复，连续失败合并成一次中断 */
function closeGap(run) {
  if (!state.asr.downSince || !run.startedAt) return;
  recordGap(state.asr.downSince, run.startedAt, state.asr.downReason);
  state.asr.downSince = 0;
}

/* 记录一次识别中断；超过阈值的在记录里插入可见提示，而不是假装一直在听 */
function recordGap(from, to, reason) {
  const ms = to - from;
  const gap = { at: new Date(from).toLocaleTimeString("zh-CN"), ms, reason };
  asrTrace.gaps.push(gap);
  if (asrTrace.gaps.length > 200) asrTrace.gaps.shift();
  asrNote("gap", `${ms}ms ${reason}`);
  if (ms >= GAP_NOTICE_MS) insertGapMarker(gap);
}

function insertGapMarker(gap) {
  const div = document.createElement("div");
  div.className = "gap-marker";
  div.textContent = `⚠ ${gap.at} 识别中断约 ${(gap.ms / 1000).toFixed(1)} 秒（${gap.reason}），这段时间的发言可能没有记录`;
  els.transcript.appendChild(div);
  scrollToBottom();
}

/**
 * 识别语言。注意 Web Speech API 的 rec.lang 是「单值」——浏览器不会替我们
 * 在中英间自动切换。所以「自动」的真实含义是：按目标语言反推最可能的说话语言。
 * （说中文就译英文 / 说英文就译中文），而不是把系统语言硬塞进去。
 */
function recognitionLang() {
  const v = els.selSrc.value;
  if (v !== "auto") return BCP47[v] || v;
  const sys = navigator.language || "zh-CN";
  const tgt = els.selTgt.value;
  // 目标语言是中文 → 说话方大概率是英文；目标是非中文 → 说话方大概率是中文
  const auto = tgt === "zh-CN" || tgt === "zh-TW" ? "en" : "zh-CN";
  // 系统语言本身就是中文/英文时以系统为准（更贴近本机习惯）
  if (/^zh/i.test(sys)) return tgt === "en" ? "zh-CN" : "en-US";
  if (/^en/i.test(sys)) return tgt === "zh-CN" ? "en-US" : "zh-CN";
  return BCP47[auto] || "zh-CN";
}

/* 「正在听」区：始终显示当前完整 interim。
   「实时」模式下，interim 停顿一会儿就生成/更新一个临时气泡（先翻译出来给人看），
   等浏览器的 final 到了再原地替换成正式结果。临时气泡不落库、不朗读。 */
function renderInterim(run) {
  const text = run.interim;
  if (!text) {
    els.liveText.textContent = "";
    return;
  }
  const changed = text !== run.interimSeen;
  run.interimSeen = text;
  els.liveText.textContent = text;
  els.liveArea.hidden = false;
  els.liveLang.textContent = "正在听…";
  els.emptyState.style.display = "none";
  // Chrome 会重复上报同一段 interim，没变化时不重置停顿计时，否则永远等不到
  if (changed && els.selMode.value === "dictation") armProvisional(run);
}

function armProvisional(run) {
  clearTimeout(state.pauseTimer);
  const len = run.interim.length;
  // 句越长越倾向于它是完整句子，等待越短；短句多等一会，减少无意义的临时翻译
  const wait = len >= 60 ? 900 : len >= 30 ? 1200 : 1600;
  state.pauseTimer = setTimeout(() => showProvisional(run.interim), wait);
}

function showProvisional(raw) {
  const text = ensurePunct((raw || "").trim());
  if (text.length < 2 || !state.listening) return;
  let node = state.provisional;
  if (node && !node.wrap.isConnected) node = state.provisional = null; // 切换/清空会话后已不在页面上
  if (node && node.src === text) return;
  if (!node) {
    node = createBlock(text);
    node.provisional = true;
    node.wrap.classList.add("provisional");
    node.editBtn.hidden = true;
    state.provisional = node;
  }
  setBlockSrc(node, text);
  node.badge.textContent = "临时 · 等待定稿";
  node.badge.title = "这段是识别中的临时结果，定稿后会自动替换";
  const ver = (node.ver = (node.ver || 0) + 1);
  const to = els.selTgt.value;
  requestTranslate(text, to)
    .then((d) => {
      if (!node.provisional || node.ver !== ver) return;
      node.tgtEl.textContent = d.text;
      node.tgtEl.classList.remove("loading");
      node.provTr = { src: text, to, d };
    })
    .catch(() => {});
}

/* 正式结果：只来自浏览器 final，或会话结束时的残留（标记待校对） */
function commitFinal(text, unconfirmed = false) {
  clearTimeout(state.pauseTimer);
  const prov = state.provisional;
  state.provisional = null;
  const node = prov && prov.wrap.isConnected ? prov : null;
  handleFinal(text, { unconfirmed, node });
}

/* 会话结束时的兜底：浏览器没给 final 的 interim 以「待校对」写入。
   没有 interim 但还挂着临时气泡（引擎撤回了临时结果），也按待校对保留，不静默丢弃。 */
function flushResidual(run) {
  clearTimeout(state.pauseTimer);
  const rest = (run && run.interim ? run.interim : "").trim();
  if (run) { run.interim = ""; run.interimSeen = ""; }
  els.liveText.textContent = "";
  asrMetrics._lastResultAt = 0;
  if (rest.length >= 2) {
    asrNote("residual", rest);
    commitFinal(rest, true);
  } else if (state.provisional) {
    asrNote("residual-provisional", state.provisional.src);
    commitFinal(state.provisional.src, true);
  }
}

/* 句末没有标点时自动补上，让译文更整齐、也便于按标点断句 */
function ensurePunct(text) {
  if (!text) return text;
  if (/[。！？!?；;…：:,，]$/.test(text)) return text;
  return /[\u4e00-\u9fff]/.test(text) ? text + "。" : text + ".";
}

/* text：正式原文；unconfirmed：浏览器未定稿（会话结束时残留）；
   node：要原地转正的临时气泡（没有则新建） */
function handleFinal(text, { unconfirmed = false, node = null } = {}) {
  state.started = true;
  els.emptyState.style.display = "none";
  text = (text || "").trim();
  if (!text) { if (node) node.wrap.remove(); return; }
  text = ensurePunct(text);
  splitChunks(text).forEach((c, i) =>
    enqueueTranslate(c, { isSpeech: true, unconfirmed, node: i === 0 ? node : null }));
  setStatus("识别中…");
}

function splitChunks(text) {
  const hard = 170;
  if (text.length <= hard) return [text];
  const parts = text.split(/(?<=[。！？!?；;.\n])\s*/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > hard && cur) { out.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((s) => s.length <= hard ? [s] : s.match(new RegExp(`.{1,${hard}}`, "gs")) || [s]);
}

function requestTranslate(text, to) {
  return api("/api/translate", {
    method: "POST",
    body: JSON.stringify({ text, from: "auto", to, engine: els.selEngine.value }),
  });
}

/* 气泡在入队时就创建（保证页面顺序 = 说话顺序），翻译仍串行执行。
   node：已有的临时气泡，在这里原地转正。 */
function enqueueTranslate(text, { isSpeech = false, unconfirmed = false, node = null } = {}) {
  if (node) {
    node.provisional = false;
    node.ver = (node.ver || 0) + 1; // 让还在路上的临时翻译作废
    node.wrap.classList.remove("provisional");
    node.editBtn.hidden = false;
    node.badge.title = "";
    setBlockSrc(node, text);
  } else {
    node = createBlock(text);
  }
  node.badge.textContent = "翻译中…";
  if (unconfirmed) {
    node.badge.textContent = "待校对 · 会话结束时未定稿";
    node.badge.title = "这段文字浏览器还没确认，可能不准确，可用「✎ 修正」改原文";
    node.badge.classList.add("badge-warn");
  }
  state.queue = state.queue.then(() => doTranslate(node, text, isSpeech, unconfirmed)).catch(() => {});
  return state.queue;
}

async function doTranslate(node, text, isSpeech, unconfirmed = false) {
  const tgtLang = els.selTgt.value;
  state.translating++;
  updateBusy();

  try {
    // 临时气泡已经翻过同一段文字时直接复用，不重复请求
    const reuse = node.provTr && node.provTr.src === text && node.provTr.to === tgtLang;
    if (!reuse) node.tgtEl.classList.add("loading");
    const d = reuse ? node.provTr.d : await requestTranslate(text, tgtLang);
    node.provTr = null;
    node.tgtEl.textContent = d.text;
    node.tgtEl.classList.remove("loading");
    const fromLabel = d.detected && LANG_NAME[d.detected] ? LANG_NAME[d.detected] : d.detected;
    const dirLabel = d.skipped ? `${fromLabel}（已是目标语言）` : `${fromLabel} → ${LANG_NAME[tgtLang] || tgtLang}`;
    // 未定稿标记优先保留，方便回头校对
    node.badge.textContent = unconfirmed ? `待校对 · ${dirLabel}` : dirLabel;

    // 实时同步到服务器，记录消息 id 以便「修正重译」时原地更新
    node.msgId = await syncMessage({
      src: text,
      tgt: d.text,
      fromLang: d.detected || null,
      toLang: tgtLang,
      engine: d.engine,
    }).catch(() => null);

    if (els.chkAuto.checked) speak(d.text, tgtLang);
    if (!els.cinema.hidden) appendCinema(text, d.text);
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
  if (state.translating > 0) {
    // 积压提醒：说话快于翻译时给出明确状态，而不是无限排队无感知
    setStatus(state.translating >= 4 ? `翻译积压 ${state.translating} 条，稍等…` : `翻译中 ${state.translating}…`);
  } else if (state.listening) setStatus("识别中…");
  else if (state.asr.phase === "stopped") setStatus("已停止");
}

/* ---------------------------- 渲染 ---------------------------- */
let blockSeq = 0;

function createBlock(src) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "翻译中…";
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  meta.append(badge, time);

  const editBtn = document.createElement("button");
  editBtn.className = "copy-mini";
  editBtn.textContent = "✎ 修正";
  editBtn.title = "识别不准？点此改原文后重译";
  meta.appendChild(editBtn);

  let srcLine = null;
  if (els.chkDual.checked) {
    srcLine = document.createElement("div");
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

  els.transcript.appendChild(wrap);
  scrollToBottom();

  const node = { wrap, tgtEl, badge, srcLine, editBtn, src };
  editBtn.onclick = () => startEdit(node);
  return node;
}

function setBlockSrc(node, text) {
  node.src = text;
  if (node.srcLine) node.srcLine.textContent = text;
}

/* 修正重译：把原文行变成输入框，用户改完回车重新翻译（解决中英混说单词识别错的问题） */
function startEdit(node) {
  if (node._editing) return;
  node._editing = true;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-src-input";
  input.value = node.src;

  // 防重入：replaceWith 移除输入框会同步触发 blur，若不先摘掉 onblur
  // 会再次调用 commit()，第二次 replaceWith 抛错并中断整个重译流程
  const detach = () => { input.onblur = null; input.onkeydown = null; };

  const commit = async () => {
    if (!node._editing) return;
    node._editing = false;
    detach();
    const newSrc = input.value.trim();
    const changed = newSrc && newSrc !== node.src;
    if (changed) { node.src = newSrc; if (node.srcLine) node.srcLine.textContent = newSrc; }
    if (node.srcLine) { input.replaceWith(node.srcLine); }
    else { input.remove(); }
    if (!changed) return;

    // 重新翻译
    const tgtLang = els.selTgt.value;
    node.tgtEl.textContent = "重新翻译中…";
    node.tgtEl.classList.add("loading");
    try {
      const d = await api("/api/translate", {
        method: "POST",
        body: JSON.stringify({ text: newSrc, from: "auto", to: tgtLang, engine: els.selEngine.value }),
      });
      node.tgtEl.textContent = d.text;
      node.tgtEl.classList.remove("loading");
      const fromLabel = d.detected && LANG_NAME[d.detected] ? LANG_NAME[d.detected] : d.detected;
      if (fromLabel) node.badge.textContent = d.skipped ? `${fromLabel}（已是目标语言）` : `${fromLabel} → ${LANG_NAME[tgtLang] || tgtLang}`;

      // 原地更新服务器记录（不新增）
      if (node.msgId && state.currentConvId) {
        api(`/api/conv/${state.currentConvId}/messages/${node.msgId}`, {
          method: "PATCH",
          body: JSON.stringify({ src: newSrc, tgt: d.text, fromLang: d.detected || null, toLang: tgtLang, engine: d.engine }),
        }).catch(() => {});
      }
    } catch (err) {
      node.tgtEl.textContent = "翻译失败：" + (err.message || "请检查网络");
      node.tgtEl.classList.remove("loading");
    }
  };

  const cancel = () => {
    if (!node._editing) return;
    node._editing = false;
    detach();
    if (node.srcLine) input.replaceWith(node.srcLine);
    else input.remove();
  };

  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };
  input.onblur = () => { if (node._editing) commit(); };

  if (node.srcLine) node.srcLine.replaceWith(input);
  else node.tgtEl.before(input);
  input.focus();
}

function renderMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  const meta = document.createElement("div");
  meta.className = "meta";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = `${LANG_NAME[m.fromLang] || "原文"} → ${LANG_NAME[m.toLang] || m.toLang || ""}`;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(m.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  // 历史消息同样支持「✎ 修正」重译（原地 PATCH 服务器记录）
  const editBtn = document.createElement("button");
  editBtn.className = "copy-mini";
  editBtn.textContent = "✎ 修正";
  editBtn.title = "识别不准？点此改原文后重译";
  meta.append(badge, time, editBtn);

  let srcLine = null;
  if (els.chkDual.checked) {
    srcLine = document.createElement("div");
    srcLine.className = "src-line";
    srcLine.textContent = m.src;
    wrap.appendChild(meta);
    wrap.appendChild(srcLine);
  } else {
    wrap.appendChild(meta);
  }
  const tgtEl = document.createElement("div");
  tgtEl.className = "tgt-line";
  tgtEl.textContent = m.tgt;
  wrap.appendChild(tgtEl);
  els.transcript.appendChild(wrap);

  const node = { wrap, tgtEl, badge, srcLine, editBtn, src: m.src, msgId: m.id };
  editBtn.onclick = () => startEdit(node);
}

function scrollToBottom() {
  requestAnimationFrame(() => { els.transcript.scrollTop = els.transcript.scrollHeight; });
}

function renderMic(on) {
  els.btnMic.classList.toggle("rec", on);
}

function setStatus(text) { els.status.textContent = text; }

/* ---------------------------- 语音合成 ---------------------------- */
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
  if (els.selVoice.value) {
    const v = voiceList.find((x) => x.voiceURI === els.selVoice.value);
    if (v) return v;
  }
  return voiceList.find((v) => v.lang.replace("_", "-").toLowerCase() === String(bcp).toLowerCase()) || null;
}
/* 朗读播放队列：顺序播放互不打断；积压时丢弃最旧的待播（字幕/记录仍完整），
   避免「前一句没读完、后一句插进来，越听越乱」 */
const tts = { queue: [], playing: false };

function speak(text, lang) {
  if (!("speechSynthesis" in window)) return;
  tts.queue.push({ text, lang });
  if (tts.queue.length > 2) tts.queue.shift(); // 只保留最新的待播 2 条
  playTts();
}

function playTts() {
  if (tts.playing) return;
  const item = tts.queue.shift();
  if (!item) return;
  tts.playing = true;
  const u = new SpeechSynthesisUtterance(item.text);
  u.lang = BCP47[item.lang] || item.lang;
  const v = pickVoice(item.lang);
  if (v) u.voice = v;
  u.rate = Number(els.rngRate.value) || 1;
  u.onend = u.onerror = () => { tts.playing = false; playTts(); };
  speechSynthesis.speak(u);
}

function stopTts() {
  tts.queue = [];
  tts.playing = false;
  speechSynthesis.cancel();
}

/* ---------------------------- 服务端识别 ---------------------------- *
 * 浏览器只采集音频：AudioWorklet 转成 16k 单声道 int16 PCM，经 WebSocket(/api/asr)
 * 发给服务器，服务器 SenseVoice 识别后回 partial / final。partial 走 run.interim + 临时气泡，
 * final 走 commitFinal，与浏览器识别共用同一套入库、翻译、待校对逻辑。
 * 断线期间麦克风不停，音频先缓存（最多 SRV_BACKLOG_MAX_MS），重连后补发；
 * 只有缓存溢出、真正丢了音频时才记一次识别中断。详见 docs/asr/v2.1.0-server-asr.md */
const SRV_BACKLOG_MAX_MS = 60000;
const SRV_CHUNK_MS = 100;           // asr-worklet.js 每块 100ms
const SRV_STOP_TIMEOUT = 6000;      // 手动停止后最多等服务器识别完最后一段

function asrEngine() {
  return state.asrServer && els.selAsr.value === "server" ? "server" : "browser";
}

async function loadAsrStatus() {
  try {
    const d = await api("/api/asr/status");
    state.asrServer = !!d.enabled && !!window.AudioWorkletNode && !!window.WebSocket;
  } catch { state.asrServer = false; }
  els.selAsr.querySelector('option[value="server"]').disabled = !state.asrServer;
  if (!state.asrServer) els.selAsr.value = "browser";
}

function srvLang() {
  const v = els.selSrc.value;
  return v === "zh-CN" || v === "zh-TW" ? "zh" : ["yue", "en", "ja", "ko"].includes(v) ? v : "auto";
}

async function startServerListening() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    alert("无法访问麦克风，请检查系统权限设置。");
    return "denied";
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    await ctx.audioWorklet.addModule("asr-worklet.js");
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    asrNote("worklet-failed", e && e.message);
    return false;
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16k");
  const mute = ctx.createGain();
  mute.gain.value = 0; // 只为让音频图持续运转，不把麦克风声音放出来
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  if (ctx.state === "suspended") ctx.resume().catch(() => {});

  const run = { id: 0, startedAt: 0, interim: "", interimSeen: "", recentFinals: [], lastError: "" };
  const srv = {
    stream, ctx, node, run, ws: null, ready: false, everReady: false, timer: null, watchdog: null,
    backlog: [], dropFrom: 0, dropTo: 0, seenFinals: new Set(),
  };
  state.srv = srv;
  node.port.onmessage = (e) => srvAudio(srv, e.data);
  srvConnect(srv);
  return true;
}

function srvAudio(srv, buf) {
  if (!state.listening || srv !== state.srv) return;
  const ws = srv.ws;
  if (ws && ws.readyState === WebSocket.OPEN && srv.ready) { ws.send(buf); return; }
  srv.backlog.push(buf);
  if (srv.backlog.length * SRV_CHUNK_MS > SRV_BACKLOG_MAX_MS) {
    srv.backlog.shift();
    const now = Date.now();
    if (!srv.dropFrom) srv.dropFrom = now - SRV_BACKLOG_MAX_MS;
    srv.dropTo = now - SRV_BACKLOG_MAX_MS;
  }
}

function srvConnect(srv) {
  if (!state.listening || srv !== state.srv) return;
  asrSetPhase("starting", "server");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/asr?token=${encodeURIComponent(state.token || "")}`);
  ws.binaryType = "arraybuffer";
  srv.ws = ws;
  srv.ready = false;
  clearTimeout(srv.watchdog);
  srv.watchdog = setTimeout(() => {
    if (srv.ws === ws && !srv.ready) { asrNote("start-timeout", "server"); ws.close(); }
  }, ASR_START_TIMEOUT);
  ws.onopen = () => ws.send(JSON.stringify({ type: "start", lang: srvLang() }));
  ws.onmessage = (e) => {
    if (srv.ws !== ws || typeof e.data !== "string") return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    srvMessage(srv, ws, m);
  };
  ws.onclose = (e) => srvClosed(srv, ws, e);
}

function srvMessage(srv, ws, m) {
  const run = srv.run;
  const nowTs = performance.now();
  switch (m.type) {
    case "ready": {
      clearTimeout(srv.watchdog);
      srv.ready = true;
      srv.everReady = true;
      run.id = ++asrTrace.session;
      run.startedAt = Date.now();
      run.interim = run.interimSeen = "";
      srv.seenFinals.clear();
      state.asr.failures = 0;
      asrMetrics._sessStart = nowTs;
      asrMetrics._firstSeen = false;
      if (asrMetrics._endAt) { asrPush(asrMetrics.recover, nowTs - asrMetrics._endAt); asrMetrics._endAt = 0; }
      if (srv.dropFrom) {
        recordGap(srv.dropFrom, srv.dropTo, "服务器断线超过缓存时长");
        srv.dropFrom = srv.dropTo = 0;
      }
      // 断线期间缓存的音频按顺序补发
      const backlog = srv.backlog.splice(0);
      if (backlog.length) asrNote("backlog-sent", `${(backlog.length * SRV_CHUNK_MS / 1000).toFixed(1)}s`);
      for (const b of backlog) ws.send(b);
      if (state.listening) {
        asrSetPhase("listening", "server");
        setStatus("识别中（服务器）…");
      }
      return;
    }
    case "partial": {
      if (srv.seenFinals.has(m.seg)) return; // 晚到的 partial，该段已定稿
      if (!asrMetrics._firstSeen && asrMetrics._sessStart) {
        asrMetrics._firstSeen = true;
        asrPush(asrMetrics.first, nowTs - asrMetrics._sessStart);
      }
      asrLog({ idx: m.seg, isFinal: false, text: m.text });
      asrMetrics._lastResultAt = nowTs;
      run.interim = (m.text || "").trim();
      renderInterim(run);
      return;
    }
    case "final": {
      if (srv.seenFinals.has(m.seg)) { asrNote("final-dup", m.text); return; }
      srv.seenFinals.add(m.seg);
      asrLog({ idx: m.seg, isFinal: true, text: m.text, alts: m.decode_ms != null ? `${m.decode_ms}ms` : "" });
      asrPush(asrMetrics.confirm, nowTs - (asrMetrics._lastResultAt || nowTs));
      asrMetrics._lastResultAt = 0;
      run.interim = run.interimSeen = "";
      els.liveText.textContent = "";
      const text = (m.text || "").trim();
      if (text) { asrNote("final", text); commitFinal(text); }
      else if (state.provisional) commitFinal(""); // 整段识别为空（噪声），撤掉对应的临时气泡
      return;
    }
    case "end":
      asrNote("server-end");
      ws.close();
      return;
    case "error":
      run.lastError = m.error || "error";
      asrNote("error", `${m.error} ${m.message || ""}`);
      if (m.message) setStatus(m.message);
      return;
  }
}

function srvClosed(srv, ws, e) {
  if (srv.ws !== ws) return;
  clearTimeout(srv.watchdog);
  srv.ws = null;
  srv.ready = false;
  asrMetrics._endAt = performance.now();
  asrNote("end", `ws ${e.code}${e.reason ? " " + e.reason : ""}`);
  flushResidual(srv.run); // 断线时未定稿的 partial 以「待校对」保留
  if (srv !== state.srv) { srvTeardown(srv); return; }
  if (!state.listening) { srvTeardown(srv); finishStop(); return; }

  state.asr.failures++;
  // 一次都没连上：服务器识别不可用，回到浏览器识别，不让用户对着没反应的页面说话
  if (!srv.everReady && state.asr.failures >= 2 && SpeechRecognition) {
    asrNote("fallback", "browser");
    srvTeardown(srv);
    setStatus("服务器识别不可用，已切换到浏览器识别");
    startBrowserListening();
    return;
  }
  const n = state.asr.failures;
  const delay = Math.min(ASR_BACKOFF_BASE * 2 ** (n - 1), ASR_BACKOFF_MAX);
  asrSetPhase("restart_wait", `server ${delay}ms · failures=${n}`);
  setStatus(`识别服务断开，${(delay / 1000).toFixed(1)} 秒后重连（音频已缓存）…`);
  clearTimeout(srv.timer);
  srv.timer = setTimeout(() => srvConnect(srv), delay);
}

function stopServerListening() {
  const srv = state.srv;
  clearTimeout(srv.timer);
  srv.node.port.onmessage = null;
  srv.stream.getTracks().forEach((t) => t.stop()); // 立刻关麦克风
  const ws = srv.ws;
  if (ws && ws.readyState === WebSocket.OPEN && srv.ready) {
    asrSetPhase("stopping", "server");
    ws.send(JSON.stringify({ type: "stop" }));
    clearTimeout(state.asr.stopFallback);
    state.asr.stopFallback = setTimeout(() => {
      if (srv.ws !== ws) return;
      asrNote("stop-timeout", "server");
      srv.ws = null;
      try { ws.close(); } catch { /* ignore */ }
      flushResidual(srv.run);
      srvTeardown(srv);
      finishStop();
    }, SRV_STOP_TIMEOUT);
    setStatus("正在收尾…");
  } else {
    if (srv.backlog.length) asrNote("backlog-dropped", `${(srv.backlog.length * SRV_CHUNK_MS / 1000).toFixed(1)}s`);
    srv.ws = null;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    flushResidual(srv.run);
    srvTeardown(srv);
    finishStop();
  }
}

function srvTeardown(srv) {
  clearTimeout(srv.timer);
  clearTimeout(srv.watchdog);
  srv.node.port.onmessage = null;
  srv.backlog = [];
  try { srv.node.disconnect(); } catch { /* ignore */ }
  srv.stream.getTracks().forEach((t) => t.stop());
  srv.ctx.close().catch(() => {});
  if (state.srv === srv) state.srv = null;
}

/* ---------------------------- 开始/停止 ---------------------------- */
async function startListening() {
  clearTimeout(state.asr.stopFallback);
  clearTimeout(state.restartTimer);
  state.asr.failures = 0;
  state.asr.downSince = 0;
  if (asrEngine() === "server") {
    state.manualStop = false;
    state.listening = true;
    renderMic(true);
    els.liveArea.hidden = false;
    els.liveText.textContent = "";
    setStatus("连接识别服务…");
    const ok = await startServerListening();
    if (ok === true) return;
    if (ok === "denied" || !state.listening) { state.listening = false; renderMic(false); setStatus("待命"); return; }
    setStatus("服务器识别启动失败，改用浏览器识别");
  }
  await startBrowserListening();
}

async function startBrowserListening() {
  if (!SpeechRecognition) {
    alert("当前浏览器不支持语音识别，请使用 Chrome / Edge，或在服务器识别可用时选择「服务器识别」。");
    state.listening = false;
    renderMic(false);
    return;
  }
  state.manualStop = false;
  state.listening = true;
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert("无法访问麦克风，请检查系统权限设置。"); state.listening = false; renderMic(false); return; }

  state.asr.failures = 0;
  state.asr.downSince = 0;
  state.recognition = buildRecognition();
  state.asr.phase = "idle";
  startRecognition(state.recognition);
  els.liveArea.hidden = false;
  els.liveText.textContent = "";
  renderMic(true);
  setStatus("识别中…");
}

/* 手动停止：先 stop() 让浏览器把最后的 final 送回来，在 onend 里再处理残留；
   不能先把 interim 提交再 stop()，否则随后到达的 final 会和它重复。 */
function stopListening(hard = false) {
  state.manualStop = true;
  state.listening = false;
  clearTimeout(state.restartTimer);
  clearTimeout(state.pauseTimer);
  clearTimeout(state.asr.startWatchdog);
  if (state.srv) {
    stopServerListening();
    stopTts();
    renderMic(false);
    return;
  }
  const rec = state.recognition;
  const active = rec && (state.asr.phase === "listening" || state.asr.phase === "starting");
  if (active) {
    asrSetPhase("stopping", hard ? "hard" : "");
    try { rec.stop(); } catch { /* ignore */ }
    clearTimeout(state.asr.stopFallback);
    state.asr.stopFallback = setTimeout(() => {
      if (state.asr.phase !== "stopping") return;
      asrNote("stop-timeout");
      flushResidual(rec._run);
      finishStop();
    }, ASR_STOP_TIMEOUT);
    setStatus("正在收尾…");
  } else {
    if (rec) flushResidual(rec._run);
    finishStop();
  }
  stopTts(); // 手动停止时同步中断朗读并清空待播队列
  renderMic(false);
}

function finishStop() {
  clearTimeout(state.asr.stopFallback);
  if (state.listening) return; // 收尾期间用户又点了开始
  asrSetPhase("stopped");
  els.liveArea.hidden = true;
  renderMic(false);
  setStatus("已停止");
}

els.btnMic.onclick = () => state.listening ? stopListening() : startListening();

/* ---------------------------- 手动输入 ---------------------------- */
function submitTyped() {
  const text = els.txtInput.value.trim();
  if (!text) return;
  els.txtInput.value = "";
  autosizeInput();
  els.emptyState.style.display = "none";
  state.started = true;
  // 长文本也按标点智能分段（同语音路径），避免超长文本超出翻译引擎单次上限
  splitChunks(text).forEach((c) => enqueueTranslate(c));
}
els.btnSend.onclick = submitTyped;
els.txtInput.onkeydown = (e) => {
  // Enter 发送，Shift+Enter 换行（中文输入法组词中不触发）
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitTyped(); }
};
/* 输入框自动增高（textarea） */
function autosizeInput() {
  const t = els.txtInput;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
els.txtInput.addEventListener("input", autosizeInput);

/* ---------------------------- 设置 ---------------------------- */
function saveSettings() {
  localStorage.setItem("lt.settings", JSON.stringify({
    tgt: els.selTgt.value, mode: els.selMode.value, engine: els.selEngine.value,
    voiceURI: els.selVoice.value, rate: els.rngRate.value, font: els.rngFont.value,
    theme: els.selTheme.value, asr: els.selAsr.value,
  }));
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("lt.settings") || "{}");
    if (s.tgt) els.selTgt.value = s.tgt;
    if (s.mode) els.selMode.value = s.mode;
    if (s.engine) els.selEngine.value = s.engine;
    if (s.asr) els.selAsr.value = s.asr;
    if (s.voiceURI) els.selVoice.dataset.want = s.voiceURI;
    if (s.rate) { els.rngRate.value = s.rate; els.rateVal.textContent = Number(s.rate).toFixed(1) + "x"; }
    if (s.font) { els.rngFont.value = s.font; applyFont(s.font); }
    applyTheme(s.theme || "light");
  } catch { applyTheme("light"); }
}

function applyTheme(t) {
  const theme = t === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  if (els.selTheme) els.selTheme.value = theme;
}
function applyFont(v) {
  const scale = v / 100;
  document.querySelectorAll(".tgt-line").forEach((n) => (n.style.fontSize = (20 * scale).toFixed(1) + "px"));
  els.fontVal.textContent = v < 100 ? "小" : v > 100 ? "大" : "中";
}

els.btnSwap.onclick = () => {
  const s = els.selSrc.value, t = els.selTgt.value;
  els.selSrc.value = t === "zh-CN" ? "en" : (t === "en" ? "zh-CN" : "auto");
  els.selTgt.value = (s === "auto" || s === "yue") ? "zh-CN" : s;
  saveSettings();
  if (state.listening) { try { state.recognition.stop(); } catch { /* restart onend */ } }
};

[els.selTgt, els.selMode, els.selEngine, els.selAsr].forEach((el) => el.addEventListener("change", saveSettings));
els.selTheme.addEventListener("change", () => { applyTheme(els.selTheme.value); saveSettings(); });
/* 「自动」识别时 rec.lang 由目标语言反推，改语言需重启识别会话才生效 */
[els.selSrc, els.selTgt].forEach((el) =>
  el.addEventListener("change", () => {
    if (state.listening) { try { state.recognition.stop(); } catch { /* onend 自动重启 */ } }
  })
);
/* 切模式时清掉待触发的停顿提交，避免残留定时器把旧 interim 送出去 */
els.selMode.addEventListener("change", () => clearTimeout(state.pauseTimer));
els.rngRate.addEventListener("input", () => { els.rateVal.textContent = Number(els.rngRate.value).toFixed(1) + "x"; saveSettings(); });
els.rngFont.addEventListener("input", () => { applyFont(Number(els.rngFont.value)); saveSettings(); });
els.selVoice.addEventListener("change", () => { localStorage.setItem("lt.voice", els.selVoice.value); saveSettings(); });

/* 修改密码 */
els.btnChangePw.onclick = async () => {
  const cur = els.pwCur.value, next = els.pwNew.value, next2 = els.pwNew2.value;
  if (!cur || !next) { els.pwMsg.textContent = "请填写当前密码和新密码"; return; }
  if (next !== next2) { els.pwMsg.textContent = "两次输入的新密码不一致"; return; }
  if (next.length < 6) { els.pwMsg.textContent = "新密码至少 6 位"; return; }
  els.btnChangePw.disabled = true;
  els.pwMsg.textContent = "修改中…";
  try {
    const d = await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current: cur, next }) });
    els.pwMsg.textContent = "✅ " + (d.message || "密码已更新");
    els.pwCur.value = els.pwNew.value = els.pwNew2.value = "";
  } catch (e) {
    els.pwMsg.textContent = "⚠️ " + e.message;
  } finally {
    els.btnChangePw.disabled = false;
  }
};

els.btnSettings.onclick = () => (els.drawer.hidden = false);
els.btnHelp.onclick = () => (els.help.hidden = false);
els.btnCloseDrawer.onclick = () => (els.drawer.hidden = true);
els.btnCloseHelp.onclick = () => (els.help.hidden = true);
[els.drawer, els.help, els.adminPanel].forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) d.hidden = true; }));

els.btnClear.onclick = () => {
  if (!confirm("清空当前视图？(不会删除服务器记录)")) return;
  els.transcript.innerHTML = "";
  els.emptyState.style.display = "";
};

els.btnExport.onclick = async () => {
  if (!state.currentConvId) return alert("暂无对话");
  const d = await api(`/api/conv/${state.currentConvId}/messages`).catch(() => null);
  if (!d || !d.messages.length) return alert("当前对话没有内容");
  const lines = d.messages.map((m) => `[${new Date(m.createdAt).toLocaleString("zh-CN")}] ${m.src}\n→ ${m.tgt}\n`);
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
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    els.cinema.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen?.();
  }
};
els.btnExitCinema.onclick = () => { els.cinema.hidden = true; if (document.fullscreenElement) document.exitFullscreen?.(); };

function appendCinema(src, tgt) {
  const s = document.createElement("div"); s.className = "src"; s.textContent = src;
  const t = document.createElement("div"); t.textContent = tgt;
  els.cinemaBody.append(s, t);
  while (els.cinemaBody.children.length > 16) els.cinemaBody.firstElementChild.remove();
  els.cinema.scrollTop = els.cinema.scrollHeight;
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); els.btnMic.click(); }
  if (e.key === "Escape") { els.cinema.hidden = true; els.drawer.hidden = true; els.help.hidden = true; }
});

/* ---------------------------- 后台管理 ---------------------------- */
els.btnAdmin.onclick = () => { els.adminPanel.hidden = false; loadAdmin("users"); };

document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    loadAdmin(tab.dataset.view);
  };
});
els.btnCloseAdmin.onclick = () => (els.adminPanel.hidden = true);

async function loadAdmin(view) {
  els.adminBody.innerHTML = '<div class="admin-loading">加载中…</div>';
  try {
    if (view === "users") {
      const d = await api("/api/admin/users");
      els.adminBody.innerHTML = "";
      const list = document.createElement("div");
      d.users.forEach((u) => {
        const row = document.createElement("div");
        row.className = "admin-row";
        const info = document.createElement("div");
        info.innerHTML = `<b>${u.username}</b> ${u.role === "admin" ? '<span class="badge">管理员</span>' : ""} <span class="admin-status s-${u.status}">${u.status === "active" ? "已通过" : u.status === "pending" ? "待审批" : "已拒绝"}</span><br><small>对话 ${u.conversations} · 消息 ${u.messages}</small>`;
        const ops = document.createElement("div");
        if (u.role !== "admin" && u.status === "pending") {
          const ok = document.createElement("button"); ok.className = "mini-ok"; ok.textContent = "通过";
          ok.onclick = () => setUserStatus(u.id, "active");
          const no = document.createElement("button"); no.className = "mini-no"; no.textContent = "拒绝";
          no.onclick = () => setUserStatus(u.id, "rejected");
          ops.append(ok, no);
        } else if (u.role !== "admin" && u.status === "active") {
          const dis = document.createElement("button"); dis.className = "mini-no"; dis.textContent = "禁用";
          dis.onclick = () => setUserStatus(u.id, "rejected");
          ops.append(dis);
        }
        row.append(info, ops);
        list.appendChild(row);
      });
      els.adminBody.appendChild(list);
    } else if (view === "stats") {
      const d = await api("/api/admin/stats");
      const s = d.stats;
      els.adminBody.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><b>${s.totalUsers}</b><span>总用户</span></div>
          <div class="stat"><b>${s.activeUsers}</b><span>已通过</span></div>
          <div class="stat"><b>${s.pendingUsers}</b><span>待审批</span></div>
          <div class="stat"><b>${s.totalConversations}</b><span>对话总数</span></div>
          <div class="stat"><b>${s.totalMessages}</b><span>翻译条数</span></div>
        </div>
        <h3 class="admin-sub">各用户消息量</h3>
        <div id="perUser"></div>`;
      const per = $("perUser");
      Object.entries(s.messagesByUser).forEach(([uid, n]) => {
        per.innerHTML += `<div class="admin-row"><span>${uid}</span><b>${n} 条</b></div>`;
      });
    } else if (view === "records") {
      const d = await api("/api/admin/users");
      const userSel = document.createElement("select");
      userSel.innerHTML = '<option value="">选择用户…</option>';
      d.users.forEach((u) => {
        const o = document.createElement("option");
        o.value = u.id; o.textContent = u.username;
        userSel.appendChild(o);
      });
      userSel.onchange = async () => {
        if (!userSel.value) return;
        const u = await api(`/api/admin/usage/${userSel.value}`);
        const container = $("userRecords");
        container.innerHTML = `<p>用户 <b>${u.user.username}</b>：对话 ${u.usage.conversations} 个 · 消息 ${u.usage.messages} 条</p>`;
        const list = document.createElement("div");
        u.conversations.forEach((c) => {
          const it = document.createElement("div");
          it.className = "conv-item clickable";
          it.innerHTML = `<span class="conv-title">${c.title}</span><span class="conv-count">${c.msgCount}</span>`;
          it.onclick = async () => {
            const cd = await api(`/api/admin/conversations/${c.id}`);
            const box = $("convDetail");
            box.innerHTML = `<h3 class="admin-sub">${c.title}</h3>`;
            cd.messages.forEach((m) => {
              box.innerHTML += `<div class="record-msg"><div class="src-line">${esc(m.src)}</div><div class="tgt-line mini">${esc(m.tgt)}</div></div>`;
            });
          };
          list.appendChild(it);
        });
        container.appendChild(list);
        container.innerHTML += '<div id="convDetail"></div>';
      };
      els.adminBody.innerHTML = "";
      els.adminBody.appendChild(userSel);
      const container = document.createElement("div");
      container.id = "userRecords";
      els.adminBody.appendChild(container);
    }
  } catch (e) {
    els.adminBody.innerHTML = `<div class="admin-error">加载失败: ${e.message}</div>`;
  }
}

async function setUserStatus(id, status) {
  try {
    await api(`/api/admin/users/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
    loadAdmin("users");
  } catch (e) { alert(e.message); }
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------------------- 初始化 ---------------------------- */
function init() {
  loadSettings();
  loadVoices();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = loadVoices;
  applyFont(Number(els.rngFont.value) || 100);
  // 自动朗读默认关闭
  els.chkAuto.checked = false;
  initAuth();
}

init();
