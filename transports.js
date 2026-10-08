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
  // 演示专用单张脚本：保留轮次约束，不参与正式规则或机器人决策。
  class DemoTransport {
    constructor(receive, later = (fn, ms) => setTimeout(fn, ms)) {
      this.receive = receive; this.later = later; this.seq = 0;
      this.passes = 0; this.userPlays = 0; this.botMayBeat = false;
      const card = id => {
        const n = id % 54, rank = n % 13 + 2, suit = ["♠", "♥", "♣", "♦"][Math.floor(n / 13)];
        return { id, label: n >= 52 ? `${n === 52 ? "小王" : "大王"}·${Math.floor(id / 54) + 1}` :
          `${suit}${({11:"J",12:"Q",13:"K",14:"A"})[rank] || rank}·${Math.floor(id / 54) + 1}${n === 13 ? "配" : ""}`,
          red: n === 53 || (n < 52 && [1,3].includes(Math.floor(n / 13))) };
      };
      this.view = { revision: 0, phase: "playing", turn: 0, privateCard: "演示数据", canPlay: true, canPass: true,
        hand: [...Array.from({length: 12}, (_, i) => i + 2), ...Array.from({length: 12}, (_, i) => i + 56), 26, 52, 107].map(card),
        seats: [0,1,2,3].map(seat => ({ seat, occupied: true, connected: true, bot: seat !== 0, remaining: seat === 3 ? 26 : 27 })),
        lastPlay: { seat: 3, cards: [card(1)], shape: {label: "单张", rank: 3} }, event: {number: 0, type: "play", seat: 3, source: "bot"} };
      // 分配剩余实体牌；机器人真正扣牌，不能把已经出过的牌放回桌面。
      const used = new Set([1, ...this.view.hand.map(c => c.id)]);
      const rest = Array.from({length:108}, (_, id) => id).filter(id => !used.has(id)).map(card);
      this.hands = [this.view.hand, rest.slice(0,27), rest.slice(27,54), rest.slice(54)];
    }
    rank(card) {
      const n = card.id % 54;
      return n >= 52 ? n - 36 : n % 13 === 0 ? 15 : n % 13 + 2;
    }
    snapshot(ack = null, status = "ok") {
      this.receive({v:1, type:"snapshot", room:"DEMO", seat:0, seq:this.seq, ack,
        payload: JSON.parse(JSON.stringify({...this.view, revision:this.seq, status}))});
    }
    send(message) {
      const p = message.payload, v = this.view;
      if (message.type === "sync") { this.snapshot(); return Promise.resolve(); }
      if (v.phase !== "playing") { this.snapshot(p.actionId, "HAND_ENDED"); return Promise.resolve(); }
      if (v.turn !== 0) { this.snapshot(p.actionId, "NOT_YOUR_TURN"); return Promise.resolve(); }
      let card = null;
      if (message.type === "play") {
        if (p.cards.length !== 1) { this.snapshot(p.actionId, "DEMO_SINGLE_ONLY"); return Promise.resolve(); }
        card = v.hand.find(c => c.id === p.cards[0]);
        if (!card) { this.snapshot(p.actionId, "NOT_YOUR_CARDS"); return Promise.resolve(); }
        if (v.lastPlay && this.rank(card) <= v.lastPlay.shape.rank) { this.snapshot(p.actionId, "CANNOT_BEAT"); return Promise.resolve(); }
        // 交替演示放行和合法压单张；失败操作不改变脚本节奏。
        this.botMayBeat = ++this.userPlays % 2 === 0;
      } else if (message.type !== "pass" || !v.lastPlay) { this.snapshot(p.actionId, "MUST_PLAY"); return Promise.resolve(); }
      this.advance(0, card, p.actionId);
      return Promise.resolve();
    }
    advance(seat, card, ack = null) {
      const v = this.view;
      this.seq++;
      v.event = {number:this.seq, seat, type:card ? "play" : "pass", source:seat === 0 ? "human" : "bot"};
      v.turn = (seat + 1) % 4;
      if (card) {
        this.hands[seat] = this.hands[seat].filter(c => c.id !== card.id);
        v.hand = this.hands[0]; v.seats[seat].remaining = this.hands[seat].length;
        v.lastPlay = {seat, cards:[card], shape:{label:"单张", rank:this.rank(card)}};
        this.passes = 0;
        if (!this.hands[seat].length) {
          v.phase = "ended"; v.winnerTeam = seat % 2; v.event.type = "hand_end";
        }
      } else if (++this.passes === 3) {
        // 事件席位是最后过牌者；重新领出的席位以 turn 为准，与正式快照一致。
        v.turn = v.lastPlay.seat; v.lastPlay = null; this.passes = 0;
        v.event.type = "trick_end";
      }
      v.canPlay = v.phase === "playing" && (v.turn === 0 || v.event.type === "trick_end");
      v.canPass = v.phase === "playing" && v.turn === 0 && v.lastPlay !== null;
      this.snapshot(ack);
      if (v.phase !== "playing" || v.turn === 0) return;
      // 新轮留出 1.8 秒提示；其他机器人动作也有可见的思考时间。
      this.later(() => this.botStep(), v.event.type === "trick_end" ? 1800 : [0,1000,1200,900][v.turn]);
    }
    botStep() {
      const v = this.view, seat = v.turn;
      const cards = [...this.hands[seat]].sort((a,b) => this.rank(a) - this.rank(b) || a.id - b.id);
      let card = null;
      if (!v.lastPlay) card = cards[0];
      else if (this.botMayBeat && v.lastPlay.seat === 0 && seat === 1) {
        card = cards.find(c => this.rank(c) > v.lastPlay.shape.rank);
        this.botMayBeat = false;
      }
      this.advance(seat, card);
    }
  }
  root.GdTransports = {BluetoothTransport, LocalBridgeTransport, DemoTransport};
})(typeof window === "object" ? window : globalThis);
