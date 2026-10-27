# 🌐 LiveTranslate — 免费实时语音翻译

**不限时长、无需登录、无需 API Key** 的实时语音翻译网页。听外语会议、和外国人聊天、看带口音的英文视频时，打开即可用。

> 灵感来自 [Maestra Live](https://live.maestra.ai/zh/)，但去掉了它的 10 分钟限制。

## ✨ 功能

- **实时语音识别**：浏览器 Web Speech API，边说边出字
- **自动语言检测**：中英文（及其他 13 种语言）自动切换，无需手动选
- **实时翻译**：微软 Bing 翻译为主引擎（免费、国内直连、质量高），Google / MyMemory / 有道自动降级兜底
- **翻译缓存 + 串行队列**：同样句子秒回，不会重复请求
- **自动朗读译文**：可选，开免提当"同声传译机"用
- **大字幕模式**（⛶）：投屏给对方看
- **导出记录**：一键导出 txt 会议纪要
- **识别模式**：实时（边听边出）/ 整句（说完再出，口音重时更准）
- **长会话稳定**：识别结束自动续接，突破浏览器约 8 秒静音中断的限制

## 🚀 运行

```bash
npm install
npm start
# 打开 http://localhost:3000
```

建议使用 **Chrome / Edge** 浏览器（Safari、Firefox 不支持语音识别）。

## 🏗 架构

```
浏览器（Web Speech API 识别）
   │  final 文本
   ▼
Node/Express 服务端
   │  ├─ 引擎优先级：Bing → Google → MyMemory → 有道（失败自动切换）
   │  ├─ LRU 翻译缓存（30 分钟，800 条）
   │  └─ 本地语言检测（Unicode 区段 + 特征词）
   ▼
译文返回 → 气泡渲染 → 自动朗读（可选）
```

## ⚠️ 说明

- 语音识别由浏览器厂商云端完成（Chrome 用 Google 引擎，对带口音英语、普通话及部分方言适应性较好）；纯方言识别有限，建议方言使用者说普通话。
- Bing 接口为公开 Web 端点，仅供个人学习使用；商业场景请申请 [Azure Translator](https://azure.microsoft.com/products/ai-services/ai-translator) 正式 API。
