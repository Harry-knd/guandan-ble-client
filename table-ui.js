/* 两端唯一的牌桌渲染器，所有文字通过 textContent 写入。 */
(function (root) {
  "use strict";
  function create(document) {
    const $ = id => document.getElementById(id);
    const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
    let lastHandKey = "", lastPlayKey = "", lastEventKey = "", lastRoom = "";
    let roundNotice = "";
    const seatStates = new Map();
    function face(card, button = false) {
      const el = node(button ? "button" : "div", "playing-card" + (card.red ? " red" : ""));
      const label = card.label || "?", suit = (label.match(/[♠♥♣♦]/) || [""])[0];
      const rank = label.split("·")[0].replace(/[♠♥♣♦]/g, "");
      if (rank.includes("王")) el.className += " joker";
      el.setAttribute("aria-label", label); el.setAttribute("data-card-id", String(card.id));
      const corner = node("span", "card-corner");
      corner.replaceChildren(node("b", "card-rank", rank), node("span", "card-suit", suit || "★"));
      const children = [corner, node("span", "card-pip", suit || "★"), node("span", "card-deck", "·" + (Math.floor(card.id / 54) + 1))];
      if (label.includes("♥2")) children.push(node("span", "card-wild", "配"));
      el.replaceChildren(...children);
      return el;
    }
    function render({view, seat, room, ready, pending, selected, seatNotice, toggle}) {
      const me = seat < 0 ? 0 : seat, hand = view && view.hand || [], playing = view && view.phase === "playing";
      const event = view && view.event, eventKey = JSON.stringify(event);
      const newEvent = eventKey !== lastEventKey || lastRoom !== room;
      if (lastRoom !== room || !view || view.phase === "lobby") roundNotice = "";
      if (event && newEvent) {
        if (["game_start", "play"].includes(event.type)) roundNotice = "";
        // 正式事件中的 seat 是最后过牌者，turn 才是本轮重新领出者。
        if (event.type === "trick_end") roundNotice = `本轮结束 · 由席位 ${view.turn} 重新领出`;
      }
      if (view && view.phase === "ended") roundNotice = `本局结束 · ${view.winnerTeam === me % 2 ? "我方获胜！" : "对方获胜"}`;
      if (lastRoom !== room || (eventKey !== lastEventKey && event && ["game_start", "trick_end"].includes(event.type))) seatStates.clear();
      if (event && eventKey !== lastEventKey && ["play", "pass"].includes(event.type)) seatStates.set(event.seat, event.type === "pass" ? "过牌" : "已出牌");
      lastRoom = room; lastEventKey = eventKey;
      $("seats").replaceChildren(...[0,1,2,3].map(i => {
        const s = view && view.seats[i], relative = (i - me + 4) % 4;
        const position = ["bottom", "right", "top", "left"][relative], own = i % 2 === me % 2;
        const active = playing && view.turn === i;
        const el = node("div", `seat seat-${position} ${own ? "our-team" : "their-team"}${active ? " active" : ""}`);
        el.setAttribute("data-seat", String(i));
        const state = !s || !s.occupied ? "等待入座" : active ? (s.bot ? "思考中…" : "出牌中") : seatStates.get(i) || (s.bot ? "机器人" : s.connected ? "已就位" : "断线保留");
        const stack = node("span", "card-stack"); stack.setAttribute("aria-hidden", "true");
        el.replaceChildren(node("span", "team-tag", relative === 0 ? "我 · 我方" : own ? "队友 · 我方" : "对手 · 对方"),
          node("strong", "seat-title", `席位 ${i}${s && s.bot ? " · 机器人" : ""}`), stack,
          node("span", "seat-count", playing || view && view.phase === "ended" ? `${s ? s.remaining : 0} 张` : "— 张"), node("span", "seat-state", state));
        if (seatNotice && seatNotice.seat === i) {
          const notice = node("span", "seat-notice", seatNotice.text);
          notice.setAttribute("role", "status"); el.append(notice);
        }
        return el;
      }));
      const previous = view && view.lastPlay, playKey = JSON.stringify(previous);
      if (playKey !== lastPlayKey) {
        const cards = (previous && previous.cards || []).map(c => face(c));
        $("center-cards").className = cards.length > 3 ? "many-cards" : "";
        const source = previous && previous.seat === me ?
          ($("hand").querySelector && $("hand").querySelector(".selected") || $("hand")) :
          (previous && document.querySelector && document.querySelector(`.seat[data-seat="${previous.seat}"]`));
        const from = source && source.getBoundingClientRect && source.getBoundingClientRect();
        $("center-cards").replaceChildren(...cards);
        if (previous && lastPlayKey && !(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
          // 飞牌放在独立浮层中，避免被手牌/中央横向滚动容器裁切。
          cards.forEach((c, i) => {
            if (!c.animate || !from) return;
            const to = c.getBoundingClientRect(), flying = c.cloneNode(true);
            flying.setAttribute("aria-hidden", "true"); flying.setAttribute("data-card-flight", "true");
            Object.assign(flying.style, {position:"fixed", left:`${to.x}px`, top:`${to.y}px`, width:`${to.width}px`, height:`${to.height}px`, zIndex:"30", pointerEvents:"none", margin:"0"});
            document.body.append(flying); c.style.visibility = "hidden";
            const animation = flying.animate([
              {transform:`translate(${from.x - to.x + i * 4}px, ${from.y - to.y}px) scale(1.1)`, opacity:.65},
              {transform:"translate(0,0) scale(1)", opacity:1}
            ], {duration:360, delay:i * 24, fill:"backwards", easing:"ease-out"});
            const finish = () => { flying.remove(); c.style.visibility = ""; };
            animation.onfinish = finish; animation.oncancel = finish;
          });
        }
        lastPlayKey = playKey;
      }
      const rank = previous && previous.shape.rank;
      $("last-play").textContent = previous ? `${previous.shape.label} / ${({11:"J",12:"Q",13:"K",14:"A",15:"2",16:"小王",17:"大王"})[rank] || rank || ""}` : "自由出牌";
      $("lead").textContent = previous ? `席位 ${previous.seat} 领出 · 等待接牌` : playing ? `席位 ${view.turn} 领出新一轮` : "对家同队 · 固定打 2";
      // 提示保留到下一次出牌；心跳、选牌和拒绝操作不会把它冲掉。
      $("round-notice").textContent = roundNotice;
      $("round-notice").hidden = !roundNotice;
      $("lead").hidden = !!roundNotice;
      $("last-play").hidden = !!roundNotice;
      $("center-cards").hidden = !!roundNotice && !previous;
      $("game-status").textContent = !view || !view.phase || view.phase === "lobby" ? "等待开局" : view.phase === "ended" ?
        (view.winnerTeam === me % 2 ? "我方获胜！" : "对方获胜") : view.turn === me ? "轮到你出牌" :
        `轮到席位 ${view.turn}${view.seats[view.turn].bot ? " · 机器人思考中…" : " · 等待出牌"}`;
      $("game-status").className = playing && view.turn === me ? "turn-banner my-turn" : "turn-banner";
      $("game-event").textContent = event && event.type ? `席位 ${event.seat}${event.source === "bot" ? " · 机器人" : ""} · ${({game_start:"开始发牌",play:"出牌",pass:"过牌",trick_end:"本轮结束",hand_end:"本局结束"})[event.type] || "通信更新"}` : "空位开局自动补机器人";
      $("selection-count").textContent = `已选 ${selected.size} / ${hand.length} 张`;
      $("hand-empty").hidden = hand.length > 0;
      const disabled = !ready || !!pending || !playing;
      const handKey = JSON.stringify([hand, [...selected], disabled]);
      if (lastHandKey !== handKey) {
        const scroll = $("hand").scrollLeft || 0;
        $("hand").replaceChildren(...hand.map(card => {
          const button = face(card, true);
          if (selected.has(card.id)) button.className += " selected";
          button.setAttribute("aria-pressed", String(selected.has(card.id))); button.disabled = disabled;
          button.addEventListener("click", () => { if (!button.disabled) toggle(card.id); });
          return button;
        }));
        $("hand").scrollLeft = scroll; lastHandKey = handKey;
      }
      $("play").disabled = !ready || !!pending || !playing || view.turn !== seat || !view.canPlay || !selected.size;
      // 领出时保留解释入口；点击由共用处理器显示 MUST_PLAY，不发送操作。
      $("pass").disabled = !ready || !!pending || !playing || view.turn !== seat;
      $("pass").textContent = playing && view.turn === seat && !view.canPass ? "过牌（需出牌）" : "过牌";
      $("play").textContent = pending ? "确认中…" : `出牌${selected.size ? ` (${selected.size})` : ""}`;
    }
    return {render, face};
  }
  root.GdTable = {create};
})(typeof window === "object" ? window : globalThis);
