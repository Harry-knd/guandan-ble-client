/* 仅使用标准 Web Bluetooth。没有服务器、CDN、模拟房主或预填私牌。 */
(function () {
  "use strict";
  const W = window.BleWire;
  const $ = id => document.getElementById(id);
  let device, tx, rx, decoder = new W.NotificationDecoder();
  let generation = 0, connecting = false, ready = false, intentional = true;
  let seat = -1, room = "", seq = 0, revision = -1, view = null, joinId = "";
  let record = null, storageKey = "", pending = null, busy = false, writeChunk = 20;
  let lastRx = 0, lastSync = 0, lastAttempt = 0, lastChange = performance.now();
  let retryAt = 0, lostAt = 0, reconnectAttempts = 0, healthySince = 0, writeChain = Promise.resolve();
  let stoppedReason = "";
  const selected = new Set();
  let wakeLock = null, wakeRequest = false;
  const errorText = code => ({ INVALID_SHAPE: "不是合法牌型", CANNOT_BEAT: "压不过", NOT_YOUR_TURN: "还没轮到你",
    MUST_PLAY: "新一轮必须出牌，不能过牌", INVALID_CARDS: "请选择有效手牌", NOT_YOUR_CARDS: "选中的牌不在你的手牌中",
    NOT_STARTED: "请等待房主开始游戏", HAND_ENDED: "本局已结束", STALE_SEQ: "牌局已变化，请重新操作",
    GAME_IN_PROGRESS: "本局已开始，新玩家请等下一局再加入", GAME_MODE: "游戏中不能发送通信测试消息"
  }[code] || code);
  async function keepAwake() {
    if (!ready || document.hidden || wakeLock || wakeRequest) return;
    wakeRequest = true;
    try {
      if (!navigator.wakeLock) throw new Error("不可用");
      const lock = await navigator.wakeLock.request("screen");
      if (!ready || document.hidden) { await lock.release(); return; }
      wakeLock = lock;
      $("wake").textContent = "屏幕常亮已开启；请保持 Bluefy 在前台。";
      lock.addEventListener("release", () => {
        if (wakeLock !== lock) return;
        wakeLock = null;
        $("wake").textContent = "屏幕常亮已释放，请把自动锁定设为永不，并保持页面前台。";
      });
    } catch (_) { $("wake").textContent = "无法开启屏幕常亮，请把自动锁定设为永不，并保持页面前台。"; }
    finally { wakeRequest = false; }
  }
  function clearSelection() { selected.clear(); }
  function releaseAwake() {
    const lock = wakeLock; wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }
  const events = [], rtts = [];
  let droppedLogs = 0;
  function log(kind, data) {
    const event = { time: Date.now(), kind, ...data };
    events.push(event);
    if (events.length > 50000) { events.shift(); droppedLogs++; }
    $("log").textContent = events.slice(-35).map(e => {
      if (e.kind === "rx") return `${e.time} 收到 ${e.message.type} seq=${e.message.seq} status=${e.message.payload.status}`;
      return JSON.stringify(e);
    }).join("\n");
  }
  function status(text) { $("status").textContent = text; }
  function randomHex(size) { return Array.from(crypto.getRandomValues(new Uint8Array(size)), x => x.toString(16).padStart(2, "0")).join(""); }
  function save() {
    if (!record) return;
    record.pending = pending; record.room = room || record.room || "";
    try { localStorage.setItem(storageKey, JSON.stringify(record)); }
    catch (_) { log("warning", { text: "本地存储不可用：当前页面可重连；关闭页面后无法保证恢复席位" }); }
  }
  function loadRecord() {
    // 同一设备在同一 origin 下保持凭据；没有稳定 id 的容器使用广告名作为索引，绝不以名字认证。
    storageKey = "gd-ble-v1:" + (device.id || device.name);
    try { record = JSON.parse(localStorage.getItem(storageKey)); } catch (_) { record = null; }
    if (!record || !/^[0-9a-f]{64}$/.test(record.credential)) record = { credential: randomHex(32), room: "", pending: null };
    pending = record.pending || null;
    if (pending) pending.restored = true;
    save();
  }
  function render() {
    $("room").textContent = room || "—";
    $("seat").textContent = seat < 0 ? "—" : seat;
    $("seq").textContent = seat < 0 ? "—" : seq;
    $("turn").textContent = view ? view.turn : "—";
    $("seats").replaceChildren(...[0, 1, 2, 3].map(i => {
      const li = document.createElement("li"), s = view && view.seats[i];
      li.textContent = `席位 ${i}：${!s ? "未知" : !s.occupied ? "空位" : s.bot ? "机器人" : s.connected ? "已连接" : "断线保留"}${i === seat ? "（我）" : seat >= 0 && i % 2 === seat % 2 ? "（队友）" : "（对手）"}${view && view.phase && view.phase !== "lobby" ? ` · 剩 ${s.remaining} 张` : ""}`;
      return li;
    }));
    $("card").textContent = view ? view.privateCard : "连接后由房主发送";
    $("last").textContent = view && view.last ? `#${view.last.number} 席位 ${view.last.seat}：${view.last.challenge}` : "—";
    const hand = view && view.hand || [];
    if (!view || view.phase !== "playing") selected.clear();
    for (const id of selected) if (!hand.some(c => c.id === id)) selected.delete(id);
    $("hand").replaceChildren(...hand.map(card => {
      const button = document.createElement("button");
      button.textContent = card.label;
      button.className = "playing-card" + (card.red ? " red" : "") + (selected.has(card.id) ? " selected" : "");
      button.setAttribute("aria-pressed", String(selected.has(card.id)));
      button.disabled = !ready || !!pending || view.phase !== "playing";
      button.addEventListener("click", () => { if (selected.has(card.id)) selected.delete(card.id); else selected.add(card.id); render(); });
      return button;
    }));
    const previous = view && view.lastPlay;
    $("last-play").textContent = previous ? `席位 ${previous.seat} · ${previous.shape.label}：${previous.cards.map(c => c.label).join(" ")}` : "自由出牌";
    $("game-status").textContent = !view || !view.phase || view.phase === "lobby" ? "等待房主开始，空位将自动补机器人。" :
      view.phase === "ended" ? (view.winnerTeam === seat % 2 ? "我方获胜！" : "对方获胜") :
      `固定打 2 · ${view.turn === seat ? "轮到你了" : `等待席位 ${view.turn}${view.seats[view.turn].bot ? "（机器人思考中）" : ""}`} · 已选 ${selected.size} 张`;
    const event = view && view.event;
    $("game-event").textContent = event && event.type ? `席位 ${event.seat}${event.source === "bot" ? "（机器人）" : ""}：${({game_start:"开始发牌",play:"出牌",pass:"过牌",trick_end:"本轮结束，最后出牌者重新领出",hand_end:"本局结束"})[event.type] || event.type}` : "";
    $("play").disabled = !ready || !!pending || !view || !view.canPlay || !selected.size;
    $("pass").disabled = !ready || !!pending || !view || !view.canPass;
    $("send").disabled = !ready || !view || view.turn !== seat || !!pending || !!(view.phase && view.phase !== "lobby");
    $("sync").disabled = !ready;
    $("connect").disabled = connecting || !!(device && device.gatt.connected) || !navigator.bluetooth;
    $("reconnect").disabled = !device || connecting || ready;
    $("disconnect").disabled = !device || (intentional && !device.gatt.connected);
    $("metrics").textContent = `已确认操作 ${rtts.length} 条；RTT p95：${rtts.length ? W.percentile95(rtts).toFixed(1) + " ms" : "—"}${pending ? "；有待确认操作" : ""}`;
  }
  function timeout(promise, ms, label) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })])
      .finally(() => clearTimeout(timer));
  }
  function resetLink() {
    ready = false; releaseAwake(); tx = null; writeChunk = 20;
    if (rx) rx.removeEventListener("characteristicvaluechanged", onValue);
    rx = null; decoder = new W.NotificationDecoder(); healthySince = 0;
  }
  function disconnected() {
    generation++; connecting = false; busy = false;
    resetLink();
    if (!lostAt) lostAt = Date.now();
    const delayMs = W.reconnectDelay(reconnectAttempts++);
    retryAt = Date.now() + delayMs;
    status(intentional ? stoppedReason || "已主动断开，席位与未确认操作保留。" :
      "连接中断；正在重连。iOS 请回到 Bluefy 前台，必要时点击重连。" + (stoppedReason ? " 原因：" + stoppedReason : ""));
    log("disconnected", { intentional, seq, delayMs, reason: stoppedReason }); render();
  }
  function failLink(error) {
    stoppedReason = explain(error);
    log("link_error", { name: error.name, text: error.message });
    if (device && device.gatt.connected) device.gatt.disconnect();
    else disconnected();
  }
  async function connect() {
    if (!device || connecting || ready) return;
    connecting = true; intentional = false; stoppedReason = "";
    const epoch = ++generation;
    resetLink(); render(); status("正在连接、发现服务并订阅通知…");
    const check = () => { if (epoch !== generation) throw new Error("连接已失效"); };
    try {
      const server = await timeout(device.gatt.connect(), 8000, "连接超时"); check();
      const service = await timeout(server.getPrimaryService(W.SERVICE), 6000, "发现服务超时"); check();
      const write = await timeout(service.getCharacteristic(W.WRITE), 6000, "获取 write 超时"); check();
      const notify = await timeout(service.getCharacteristic(W.NOTIFY), 6000, "获取 notify 超时"); check();
      rx = notify; rx.addEventListener("characteristicvaluechanged", onValue);
      await timeout(rx.startNotifications(), 6000, "订阅通知超时"); check();
      tx = write; writeChain = Promise.resolve();
      joinId = randomHex(16); lastRx = Date.now();
      status("GATT 已连接，等待房主确认席位…");
      await writeMessage(W.message("", -1, 0, "join", { requestId: joinId, credential: record.credential }));
    } catch (e) {
      if (epoch === generation) {
        status("连接失败：" + explain(e));
        failLink(e);
      }
    } finally {
      // 写完 join 不代表收到席位确认；保留 connecting，避免定时器并发重入握手。
      if (epoch === generation && !tx) connecting = false;
      render();
    }
  }
  function explain(e) {
    if (e.name === "NotFoundError") return "未选择房主或找不到设备；请确认安卓正在广播 GD- 房间。";
    if (e.name === "NotAllowedError" || e.name === "SecurityError") return "未获蓝牙权限；检查系统蓝牙权限及 HTTPS/localhost 安全来源。";
    return `${e.name || "错误"}：${e.message || "请检查房主广播和系统蓝牙"}`;
  }
  function writeMessage(message) {
    return writeBytes(W.encode(message));
  }
  // 业务和带包号的分片确认共用写入串行队列，避免浏览器 GATT 并发写冲突。
  function writeBytes(bytes) {
    const epoch = generation;
    const operation = writeChain.then(async () => {
      if (!tx || epoch !== generation) throw new Error("连接已失效");
      busy = true;
      const characteristic = tx;
      try {
        // 首次握手用 20 字节；收到房主针对本连接确认的 MTU 上限后才放大。
        const chunkSize = writeChunk;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          if (epoch !== generation) throw new Error("连接已失效");
          const chunk = bytes.slice(offset, offset + chunkSize);
          const promise = characteristic.writeValueWithResponse ? characteristic.writeValueWithResponse(chunk) : characteristic.writeValue(chunk);
          await timeout(promise, 5000, "写入超时");
        }
      } finally { if (epoch === generation) busy = false; }
    });
    writeChain = operation.catch(() => {});
    return operation;
  }
  function onValue(event) {
    try {
      const value = event.target.value;
      const { messages, ack } = decoder.feed(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      lastRx = Date.now();
      if (ack) {
        const epoch = generation;
        writeBytes(ack).catch(e => { if (epoch === generation) failLink(e); });
      }
      for (const m of messages) receive(m);
    } catch (e) { failLink(e); }
  }
  function receive(m) {
    if (m.type !== "snapshot") throw new Error("未知下行消息");
    lastRx = Date.now();
    log("rx", { message: m });
    const p = m.payload;
    if (m.seat < 1 || m.seat > 3) {
      intentional = true;
      failLink(new Error(`入房失败：${errorText(p.status)}；席位不因断开释放，请由房主重建房间`));
      return;
    }
    if (m.ack === joinId) {
      if (record.room && record.room !== m.room && pending) {
        log("abandoned", { actionId: pending.actionId, reason: "房主已重建，旧操作结果未知" }); pending = null;
      }
      room = m.room; seat = m.seat; revision = -1; ready = true; connecting = false;
      healthySince = Date.now(); lastSync = 0; keepAwake();
      record.room = room; save();
      status("已收到房主快照，席位恢复完成。断线后会重试同一 actionId。");
      if (lostAt) { log("recovered", { elapsedMs: Date.now() - lostAt }); lostAt = 0; }
    }
    if (!ready || m.room !== room || m.seat !== seat) return;
    if (Number.isInteger(p.writeChunk) && p.writeChunk >= 20 && p.writeChunk <= 244) writeChunk = p.writeChunk;
    if (!Number.isSafeInteger(p.revision) || !Array.isArray(p.seats) || p.seats.length !== 4 ||
      !Number.isInteger(p.turn) || p.turn < 0 || p.turn > 3 || typeof p.privateCard !== "string") throw new Error("快照内容不完整");
    if (p.revision >= revision) {
      if (m.seq !== seq || !view) lastChange = performance.now();
      if (m.seq < seq && revision >= 0) throw new Error("公共序号回退");
      seq = m.seq; revision = p.revision; view = p;
    }
    if (pending && m.ack === pending.actionId) {
      if (p.status === "ok" || p.status === "duplicate") {
        if (pending.type) selected.clear();
        const elapsedMs = pending.restored ? Date.now() - pending.startedWall : performance.now() - pending.startedPerf;
        rtts.push(elapsedMs);
        log("ack", { actionId: pending.actionId, appliedSeq: p.appliedSeq, status: p.status, elapsedMs, restored: !!pending.restored });
      } else {
        log("rejected", { actionId: pending.actionId, status: p.status });
        status(`操作未执行：${errorText(p.status)}。已同步最新状态，可轮到自己时重试。`);
      }
      pending = null; save();
    }
    render();
  }
  function sendAction(challenge) {
    if (!ready || pending || !view || view.turn !== seat) return;
    const length = new TextEncoder().encode(challenge).length;
    if (length < 1 || length > 96) { status("挑战词必须是 1–96 UTF-8 字节（中文通常每字 3 字节）。"); return; }
    pending = { actionId: randomHex(16), expectedSeq: seq, challenge, startedPerf: performance.now(), startedWall: Date.now() };
    save(); lastAttempt = 0; render(); attemptPending();
  }
  function sendGame(type) {
    if (!ready) { status("请先连接房主"); return; }
    if (pending) { status("上一操作正在确认，请稍候"); return; }
    if (!view || view.phase !== "playing") { status("请等待房主开始下一局"); return; }
    if (view.turn !== seat) { status("还没轮到你"); return; }
    if (type === "play" && !selected.size) { status("请先选择手牌"); return; }
    if (type === "pass" && !view.canPass) { status("新一轮必须出牌，不能过牌"); return; }
    pending = { type, cards: type === "play" ? [...selected] : [], actionId: randomHex(16), expectedSeq: seq,
      startedPerf: performance.now(), startedWall: Date.now() };
    save(); lastAttempt = 0; render(); attemptPending();
  }
  function attemptPending() {
    if (!pending || !ready || busy) return;
    lastAttempt = Date.now();
    const p = pending;
    log("tx_action", { actionId: p.actionId, expectedSeq: p.expectedSeq, challenge: p.challenge });
    const epoch = generation;
    writeMessage(W.message(room, seat, seq, p.type || "action", { actionId: p.actionId, expectedSeq: p.expectedSeq, ...(p.type ? { cards: p.cards } : { challenge: p.challenge }) }))
      .catch(e => { if (epoch === generation) failLink(e); });
  }
  function sync() {
    if (!ready || busy) return;
    lastSync = Date.now();
    const epoch = generation;
    writeMessage(W.message(room, seat, seq, "sync", { requestId: randomHex(16) }))
      .catch(e => { if (epoch === generation) failLink(e); });
  }
  $("connect").addEventListener("click", async () => {
    try {
      if (!navigator.bluetooth) throw new Error("本容器没有 Web Bluetooth；iPhone 请用 Bluefy，桌面请用 Chrome。");
      if (connecting || ready) return;
      // 用户打开选择器时暂停原设备自动重连，避免两个设备的异步连接交叉。
      intentional = true; generation++; connecting = true; render();
      // 保持在点击事件中直接调用，不能先等待其他异步操作。
      const selected = await navigator.bluetooth.requestDevice({ filters: [{ services: [W.SERVICE] }] });
      connecting = false;
      if (device) device.removeEventListener("gattserverdisconnected", disconnected);
      device = selected; resetLink(); clearSelection(); seat = -1; room = ""; seq = 0; revision = -1; view = null;
      device.addEventListener("gattserverdisconnected", disconnected);
      reconnectAttempts = 0; loadRecord(); await connect();
    } catch (e) {
      connecting = false; intentional = true;
      status(explain(e)); log("scan_error", { name: e.name, text: e.message }); render();
    }
  });
  $("reconnect").addEventListener("click", () => { intentional = false; retryAt = 0; connect(); });
  $("disconnect").addEventListener("click", () => {
    intentional = true; stoppedReason = ""; $("auto").checked = false;
    if (device && device.gatt.connected) device.gatt.disconnect(); else disconnected();
  });
  $("send").addEventListener("click", () => sendAction($("challenge").value.trim()));
  $("sync").addEventListener("click", sync);
  $("play").addEventListener("click", () => sendGame("play"));
  $("pass").addEventListener("click", () => sendGame("pass"));
  function fullLog() {
    const text = JSON.stringify({ version: 1, clientVersion: W.CLIENT_VERSION, userAgent: navigator.userAgent, room, seat,
      exportedAt: Date.now(), droppedLogs, p95Ms: W.percentile95(rtts), events }, null, 2);
    $("full-log").value = text; $("full-log").hidden = false;
    return text;
  }
  $("show-log").addEventListener("click", fullLog);
  $("copy-log").addEventListener("click", async () => {
    const text = fullLog();
    try { await navigator.clipboard.writeText(text); status("日志全文已复制"); }
    catch (_) {
      $("full-log").focus(); $("full-log").select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (_) {}
      status(copied ? "日志全文已复制" : "请长按下方日志全文，选择全选、复制。");
    }
  });
  $("export").addEventListener("click", () => {
    const blob = new Blob([fullLog()], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `ble-seat-${seat}-${Date.now()}.json`; a.textContent = "保存日志";
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status("已显示日志全文并请求下载；Bluefy 无下载反应时请点击一键复制，或长按全文复制。");
  });
  setInterval(() => {
    const now = Date.now();
    if (intentional) return;
    if (!ready && !connecting && now >= retryAt) connect();
    if (tx && lastRx && W.stale(now, lastRx)) { failLink(new Error("链路：30 秒未收到房主数据")); return; }
    if (!ready || busy) return;
    // 短暂握手成功不重置退避，连续稳定 30 秒才恢复最短重连间隔。
    if (healthySince && now - healthySince >= W.SILENCE_MS) reconnectAttempts = 0;
    const heartbeatMs = document.hidden ? W.HIDDEN_HEARTBEAT_MS : W.HEARTBEAT_MS;
    // 心跳不受轮次、待确认操作和后台状态限制；后台暂停自动业务操作。
    if (now - lastSync >= heartbeatMs) sync();
    if (document.hidden) return;
    if (pending && now - lastAttempt > 3000) { attemptPending(); return; }
    if ((!view.phase || view.phase === "lobby") && !pending && $("auto").checked && seq < 1000 && view.turn === seat &&
      view.seats.every(s => s.connected) && performance.now() - lastChange >= 1800) {
      sendAction(`自动-${seq + 1}`); return;
    }
  }, 250);
  document.addEventListener("visibilitychange", () => {
    log("visibility", { hidden: document.hidden });
    if (document.hidden) releaseAwake();
    if (!document.hidden && !intentional) {
      keepAwake();
      if (tx && W.stale(Date.now(), lastRx)) failLink(new Error("链路：回到前台，连接已静默超过 30 秒"));
      else if (!ready) { if (Date.now() >= retryAt) connect(); } else sync();
    }
  });
  async function prepareOffline() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      $("offline").textContent = "本容器未提供安全来源下的离线缓存能力；请在地面加载并保持页面打开。冷启动离线重载待实测。";
      return;
    }
    try {
      await navigator.serviceWorker.register("./sw.js");
      await timeout(navigator.serviceWorker.ready, 10000, "离线缓存准备超时");
      $("offline").textContent = "静态资源已缓存；请关闭网络后刷新一次，验证本机离线重载。缓存仅保存页面资源。";
    } catch (e) { $("offline").textContent = "离线缓存未就绪：" + e.message + "。请保持页面打开，并记录冷启动限制。"; }
  }
  $("capability").textContent = navigator.bluetooth ?
    `网页 v${W.CLIENT_VERSION}；Web Bluetooth API 可用；${window.isSecureContext ? "安全来源" : "容器自定义来源，权限与缓存需实测"}。尚未验证无线连接。` :
    `网页 v${W.CLIENT_VERSION}；本页面可加载，但当前浏览器没有 Web Bluetooth。iPhone 请用 Bluefy；桌面 Chrome 请访问 http://localhost:8000 或 HTTPS。`;
  render(); prepareOffline();
})();
