"""LiveTranslate 服务端语音识别（SenseVoice + Silero VAD，基于 sherpa-onnx）。

只监听本机，由 Node（/api/asr）鉴权后转发浏览器的 WebSocket 连接。协议见
docs/asr/v2.1.0-server-asr.md。

一条连接 = 一次识别会话：
  客户端 -> {"type":"start","lang":"auto"}      开始
  客户端 -> 二进制帧：16kHz 单声道 int16 小端 PCM
  客户端 -> {"type":"stop"}                     停止：把未结束的语音段识别完再回 end
  服务端 -> {"type":"ready"}
  服务端 -> {"type":"partial","seg":n,"text":...}  当前语音段的临时结果（会被修订）
  服务端 -> {"type":"final","seg":n,"text":...,"start":秒,"end":秒,"lang":...,"decode_ms":...}
  服务端 -> {"type":"end"}
"""

import argparse
import asyncio
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import sherpa_onnx
import websockets

SR = 16000
VAD_WINDOW = 512
PREROLL = int(0.4 * SR)  # partial 从检测到语音前 0.4 秒开始，避免吃掉开头的字（VAD 判定有延迟）
LANG_TAGS = {"zh", "en", "yue", "ja", "ko"}

log = logging.getLogger("asr")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default=os.environ.get("ASR_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", "8011")))
    p.add_argument("--model-dir", default=os.environ.get("ASR_MODEL_DIR", "/opt/asr/models/sense-voice"))
    p.add_argument("--vad", default=os.environ.get("ASR_VAD_MODEL", "/opt/asr/models/silero_vad.onnx"))
    p.add_argument("--threads", type=int, default=int(os.environ.get("ASR_THREADS", "1")))
    p.add_argument("--workers", type=int, default=int(os.environ.get("ASR_WORKERS", "2")))
    p.add_argument("--max-streams", type=int, default=int(os.environ.get("ASR_MAX_STREAMS", "4")))
    # 两次临时识别之间至少间隔的音频时长；语音段越长，单次解码越慢，间隔会自动拉长
    p.add_argument("--partial-interval", type=float, default=float(os.environ.get("ASR_PARTIAL_INTERVAL", "0.8")))
    p.add_argument("--max-speech", type=float, default=float(os.environ.get("ASR_MAX_SPEECH", "15")))
    p.add_argument("--min-silence", type=float, default=float(os.environ.get("ASR_MIN_SILENCE", "0.5")))
    return p.parse_args()


class Engine:
    def __init__(self, args):
        t0 = time.time()
        d = args.model_dir
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(d, "model.int8.onnx"),
            tokens=os.path.join(d, "tokens.txt"),
            num_threads=args.threads,
            use_itn=True,
            language="auto",
        )
        self.vad_config = sherpa_onnx.VadModelConfig()
        self.vad_config.silero_vad.model = args.vad
        self.vad_config.silero_vad.min_silence_duration = args.min_silence
        self.vad_config.silero_vad.max_speech_duration = args.max_speech
        self.vad_config.sample_rate = SR
        self.pool = ThreadPoolExecutor(max_workers=args.workers)
        self.args = args
        self.active = 0
        log.info("model loaded in %.1fs", time.time() - t0)

    def new_vad(self):
        return sherpa_onnx.VoiceActivityDetector(self.vad_config, buffer_size_in_seconds=60)

    def decode(self, samples):
        t = time.time()
        s = self.recognizer.create_stream()
        s.accept_waveform(SR, samples)
        self.recognizer.decode_stream(s)
        r = s.result
        lang = (r.lang or "").strip("<|>")
        return r.text.strip(), lang if lang in LANG_TAGS else "", int((time.time() - t) * 1000)

    async def run_decode(self, samples):
        return await asyncio.get_running_loop().run_in_executor(self.pool, self.decode, samples)


