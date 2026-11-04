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
  selSrc: $("selSrc"), selTgt: $("selTgt"), selMode: $("selMode"), selEngine: $("selEngine"),
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
  /* 识别层状态：以「已确认 final 基线 + 当前 interim 快照」为唯一真相。
     lastInterim   = 尚未提交的识别文本（不是增量拼接）
     lastCommitted = 已通过 interim 提交翻译过的文本（用于 final 去重） */
  lastInterim: "",
  lastCommitted: "",
  committedAt: 0,
  finalSeen: new Map(), // final 文本 → 处理时间（同一句话可能被真说两次，需带时间窗口）
  interimSeen: "",      // 上一次看到的 interim（无变化则不重置停顿计时）
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
  const report = {
    首字延迟ms: { avg: avg(asrMetrics.first), n: asrMetrics.first.length },
    停顿确认ms: { avg: avg(asrMetrics.confirm), n: asrMetrics.confirm.length },
    恢复延迟ms: { avg: avg(asrMetrics.recover), n: asrMetrics.recover.length },
  };
  console.table(report);
  return JSON.stringify(report);
};

/* ------------------------------------------------------------------ *
 * ASR 事件记录（追踪丢内容发生在哪一层）
 * 只在内存环形缓冲，不落库；控制台 asrEvents() 查看最近事件
 * ------------------------------------------------------------------ */
const asrTrace = { events: [], session: 0 };
window.asrEvents = function (n = 30) {
  const out = asrTrace.events.slice(-n).map((e) => ({
    t: e.t, idx: e.idx, final: e.isFinal ? "Y" : "",
    text: e.text.slice(0, 60), alt: e.alts,
  }));
  console.table(out);
  return out.length;
};

/**
 * 从事件重建「完整识别快照」。
 *
 * 浏览器行为（实测）：
 *  1. event.results 会随会话推进「移除已定稿的旧项」，索引会重排/跳号（日志里 0 → 2）；
 *     所以绝不能按索引判断新 final。
 *  2. 同一条 final 会在后续事件里被重复上报（isFinal 恒为 true，内容不变）。
 *  3. interim 会被「修订」而非只追加（日志里 没问题然后的话接 → 没问题 → 没问题然后的话接下）。
 *
 * 结论：final 用「内容 + 已处理集合」去重；interim 直接以最后一次上报为准。
 */
function readSnapshot(event) {
  let interimText = "";
  const freshFinals = [];
  const needsSpace = (a, b) => a && b && !/[\u4e00-\u9fff]$/.test(a) && !/^[\u4e00-\u9fff]/.test(b);
  const append = (acc, piece) => (needsSpace(acc, piece) ? acc + " " + piece : acc + piece);
  for (let i = 0; i < event.results.length; i++) {
    const r = event.results[i];
    const txt = (r[0]?.transcript || "").trim();
    if (!txt) continue;
    if (r.isFinal) {
      // 同一条 final 会被反复上报（内容一字不差）；但同一句话也可能被真说两次，
      // 所以只在「短时间内重复上报」时才判为重复。
      const seenAt = state.finalSeen.get(txt);
      const now = Date.now();
      if (!seenAt || now - seenAt > FINAL_REPEAT_WINDOW) {
        state.finalSeen.set(txt, now);
        freshFinals.push(txt);
      }
    } else {
      interimText = append(interimText, txt);
    }
  }
  return { freshFinal: freshFinals.join(""), interimText };
}

/* 把「本次 final」中尚未翻译过的部分摘出来。
   规则：final 通常是当前结果缓冲区从头重发的整段，只要它以前面已翻译过的文本开头，
   就把那段前缀剥掉，剩下的才送翻译——避免同一句被翻译两次。 */
function dedupeFinal(finalText) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const a = norm(finalText || "");
  const prev = norm(state.lastCommitted || "");
  if (!prev) return a;
  if (a.startsWith(prev)) return a.slice(prev.length).trim();
  // 忽略空白再比一次（识别结果里的空格数会来回变，不能作为判重依据）
  const squash = (s) => s.replace(/\s+/g, "");
  const pa = squash(a), pb = squash(prev);
  if (pa.startsWith(pb)) {
    // 用非空白字符数定位真实截断点
    let cnt = 0, cut = 0;
    for (let i = 0; i < a.length; i++) {
      if (!/\s/.test(a[i])) cnt++;
      if (cnt === pb.length) { cut = i + 1; break; }
    }
    return a.slice(cut).trim();
  }
  // final 比预期短（引擎修订了前文）：只提交它，不和旧文本叠加，避免制造重复
  return pa.length >= pb.length ? a : "";
}

function buildRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = recognitionLang();
  // 多候选：部分浏览器可返回多个识别候选，用于专有名词/中英混合词的二次判断
  rec.maxAlternatives = 3;

  rec.onstart = () => {
    asrMetrics._sessStart = performance.now();
    asrMetrics._firstSeen = false;
    if (asrMetrics._endAt) {
      asrPush(asrMetrics.recover, performance.now() - asrMetrics._endAt);
      asrMetrics._endAt = 0;
    }
    state.finalSeen = new Map(); // 新会话：清空已处理 final
    state.interimSeen = "";
    asrTrace.session++;
    setStatus("识别中…");
  };

  rec.onresult = (event) => {
    const nowTs = performance.now();
    if (!asrMetrics._firstSeen && asrMetrics._sessStart) {
      asrMetrics._firstSeen = true;
      asrPush(asrMetrics.first, nowTs - asrMetrics._sessStart);
    }

    const { freshFinal, interimText } = readSnapshot(event);

    // 事件记录：用于排查「浏览器没识别到」vs「我们弄丢了」
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = (r[0]?.transcript || "").trim();
      if (!txt) continue;
      asrTrace.events.push({ t: Math.round(nowTs), idx: i, isFinal: r.isFinal, text: txt, alts: r.length });
      if (asrTrace.events.length > 400) asrTrace.events.shift();
    }

    // 只处理「本次新定稿」的 final；已处理过的 final 会被浏览器反复上报，不能重复提交
    if (freshFinal) {
      asrPush(asrMetrics.confirm, nowTs - (asrMetrics._lastResultAt || nowTs));
      // 防丢内容：浏览器的 final 有时比它自己给出的 interim 更短（修订时把后半句吞掉了）。
      // 这种情况下 interim 才是更完整的版本，取更长的一份。
      let text = freshFinal;
      const pend = (state.lastInterim || "").trim();
      if (pend.length > text.length && pend.includes(text.slice(0, Math.min(6, text.length)))) {
        text = pend;
      }
      // 剥掉「已通过 interim 提交过」的前缀，避免同一句翻译两次
      const remain = dedupeFinal(text);
      state.lastCommitted = ""; // 本段已定稿，基线清空，下一句重新累积
      state.lastInterim = "";
      state.interimSeen = "";
      clearTimeout(state.pauseTimer);
      if (remain) handleFinal(remain);
      els.liveText.textContent = "";
    }
    asrMetrics._lastResultAt = nowTs;

    if (interimText) {
      // interim 无实际变化（Chrome 会重复上报同一段）时不重置停顿计时，否则永远等不到提交
      const changed = interimText !== state.interimSeen;
      state.interimSeen = interimText;
      // interimText 是「本段从头重发的完整临时文本」，可能包含已经提交过的前缀；
      // 剥掉前缀后再更新待提交部分
      const pending = dedupeFinal(interimText);
      if (pending) {
        state.lastInterim = pending;
        els.liveText.textContent = pending;
      }
      els.liveArea.hidden = false;
      els.liveLang.textContent = "正在听…";
      els.emptyState.style.display = "none";
      // 「实时」模式才做提前展示；只有内容真的变化时才重新计时
      if (changed && els.selMode.value === "dictation") armPauseCommit();
    }
  };

  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setStatus("麦克风被拒绝");
      alert("麦克风权限被拒绝。请在地址栏左侧锁图标里允许麦克风，然后刷新。");
      stopListening(true);
      return;
    }
    if (e.error === "network") { setStatus("网络异常，重连中…"); return; }
    setStatus("识别错误：" + e.error);
  };

  rec.onend = () => {
    asrMetrics._endAt = performance.now();
    // 先把尚未定稿的 interim 也提交，避免长句在静音/重启时丢掉后半段
    flushInterim();

    if (state.manualStop) {
      state.listening = false;
      els.liveArea.hidden = true;
      renderMic(false);
      setStatus("已停止");
      return;
    }
    if (state.listening) {
      clearTimeout(state.restartTimer);
      state.restartTimer = setTimeout(() => {
        if (!state.listening) return;
        // 新会话可能从缓冲区开头重发同一段内容，保留 8 秒内的去重基线
        if (Date.now() - (state.committedAt || 0) > 8000) state.lastCommitted = "";
        try { rec.lang = recognitionLang(); rec.start(); setStatus("识别中…"); } catch { /* ignore */ }
      }, 120);
    }
  };

  return rec;
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

/* 停顿自动提交：「实时」模式下，说话者停顿足够久时把 interim 提交。
   只提交到最后一个句末标点为止——不把「说到一半的词」当定稿，
   剩余部分继续留在 interim 里等后续识别补全，避免截断与重复。 */
const SENT_END = /[。！？!?；;…\n.]/;
/* 没有标点时，interim 达到这个长度就认为是一句话（中文约 10 字 / 英文约 18 词） */
const PAUSE_MIN_LEN = 12;
/* 同一条 final 在该时间窗内重复上报视为同一句（浏览器最多重发数秒） */
const FINAL_REPEAT_WINDOW = 30000;

function armPauseCommit() {
  clearTimeout(state.pauseTimer);
  const len = (state.lastInterim || "").length;
  // 句越长越倾向于它是完整句子，等待越短；短句多等一会，减少误切
  const wait = len >= 60 ? 900 : len >= 30 ? 1200 : 1600;
  state.pauseTimer = setTimeout(commitPause, wait);
}

