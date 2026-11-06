/* 麦克风音频 → 16kHz 单声道 int16 PCM，每 100ms 发一块给主线程（再由主线程经 WebSocket 发给服务器）。
   重采样用区间平均（boxcar）：48k/44.1k 等任意采样率都适用，平均本身也起到低通、防混叠的作用。 */
const OUT_RATE = 16000;
const CHUNK = 1600; // 100ms

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.next = this.ratio;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.buf = new Int16Array(CHUNK);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.cnt++;
      this.pos++;
      if (this.pos < this.next) continue;
      const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
      this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.acc = 0;
      this.cnt = 0;
      this.next += this.ratio;
      if (this.len === CHUNK) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK);
        this.len = 0;
      }
    }
    // 防止长时间运行后浮点累积误差变大
    if (this.pos > 1e7) { this.pos -= 1e7; this.next -= 1e7; }
    return true;
  }
}

registerProcessor("pcm16k", Pcm16kProcessor);
