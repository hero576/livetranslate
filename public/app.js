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
  lastInterim: "",
  interimCommitted: 0,
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

function buildRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = recognitionLang();
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    asrMetrics._sessStart = performance.now();
    asrMetrics._firstSeen = false;
    if (asrMetrics._endAt) {
      asrPush(asrMetrics.recover, performance.now() - asrMetrics._endAt);
      asrMetrics._endAt = 0;
    }
    setStatus("识别中…");
  };

  rec.onresult = (event) => {
    const nowTs = performance.now();
    if (!asrMetrics._firstSeen && asrMetrics._sessStart) {
      asrMetrics._firstSeen = true;
      asrPush(asrMetrics.first, nowTs - asrMetrics._sessStart);
    }
    let interim = "", finalized = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      const txt = (r[0]?.transcript || "").trim();
      if (!txt) continue;
      if (r.isFinal) finalized += (finalized ? " " : "") + txt;
      else interim += (interim ? " " : "") + txt;
    }
    if (finalized) {
      // 停顿确认延迟：final 与上一个识别事件的间隔（浏览器端点检测耗时）
      asrPush(asrMetrics.confirm, nowTs - (asrMetrics._lastResultAt || nowTs));
    }
    asrMetrics._lastResultAt = nowTs;
    if (interim) {
      state.lastInterim = interim;
      els.liveArea.hidden = false;
      els.liveText.textContent = interim.slice(state.interimCommitted);
      els.liveLang.textContent = "正在听…";
      els.emptyState.style.display = "none";
      // 「实时」模式：边听边出——长句提前切分 + 停顿自动提交；
      // 「整句」模式：interim 只显示，等 final 定稿后再翻译（更准）。
      if (els.selMode.value === "dictation") {
        commitInterimChunk(interim);
        armPauseCommit();
      }
    }
    if (finalized) {
      clearTimeout(state.pauseTimer);
      // 已通过 interim 提前提交过的前缀，从 final 里剥离，避免重复翻译
      let remain = finalized;
      if (state.interimCommitted > 0 && state.lastInterim &&
          finalized.startsWith(state.lastInterim.slice(0, state.interimCommitted))) {
        remain = finalized.slice(state.interimCommitted).trim();
      }
      if (remain) handleFinal(remain);
      state.lastInterim = "";
      state.interimCommitted = 0;
      els.liveText.textContent = "";
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
        try { rec.lang = recognitionLang(); rec.start(); setStatus("识别中…"); } catch { /* ignore */ }
      }, 120);
    }
  };

  return rec;
}

function recognitionLang() {
  const v = els.selSrc.value;
  if (v === "auto") return navigator.language || "zh-CN";
  return BCP47[v] || v;
}

/* 断句优化：interim 是「当前这句」的累积文本，随着说话持续增长。
   当它够长或遇到句末标点时，把已完整的一部分提前提交，避免：
   - 超长句把识别引擎撑爆后只吐出开头一小段；
   - 静音结束/自动重启时把后半段丢掉。 */
function commitInterimChunk(interim) {
  const uncommitted = interim.slice(state.interimCommitted);
  if (uncommitted.length < 40) return;

  let cut = -1;
  for (const p of ["。", "！", "？", "!", "?", "；", ";", "\n", "."]) {
    const i = uncommitted.lastIndexOf(p);
    if (i > cut) cut = i;
  }

  if (cut < 6) {
    // 没有句末标点：找最后一个空格；再不行就超长硬切
    const sp = uncommitted.lastIndexOf(" ");
    if (sp > 24) cut = sp;
    else if (uncommitted.length >= 90) cut = 89;
    else return;
  }

  const text = uncommitted.slice(0, cut + 1).trim();
  if (text.length >= 4) {
    handleFinal(text);
    state.interimCommitted += cut + 1;
    els.liveText.textContent = interim.slice(state.interimCommitted);
  }
}

/* 停顿自动提交：说话者短暂停顿时（无新识别结果），把已累积的 interim 提交。
   解决「整句说完但没有标点、Chrome 迟迟不给 final」导致的内容卡住。 */
function armPauseCommit() {
  clearTimeout(state.pauseTimer);
  state.pauseTimer = setTimeout(commitPause, 700);
}

function commitPause() {
  const full = state.lastInterim || "";
  const rest = full.slice(state.interimCommitted).trim();
  if (rest.length >= 2) {
    handleFinal(rest);
    state.interimCommitted = full.length; // 标记已提交，final 到来时剥离，避免重复
    els.liveText.textContent = "";
  }
}

/* 把当前还没提交的 interim 尾巴也送出去 */
function flushInterim() {
  clearTimeout(state.pauseTimer);
  const rest = (state.lastInterim || "").slice(state.interimCommitted).trim();
  state.lastInterim = "";
  state.interimCommitted = 0;
  if (rest.length >= 2) handleFinal(rest);
}

/* 句末没有标点时自动补上，让译文更整齐、也便于按标点断句 */
function ensurePunct(text) {
  if (!text) return text;
  if (/[。！？!?；;…：:,，]$/.test(text)) return text;
  return /[\u4e00-\u9fff]/.test(text) ? text + "。" : text + ".";
}

function handleFinal(text) {
  state.started = true;
  els.emptyState.style.display = "none";
  text = (text || "").trim();
  if (!text) return;
  text = ensurePunct(text);
  // 定稿即翻译，不再进缓冲等待，避免内容卡在缓冲里迟迟不出现
  splitChunks(text).forEach((c) => enqueueTranslate(c, true));
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

function enqueueTranslate(text, isSpeech = false) {
  state.queue = state.queue.then(() => doTranslate(text, isSpeech)).catch(() => {});
  return state.queue;
}

async function doTranslate(text, isSpeech) {
  const tgtLang = els.selTgt.value;
  const node = createBlock(text);
  node.src = text;
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
    if (fromLabel) node.badge.textContent = d.skipped ? `${fromLabel}（已是目标语言）` : `${fromLabel} → ${LANG_NAME[tgtLang] || tgtLang}`;

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
els.selSrc.addEventListener("change", () => { if (state.listening) { try { state.recognition.stop(); } catch { /* onend restart */ } } });
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