/* 停顿提交。Chrome 的 interim 基本不带标点，所以不能死等句末标点：
   - 有句末标点 → 切到最后一个标点，剩余留下等 final
   - 没有标点但已经够长（或停顿够久）→ 整段提交，并把已提交文本记为基线，
     后续 final 重发整段时由 dedupeFinal 剥掉前缀，不会重复翻译 */
function commitPause() {
  const full = state.lastInterim || "";
  if (!full) return;
  let lastEnd = -1;
  for (let i = 0; i < full.length; i++) if (SENT_END.test(full[i])) lastEnd = i;

  let text, rest;
  if (lastEnd >= 3) {
    text = full.slice(0, lastEnd + 1).trim();
    rest = full.slice(lastEnd + 1).trim();
  } else if (full.trim().length >= PAUSE_MIN_LEN) {
    text = full.trim();
    rest = "";
  } else {
    return; // 太短，继续等
  }
  if (text.length < 2) return;
  state.lastInterim = rest;
  handleFinal(text, false, true);
  els.liveText.textContent = rest;
}

/* 会话结束/手动停止时的兜底：把剩余 interim 送出。
   内容仍属于「浏览器未确认」的部分，标记为待校对（不静默丢弃）。 */
function flushInterim() {
  clearTimeout(state.pauseTimer);
  const rest = (state.lastInterim || "").trim();
  state.lastInterim = "";
  asrMetrics._lastResultAt = 0;
  if (rest.length >= 2) handleFinal(rest, true, true);
}

/* 句末没有标点时自动补上，让译文更整齐、也便于按标点断句 */
function ensurePunct(text) {
  if (!text) return text;
  if (/[。！？!?；;…：:,，]$/.test(text)) return text;
  return /[\u4e00-\u9fff]/.test(text) ? text + "。" : text + ".";
}

/* text：要翻译的内容；unconfirmed：浏览器未定稿（会话结束时残留）；
   fromInterim：来自临时结果，需要计入「已提交基线」供 final 去重 */
function handleFinal(text, unconfirmed = false, fromInterim = false) {
  state.started = true;
  els.emptyState.style.display = "none";
  text = (text || "").trim();
  if (!text) return;
  if (fromInterim) {
    state.lastCommitted = (state.lastCommitted + text).trim();
    state.committedAt = Date.now();
  }
  text = ensurePunct(text);
  // 定稿即翻译，不再进缓冲等待，避免内容卡在缓冲里迟迟不出现
  splitChunks(text).forEach((c) => enqueueTranslate(c, true, unconfirmed));
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

function enqueueTranslate(text, isSpeech = false, unconfirmed = false) {
  state.queue = state.queue.then(() => doTranslate(text, isSpeech, unconfirmed)).catch(() => {});
  return state.queue;
}

async function doTranslate(text, isSpeech, unconfirmed = false) {
  const tgtLang = els.selTgt.value;
  const node = createBlock(text);
  node.src = text;
  if (unconfirmed && node.badge) {
    node.badge.textContent = "待校对 · 会话结束时未定稿";
    node.badge.title = "这段文字浏览器还没确认，可能不准确，可用「✎ 修正」改原文";
    node.badge.classList.add("badge-warn");
  }
  state.translating++;
  updateBusy();

  try {
    const d = await api("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text, from: "auto", to: tgtLang, engine: els.selEngine.value }),
    });
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

/* ---------------------------- 开始/停止 ---------------------------- */
async function startListening() {
  if (!SpeechRecognition) {
    alert("请使用 Chrome / Edge 浏览器打开。");
    return;
  }
  state.manualStop = false;
  state.listening = true;
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert("无法访问麦克风，请检查系统权限设置。"); state.listening = false; return; }

  state.recognition = buildRecognition();
  try { state.recognition.start(); } catch (e) { console.warn(e); }
  els.liveArea.hidden = false;
  els.liveText.textContent = "";
  renderMic(true);
  setStatus("识别中…");
}

function stopListening(hard = false) {
  state.manualStop = true;
  state.listening = false;
  clearTimeout(state.restartTimer);
  flushInterim(); // 手动停止也把 interim 尾巴送出去
  if (state.recognition) { try { state.recognition.stop(); } catch { /* ignore */ } }
  stopTts(); // 手动停止时同步中断朗读并清空待播队列
  renderMic(false);
  els.liveArea.hidden = true;
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
  splitChunks(text).forEach((c) => enqueueTranslate(c, false));
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
    theme: els.selTheme.value,
  }));
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("lt.settings") || "{}");
    if (s.tgt) els.selTgt.value = s.tgt;
    if (s.mode) els.selMode.value = s.mode;
    if (s.engine) els.selEngine.value = s.engine;
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

[els.selTgt, els.selMode, els.selEngine].forEach((el) => el.addEventListener("change", saveSettings));
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
