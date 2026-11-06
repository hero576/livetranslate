"""LiveTranslate 服务端语音识别（SenseVoice + Silero VAD，基于 sherpa-onnx）。

只监听本机，由 Node（/api/asr）鉴权后转发浏览器的 WebSocket 连接。协议见
docs/asr/v2.1.0-server-asr.md。

一条连接 = 一次识别会话：
  客户端 -> {"type":"start","lang":"auto"}      开始
  客户端 -> 二进制帧：16kHz 单声道 int16 小端 PCM
  客户端 -> {"type":"stop"}                     停止：把未结束的语音段识别完再回 end
  服务端 -> {"type":"ready"}
  服务端 -> {"type":"partial","seg":n,"text":...}  当前语音段的临时结果（会被修订）
  服务端 -> {"type":"final","seg":n,"text":...,"start":秒,"end":秒,"lang":...,"decode_ms":...[,"cut":true]}
            cut=true 表示连续说话超过 ASR_MAX_SEG 被强制切开，后面的话进入下一段
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
GAP_JOIN = int(1.0 * SR)  # 距上一段末尾不到 1 秒就把中间整段补上（VAD 超长切段时会把切口附近的字判成静音）
CUT_FRAME = int(0.03 * SR)  # 强制切段时按 30ms 一帧找最安静的位置
MIN_TAIL = int(0.2 * SR)    # 强制切段后 VAD 再交来的尾巴短于这个就不识别
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
    # 单段硬上限：连续说话超过这么长，在后半段最安静处切开先出 final。
    # Silero VAD 自己的 max_speech 只是临时调高阈值，实测会放出 16～23 秒的段，单次解码慢、内存涨
    p.add_argument("--max-seg", type=float, default=float(os.environ.get("ASR_MAX_SEG", "10")))
    p.add_argument("--max-speech", type=float, default=float(os.environ.get("ASR_MAX_SPEECH", "30")))
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
        self.speech = []           # 当前语音段的音频（含 pre-roll，从 speech_start 起连续到 fed）
        self.speech_start = 0      # speech 第一个采样的绝对位置
        self.speech_len = 0        # speech 的总采样数
        self.recent = np.zeros(0, dtype=np.float32)  # 最近 GAP_JOIN 的音频，语音开始时补到段首
        self.last_end = 0          # 上一个 final 末尾的绝对采样位置，补 pre-roll 不越过它，VAD 交来的段也从这里截
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
            if self.vad.is_speech_detected() and not self.in_speech:
                # VAD 判定语音开始有延迟，段首常被吃掉一两个字：带上之前最多 0.4 秒，但不越过上一段末尾
                gap = max(0, self.fed - n - self.last_end)
                k = min(self.recent.size, gap if gap <= GAP_JOIN else PREROLL)
                pre = self.recent[self.recent.size - k:]
                self.in_speech = True
                self.speech = [pre]
                self.speech_len = pre.size
                self.speech_start = self.fed - n - pre.size
                self.since_partial = 0
            if self.in_speech:
                self.speech.append(buf[:n])
                self.speech_len += n
                self.since_partial += n
            self.recent = np.concatenate([self.recent, buf[:n]])[-GAP_JOIN:]
            await self.drain()
            if self.in_speech and self.speech_len >= self.e.args.max_seg * SR:
                await self.force_cut()
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

    async def split(self, at, cut=False):
        """把当前语音段在绝对位置 at 处切开：前面出 final，后面留作下一段的开头。"""
        audio = np.concatenate(self.speech) if self.speech else np.zeros(0, dtype=np.float32)
        k = min(max(at - self.speech_start, 0), audio.size)
        start = self.speech_start
        self.speech = [audio[k:]]
        self.speech_len = audio.size - k
        self.speech_start = start + k
        self.since_partial = self.speech_len
        self.last_end = self.speech_start
        await self.emit_final(audio[:k], start, cut)

    def end_speech(self):
        self.in_speech = False
        self.speech = []
        self.speech_len = 0
        self.since_partial = 0

    async def force_cut(self):
        """连续说话太长：在后半段最安静的 30ms 处切开，前半段立即出 final，后半段接着当新的一段。"""
        audio = np.concatenate(self.speech)
        lo = audio.size // 2
        hi = audio.size - MIN_TAIL
        frames = audio[lo:hi][: (hi - lo) // CUT_FRAME * CUT_FRAME].reshape(-1, CUT_FRAME)
        cut = lo + int(np.argmin((frames ** 2).mean(axis=1))) * CUT_FRAME + CUT_FRAME // 2
        await self.split(self.speech_start + cut, cut=True)

    async def drain(self):
        """VAD 产出的完整语音段：只用它的结束位置。音频取自本地连续记录的当前段，
        这样 VAD 自己超长切段时两段之间被它判成静音的那一小截也不会丢。"""
        while not self.vad.empty():
            front = self.vad.front
            s0 = front.start
            e = s0 + len(front.samples)
            if not self.in_speech:  # 兜底：没跟踪到这段的开始，直接用 VAD 的音频
                samples = np.array(front.samples, dtype=np.float32)
                self.vad.pop()
                if s0 < self.last_end:
                    samples = samples[self.last_end - s0:]
                    s0 = self.last_end
                self.last_end = s0 + samples.size
                await self.emit_final(samples, s0)
                continue
            self.vad.pop()
            await self.split(e)
            if not self.vad.is_speech_detected():
                self.end_speech()

    async def emit_final(self, samples, s0, cut=False):
        seg = self.seg
        self.seg += 1
        if samples.size < MIN_TAIL:  # 只剩一点尾音：发空 final，让前端撤掉这一段的临时气泡
            text, lang, ms = "", "", 0
        else:
            text, lang, ms = await self.e.run_decode(samples)
        start = s0 / SR
        msg = {"type": "final", "seg": seg, "text": text, "start": round(start, 2),
               "end": round(start + samples.size / SR, 2), "lang": lang, "decode_ms": ms}
        if cut:
            msg["cut"] = True
        await self.send(msg)
        log.info("final seg=%d %.2f-%.2fs decode=%dms%s %s", seg, start, start + samples.size / SR, ms,
                 " cut" if cut else "", text[:40])

    async def stop(self):
        if self.partial_task and not self.partial_task.done():
            self.partial_task.cancel()
        if self.pending.size:
            pad = np.zeros(VAD_WINDOW - self.pending.size, dtype=np.float32)
            self.vad.accept_waveform(np.concatenate([self.pending, pad]))
            self.fed += VAD_WINDOW
            if self.in_speech:
                self.speech.append(np.concatenate([self.pending, pad]))
                self.speech_len += VAD_WINDOW
            self.pending = np.zeros(0, dtype=np.float32)
        self.vad.flush()
        await self.drain()
        if self.in_speech and self.speech_len >= MIN_TAIL:
            await self.split(self.speech_start + self.speech_len)
        self.end_speech()
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
