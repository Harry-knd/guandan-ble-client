/* 页面只消费快照；正式牌型裁决仍由安卓权威引擎完成。 */
(function (root) {
  "use strict";
  class BluetoothTransport {
    constructor(write, receive) { this.write = write; this.receive = receive; }
    send(message) { return this.write(message); }
    deliver(message) { this.receive(message); }
  }
  class LocalBridgeTransport {
    constructor(bridge, receive) { this.bridge = bridge; this.receive = receive; }
    send(message) {
      try { this.bridge.send(JSON.stringify(message)); return Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    }
    deliver(message) { this.receive(message); }
  }
  // 演示专用脚本：只演示单张与三家过牌，不复制正式规则或机器人。
  class DemoTransport {
    constructor(receive, later = (fn, ms) => setTimeout(fn, ms)) {
      this.receive = receive; this.later = later; this.seq = 0;
      const card = id => {
        const n = id % 54, rank = n % 13 + 2, suit = ["♠", "♥", "♣", "♦"][Math.floor(n / 13)];
        return { id, label: n >= 52 ? `${n === 52 ? "小王" : "大王"}·${Math.floor(id / 54) + 1}` :
          `${suit}${({11:"J",12:"Q",13:"K",14:"A"})[rank] || rank}·${Math.floor(id / 54) + 1}${n === 13 ? "配" : ""}`,
          red: n === 53 || (n < 52 && [1,3].includes(Math.floor(n / 13))) };
      };
      this.view = { revision: 0, phase: "playing", turn: 0, privateCard: "演示数据", canPlay: true, canPass: true,
        hand: [...Array.from({length: 12}, (_, i) => i + 2), ...Array.from({length: 12}, (_, i) => i + 56), 26, 52, 107].map(card),
        seats: [0,1,2,3].map(seat => ({ seat, occupied: true, connected: true, bot: seat !== 0, remaining: seat === 3 ? 26 : 27 })),
        lastPlay: { seat: 3, cards: [card(1)], shape: {label: "单张", rank: 3} }, event: {number: 0, type: "play", seat: 3} };
    }
    snapshot(ack = null, status = "ok") {
      this.receive({v:1, type:"snapshot", room:"DEMO", seat:0, seq:this.seq, ack,
        payload: JSON.parse(JSON.stringify({...this.view, revision:this.seq, status}))});
    }
    send(message) {
      const p = message.payload, v = this.view;
      if (message.type === "sync") { this.snapshot(); return Promise.resolve(); }
      if (v.turn !== 0 || v.phase !== "playing") { this.snapshot(p.actionId, "NOT_YOUR_TURN"); return Promise.resolve(); }
      if (message.type === "play") {
        if (p.cards.length !== 1) { this.snapshot(p.actionId, "DEMO_SINGLE_ONLY"); return Promise.resolve(); }
        const c = v.hand.find(c => c.id === p.cards[0]);
        if (!c) { this.snapshot(p.actionId, "NOT_YOUR_CARDS"); return Promise.resolve(); }
        const n = c.id % 54, rank = n >= 52 ? n - 36 : n % 13 === 0 ? 15 : n % 13 + 2;
        if (v.lastPlay && rank <= v.lastPlay.shape.rank) { this.snapshot(p.actionId, "CANNOT_BEAT"); return Promise.resolve(); }
        v.hand = v.hand.filter(x => x.id !== c.id); v.seats[0].remaining = v.hand.length;
        v.lastPlay = {seat:0, cards:[c], shape:{label:"单张", rank}};
      } else if (message.type !== "pass" || !v.canPass) { this.snapshot(p.actionId, "MUST_PLAY"); return Promise.resolve(); }
      const passed = message.type === "pass";
      this.seq++; v.event = {number:this.seq, seat:0, type:message.type};
      v.canPlay = false; v.canPass = false; v.turn = 1;
      if (!v.hand.length) { v.phase = "ended"; v.winnerTeam = 0; }
      this.snapshot(p.actionId);
      if (v.phase === "ended") return Promise.resolve();
      const step = i => this.later(() => {
        this.seq++; v.event = {number:this.seq, seat:i, type:"pass", source:"bot"}; v.turn = (i + 1) % 4;
        if (i === 3) {
          v.lastPlay = null; v.canPlay = true; v.canPass = false;
          v.event = {number:this.seq, seat:0, type:"trick_end", source:"demo"};
          // 选择过牌时重置演示场景；不将脚本演示当作正式游戏。
          if (passed) { v.lastPlay = {seat:3, cards:[{id:1,label:"♠3·1",red:false}], shape:{label:"单张",rank:3}}; v.canPass = true; }
        }
        this.snapshot(); if (i < 3) step(i + 1);
      }, [0, 1000, 1200, 900][i]);
      step(1); return Promise.resolve();
    }
  }
  root.GdTransports = {BluetoothTransport, LocalBridgeTransport, DemoTransport};
})(typeof window === "object" ? window : globalThis);
