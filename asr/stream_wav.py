"""把 wav 文件按实时速度推给识别服务，用于部署后的冒烟测试。

  python asr/stream_wav.py ws://127.0.0.1:8011 test.wav [--speed 1] [--token xxx]
经 Node 转发测试时 URL 用 ws://127.0.0.1:8010/api/asr，并带 --token（登录得到的 token）。
"""
import argparse
import asyncio
import json
import time
import wave

import numpy as np
import websockets


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("wav")
    p.add_argument("--speed", type=float, default=1.0)
    p.add_argument("--token", default="")
    a = p.parse_args()
    w = wave.open(a.wav)
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, "需要 16k 单声道 16bit wav"
    pcm = w.readframes(w.getnframes())
    url = a.url + (("&" if "?" in a.url else "?") + "token=" + a.token if a.token else "")
    t0 = time.time()
    async with websockets.connect(url, max_size=1 << 20) as ws:
        async def reader():
            async for m in ws:
                d = json.loads(m)
                print(f"{time.time() - t0:6.2f}s {d['type']:8s} {json.dumps({k: v for k, v in d.items() if k != 'type'}, ensure_ascii=False)}")
                if d["type"] in ("end", "error"):
                    return
        rt = asyncio.create_task(reader())
        await ws.send(json.dumps({"type": "start", "lang": "auto"}))
        chunk = 1600 * 2  # 100ms
        for i in range(0, len(pcm), chunk):
            await ws.send(pcm[i:i + chunk])
            await asyncio.sleep(0.1 / a.speed)
        print(f"{time.time() - t0:6.2f}s -- audio sent, stop")
        await ws.send(json.dumps({"type": "stop"}))
        await rt


asyncio.run(main())
