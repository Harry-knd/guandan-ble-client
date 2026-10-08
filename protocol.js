/* 字节级分帧：支持中文跨 BLE 包边界；浏览器与 Node 测试共用。 */
(function (root) {
  "use strict";
  const SERVICE = "c8571000-7f5a-4c49-8c36-7e345d142001";
  const WRITE = "c8571001-7f5a-4c49-8c36-7e345d142001";
  const NOTIFY = "c8571002-7f5a-4c49-8c36-7e345d142001";
  const MAX_FRAME = 8192;
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
  function message(room, seat, seq, type, payload) { return { v: 1, room, seat, seq, ack: null, type, payload }; }
  function percentile95(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  const api = { SERVICE, WRITE, NOTIFY, MAX_FRAME, Decoder, encode, validate, message, percentile95 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BleWire = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
