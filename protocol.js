/* 字节级分帧：支持中文跨 BLE 包边界；浏览器与 Node 测试共用。 */
(function (root) {
  "use strict";
  const SERVICE = "c8571000-7f5a-4c49-8c36-7e345d142001";
  const WRITE = "c8571001-7f5a-4c49-8c36-7e345d142001";
  const NOTIFY = "c8571002-7f5a-4c49-8c36-7e345d142001";
  const MAX_FRAME = 8192;
  const CLIENT_VERSION = "0.1.1";
  const SILENCE_MS = 30000, HEARTBEAT_MS = 3000, HIDDEN_HEARTBEAT_MS = 5000;
  function stale(now, lastRx) { return now - lastRx > SILENCE_MS; }
  function reconnectDelay(attempt) { return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)); }
  function validate(m) {
    if (!m || m.v !== 1 || typeof m.room !== "string" || !Number.isSafeInteger(m.seat) ||
      !Number.isSafeInteger(m.seq) || !(m.ack === null || typeof m.ack === "string") ||
      typeof m.type !== "string" || !m.payload || typeof m.payload !== "object" || Array.isArray(m.payload)) {
      throw new Error("协议字段错误");
    }
    return m;
  }
  function encode(m) {
    const bytes = new TextEncoder().encode(JSON.stringify(validate(m)) + "\n");
    if (bytes.length > MAX_FRAME + 1) throw new Error("帧过大");
    return bytes;
  }
  class Decoder {
    constructor() { this.bytes = []; }
    feed(chunk) {
      const messages = [];
      for (const byte of chunk) {
        if (byte === 10) {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(this.bytes));
          this.bytes = [];
          messages.push(validate(JSON.parse(text)));
        } else {
          if (this.bytes.length >= MAX_FRAME) throw new Error("帧过大");
          this.bytes.push(byte);
        }
      }
      return messages;
    }
  }
  // 下行 GD + 大端 uint32 包号；重发只再次确认，绝不重复拼入 JSON。
  class NotificationDecoder {
    constructor() { this.decoder = new Decoder(); this.serial = 0; this.framed = null; }
    feed(chunk) {
      // 兼容旧房主，升级测试仍须同时更新 APK 与网页。
      if (this.framed === null) this.framed = chunk[0] === 0x47;
      if (!this.framed) return { messages: this.decoder.feed(chunk), ack: null };
      if (chunk.length <= 6 || chunk[0] !== 0x47 || chunk[1] !== 0x44) throw new Error("通知分片头错误");
      const id = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(2);
      if (!id || id > this.serial + 1) throw new Error("通知分片跳号");
      const ack = chunk.slice(0, 6);
      if (id <= this.serial) return { messages: [], ack };
      const messages = this.decoder.feed(chunk.slice(6));
      this.serial = id;
      return { messages, ack };
    }
  }
  function message(room, seat, seq, type, payload) { return { v: 1, room, seat, seq, ack: null, type, payload }; }
  function percentile95(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  const api = { SERVICE, WRITE, NOTIFY, MAX_FRAME, Decoder, NotificationDecoder, encode, validate, message, percentile95,
    CLIENT_VERSION, SILENCE_MS, HEARTBEAT_MS, HIDDEN_HEARTBEAT_MS, stale, reconnectDelay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BleWire = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