class Session:
    """单个连接的识别状态。VAD 负责断句：一个语音段结束就整段识别并发 final；
    语音段进行中每隔一段音频把已有部分重新识别一次，作为 partial。"""

    def __init__(self, engine, ws):
        self.e = engine
        self.ws = ws
        self.vad = engine.new_vad()
        self.pending = np.zeros(0, dtype=np.float32)  # 还没喂给 VAD 的尾巴（不足一个窗口）
        self.fed = 0               # 已喂给 VAD 的总采样数
        self.seg = 0               # 当前语音段编号（final 后 +1）
        self.speech = []           # 当前语音段（VAD 检测到语音后）的音频，用于 partial
        self.recent = np.zeros(0, dtype=np.float32)  # 最近 PREROLL 的音频，语音开始时补到 partial 前面
        self.pre = np.zeros(0, dtype=np.float32)  # 语音开始时的 recent 快照
        self.pre_end = 0           # pre 末尾对应的绝对采样位置
        self.last_end = 0          # 上一个 final 末尾的绝对采样位置，补 pre-roll 不越过它
        self.in_speech = False
        self.since_partial = 0     # 距上次 partial 新增的采样数
        self.partial_task = None
        self.last_partial_cost = 0.0
        self.closed = False

    async def send(self, obj):
        if self.closed:
            return
        try:
            await self.ws.send(json.dumps(obj, ensure_ascii=False))
        except websockets.ConnectionClosed:
            self.closed = True

    async def feed(self, pcm16: bytes):
        x = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        buf = np.concatenate([self.pending, x]) if self.pending.size else x
        n = (buf.size // VAD_WINDOW) * VAD_WINDOW
        for i in range(0, n, VAD_WINDOW):
            self.vad.accept_waveform(buf[i:i + VAD_WINDOW])
        self.pending = buf[n:].copy()
        self.fed += n
        if n:
            if self.vad.is_speech_detected():
                if not self.in_speech:
                    self.in_speech = True
                    self.speech = [self.recent]
                    self.pre = self.recent
                    self.pre_end = self.fed - n
                    self.since_partial = 0
                self.speech.append(buf[:n])
                self.since_partial += n
            self.recent = np.concatenate([self.recent, buf[:n]])[-PREROLL:]
            await self.drain()
            self.maybe_partial()

    def maybe_partial(self):
        if not self.in_speech or (self.partial_task and not self.partial_task.done()):
            return
        # 解码越慢，间隔越长，避免 CPU 被临时结果占满
        need = max(self.e.args.partial_interval, self.last_partial_cost * 2) * SR
        if self.since_partial < need:
            return
        self.since_partial = 0
        audio = np.concatenate(self.speech)
        seg = self.seg
        self.partial_task = asyncio.create_task(self.do_partial(seg, audio))

    async def do_partial(self, seg, audio):
        text, _, ms = await self.e.run_decode(audio)
        self.last_partial_cost = ms / 1000
        if text and seg == self.seg and self.in_speech:
            await self.send({"type": "partial", "seg": seg, "text": text})

    async def drain(self):
        """VAD 产出的完整语音段：按顺序识别、发 final。"""
        while not self.vad.empty():
            front = self.vad.front
            samples = np.array(front.samples, dtype=np.float32)
            s0 = front.start
            self.vad.pop()
            # VAD 判定语音开始有延迟，段首常被吃掉一两个字：用 pre-roll 补回，但不越过上一段末尾
            lo = max(self.pre_end - self.pre.size, s0 - PREROLL, self.last_end)
            if lo < s0 <= self.pre_end:
                samples = np.concatenate([self.pre[lo - (self.pre_end - self.pre.size):s0 - (self.pre_end - self.pre.size)], samples])
                s0 = lo
            self.last_end = s0 + samples.size
            start = s0 / SR
            seg = self.seg
            self.seg += 1
            self.in_speech = False
            self.speech = []
            self.since_partial = 0
            text, lang, ms = await self.e.run_decode(samples)
            end = start + samples.size / SR
            await self.send({"type": "final", "seg": seg, "text": text, "start": round(start, 2),
                             "end": round(end, 2), "lang": lang, "decode_ms": ms})
            log.info("final seg=%d %.1fs decode=%dms %s", seg, samples.size / SR, ms, text[:40])

    async def stop(self):
        if self.partial_task and not self.partial_task.done():
            self.partial_task.cancel()
        if self.pending.size:
            pad = np.zeros(VAD_WINDOW - self.pending.size, dtype=np.float32)
            self.vad.accept_waveform(np.concatenate([self.pending, pad]))
            self.pending = np.zeros(0, dtype=np.float32)
        self.vad.flush()
        await self.drain()
        await self.send({"type": "end"})


async def handler(engine, ws):
    if engine.active >= engine.args.max_streams:
        await ws.send(json.dumps({"type": "error", "error": "busy", "message": "识别服务繁忙，请稍后再试"}))
        await ws.close(1013, "busy")
        return
    engine.active += 1
    sess = Session(engine, ws)
    started = False
    t0 = time.time()
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                if started and msg:
                    await sess.feed(msg)
                continue
            try:
                m = json.loads(msg)
            except ValueError:
                continue
            if m.get("type") == "start":
                started = True
                await sess.send({"type": "ready"})
            elif m.get("type") == "stop":
                await sess.stop()
                break
    except websockets.ConnectionClosed:
        pass
    finally:
        sess.closed = True
        engine.active -= 1
        log.info("session closed: %.0fs audio, %.0fs wall, %d segments",
                 sess.fed / SR, time.time() - t0, sess.seg)


async def main():
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = Engine(args)
    async with websockets.serve(lambda ws: handler(engine, ws), args.host, args.port,
                                max_size=1 << 20, ping_interval=20, ping_timeout=20):
        log.info("ASR listening on %s:%d", args.host, args.port)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
