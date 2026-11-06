# LiveTranslate 文档

每次修改代码都要在这里留下对应的文档：说明为什么改、改了什么、怎么验证。

| 文档 | 内容 |
| --- | --- |
| [asr/v2.0.1-recognition-integrity.md](asr/v2.0.1-recognition-integrity.md) | V2.0.1：语音识别完整性修复（临时气泡、final 判重、停止顺序、重启状态机、中断提示） |
| [asr/v2.1.0-server-asr.md](asr/v2.1.0-server-asr.md) | V2.1.0：服务端语音识别（浏览器只采集音频，服务器 SenseVoice + Silero VAD 识别；协议、部署、断线缓存、回退）；变更记录 V2.1.1：单段 10 秒硬上限，以及 11-06 服务器卡死事件 |
| [deploy/staging.md](deploy/staging.md) | 测试版部署：同域名按 cookie 分流到 8010，独立数据库，用于真机验证 PR |

## 约定

- 文档按模块放子目录，例如 `asr/`（语音识别）、`translation/`（翻译）、`server/`（服务端）。
- 文件名用 `版本号-主题.md`，同一主题后续再改时在原文档末尾追加「变更记录」。
- 每篇文档至少包含：背景/问题、方案、涉及代码、验证方法、已知限制。
