(function () {
  var D = window.D;
  var cv = document.getElementById("cv"), ctx = cv.getContext("2d");
  var ui = document.getElementById("ui");
  var W = 320, H = 176;
  ctx.imageSmoothingEnabled = false;

  var img = {};
  var pending = 0;
  function load(k, src) {
    pending++;
    var i = new Image();
    i.onload = i.onerror = function () { pending--; };
    i.src = src;
    img[k] = i;
  }
  load("tiles", "assets/tiles/roguelike-indoor.png");
  load("char", "assets/characters/green-cap-16x18.png");

  var tint = null;
  function makeTint() {
    var c = document.createElement("canvas");
    c.width = 48; c.height = 72;
    var x = c.getContext("2d");
    x.drawImage(img.char, 0, 0);
    x.globalCompositeOperation = "source-atop";
    x.fillStyle = "rgba(190,225,255,0.5)";
    x.fillRect(0, 0, 48, 72);
    x.globalCompositeOperation = "destination-over";
    tint = c;
  }

  var lang = "en";
  var S = { scene: "pharmacy", mode: "title", you: 0, hu: 0, n: 0, order: [], i: 0, demos: 0, log: [], shake: 0 };
  var player = { x: -20, y: 100, dir: 3, tx: null, ty: null, cb: null, hold: false, hop: 0 };
  var pharm = { x: 152, y: 46, nod: 0 };
  var parts = [], pops = [];

  var LV = {
    match: { t: "SAFE", cls: "ok", msg: "Safe to take" },
    warning: { t: "UNSAFE", cls: "", msg: "Warning, do not take" },
    unsure: { t: "NOT SURE", cls: "un", msg: "I'm not sure" }
  };

  function tile(c, r, x, y) {
    ctx.drawImage(img.tiles, c * 17, r * 17, 16, 16, x, y, 16, 16);
  }
  function tiles(list, x, y) {
    for (var i = 0; i < list.length; i++) tile(list[i][0], list[i][1], x + (i % 2) * 16, y + ((i / 2) | 0) * 16);
  }

  function sprite(sheet, x, y, row, col, flash) {
    ctx.drawImage(sheet, col * 16, row * 18, 16, 18, Math.round(x), Math.round(y), 16, 18);
  }
  var DIRROW = { down: 0, up: 1, left: 2, right: 3 };
  function drawPlayer(t) {
    var moving = player.tx !== null;
    var col = moving ? [1, 0, 2, 0][((t / 130) | 0) % 4] : 0;
    var bob = moving ? 0 : Math.round(Math.sin(t / 400));
    var row = DIRROW[["down", "up", "left", "right"][player.dir]] || 0;
    var hop = player.hop > 0 ? -Math.sin((1 - player.hop) * Math.PI) * 10 : 0;
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.fillRect(Math.round(player.x) + 2, Math.round(player.y) + 16, 12, 3);
    sprite(img.char, player.x, player.y + bob + hop, row, col);
    if (player.hold) {
      var bx = Math.round(player.x) + 3, by = Math.round(player.y) - 12 + Math.round(Math.sin(t / 120));
      ctx.fillStyle = "#0d0b16"; ctx.fillRect(bx - 1, by - 1, 12, 14);
      ctx.fillStyle = "#f4ecd8"; ctx.fillRect(bx, by, 10, 12);
      ctx.fillStyle = "#ff6b6b"; ctx.fillRect(bx + 1, by + 2, 8, 2);
      ctx.fillStyle = "#4a4370"; ctx.fillRect(bx + 1, by + 6, 8, 1); ctx.fillRect(bx + 1, by + 8, 5, 1);
    }
  }
  function drawPharm(t) {
    if (!tint) return;
    var nod = pharm.nod > 0 ? -Math.abs(Math.sin(pharm.nod * 12)) * 4 : Math.round(Math.sin(t / 500));
    sprite(tint, pharm.x, pharm.y + nod, 0, 0);
  }

  function pharmacyBG(t) {
    ctx.fillStyle = "#3b4a63"; ctx.fillRect(0, 0, W, 48);
    ctx.fillStyle = "#2c3850"; ctx.fillRect(0, 44, W, 4);
    for (var x = 0; x < W; x += 16) for (var y = 48; y < H; y += 16) { ctx.fillStyle = ((x + y) / 16) % 2 ? "#5e8f6e" : "#548463"; ctx.fillRect(x, y, 16, 16); }
    ctx.fillStyle = "rgba(20,30,50,.2)"; ctx.fillRect(0, 48, W, H - 48);
    for (var i = 1; i < 19; i++) {
      if (i === 9 || i === 10) continue;
      tile(5 + (i % 2), 13 + (i % 3), i * 16, 16);
      tile(6 - (i % 2), 14 + ((i + 1) % 3), i * 16, 32);
    }
    tile(18, 0, 144, 0);
    ctx.fillStyle = "#7bd88f"; ctx.fillRect(166, 5, 2, 8); ctx.fillRect(163, 8, 8, 2);
    ctx.fillStyle = "#f4ecd8"; ctx.font = "bold 8px monospace"; ctx.fillText("APTEEKKI", 100, 10);
    ctx.fillText("PHARMACY", 180, 10);
  }
  function pharmacyFG() {
    for (var x = 48; x < 272; x += 16) { tile(0, 12, x, 64); tile(((x / 16) % 3), 13, x, 80); }
    tile(16, 0, 8, 90); tile(16, 0, 296, 90);
    tile(17, 0, 8, 140); tile(17, 0, 296, 140);
  }
  function homeBG() {
    ctx.fillStyle = "#5b4466"; ctx.fillRect(0, 0, W, 48);
    ctx.fillStyle = "#3f2f4a"; ctx.fillRect(0, 44, W, 4);
    for (var y = 48; y < H; y += 8) { ctx.fillStyle = (y / 8) % 2 ? "#b9622b" : "#a85826"; ctx.fillRect(0, y, W, 8); ctx.fillStyle = "#8c4720"; ctx.fillRect(0, y, W, 1); for (var x = ((y / 8) % 3) * 24; x < W; x += 72) ctx.fillRect(x, y, 1, 8); }
    tile(19, 12, 40, 12); tile(20, 12, 56, 12); tile(21, 12, 72, 12);
    tile(19, 14, 232, 12); tile(20, 14, 248, 12);
    tiles([[14, 0], [15, 0], [14, 1], [15, 1]], 8, 28);
    tiles([[3, 0], [4, 0], [3, 1], [4, 1]], 144, 92);
    tile(16, 0, 290, 30); tile(17, 0, 290, 120);
  }

  var lastT = 0;
  function frame(t) {
    var dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (pending > 0 || !img.tiles.complete) { requestAnimationFrame(frame); return; }
    if (!tint && img.char.complete) makeTint();
    if (player.tx !== null) {
      var dx = player.tx - player.x, dy = player.ty - player.y, d = Math.hypot(dx, dy);
      var sp = 70 * dt;
      if (d <= sp) {
        player.x = player.tx; player.y = player.ty; player.tx = null;
        var cb = player.cb; player.cb = null; if (cb) cb();
      } else {
        player.x += dx / d * sp; player.y += dy / d * sp;
        player.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 0 : 1);
      }
    }
    if (player.hop > 0) player.hop = Math.max(0, player.hop - dt * 2);
    if (pharm.nod > 0) pharm.nod = Math.max(0, pharm.nod - dt);
    ctx.save();
    if (S.shake > 0) {
      S.shake = Math.max(0, S.shake - dt);
      ctx.translate(Math.round((Math.random() - 0.5) * 8 * S.shake * 4), Math.round((Math.random() - 0.5) * 6 * S.shake * 4));
    }
    ctx.clearRect(0, 0, W, H);
    if (S.scene === "pharmacy") {
      pharmacyBG(t); drawPharm(t); pharmacyFG(); drawPlayer(t);
    } else {
      homeBG(t); drawPlayer(t);
    }
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 160 * dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.fillStyle = p.c; ctx.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
    }
    ctx.font = "bold 10px monospace";
    for (var j = pops.length - 1; j >= 0; j--) {
      var q = pops[j];
      q.life -= dt; q.y -= 24 * dt;
      if (q.life <= 0) { pops.splice(j, 1); continue; }
      ctx.fillStyle = "#0d0b16"; ctx.fillText(q.t, Math.round(q.x) + 1, Math.round(q.y) + 1);
      ctx.fillStyle = q.c; ctx.fillText(q.t, Math.round(q.x), Math.round(q.y));
    }
    if (S.flash > 0) {
      S.flash -= dt;
      ctx.fillStyle = S.flashC; ctx.globalAlpha = Math.max(0, S.flash * 1.6);
      ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (S.mode === "title") {
      ctx.fillStyle = "rgba(13,11,22,.55)"; ctx.fillRect(0, 56, W, 64);
      ctx.fillStyle = "#ffd166"; ctx.font = "bold 28px monospace"; ctx.textAlign = "center";
      ctx.fillText("HOLDUP ARENA", W / 2 + 1, 88 + 1 + Math.round(Math.sin(t / 300) * 2));
      ctx.fillStyle = "#fff3c4"; ctx.fillText("HOLDUP ARENA", W / 2, 88 + Math.round(Math.sin(t / 300) * 2));
      ctx.font = "bold 9px monospace"; ctx.fillStyle = "#a9b4ff";
      ctx.fillText("spot it. then go blindfold.", W / 2, 106);
      ctx.textAlign = "left";
    }
    requestAnimationFrame(frame);
  }

  function burst(x, y, cols, n) {
    for (var i = 0; i < n; i++) parts.push({ x: x, y: y, vx: (Math.random() - 0.5) * 140, vy: -40 - Math.random() * 90, life: 0.6 + Math.random() * 0.5, c: cols[i % cols.length], s: 2 + ((Math.random() * 2) | 0) });
  }
  function pop(t, x, y, c) { pops.push({ t: t, x: x, y: y, c: c, life: 1.1 }); }

  var actx = null;
  function beep(f, d, type, delay) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "square"; o.frequency.value = f;
      var t0 = actx.currentTime + (delay || 0);
      g.gain.setValueAtTime(0.05, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + d);
    } catch (e) {}
  }
  function sfxGood() { beep(660, 0.1, "square"); beep(880, 0.14, "square", 0.09); beep(1320, 0.2, "square", 0.18); }
  function sfxBad() { beep(180, 0.25, "sawtooth"); beep(120, 0.3, "sawtooth", 0.12); }

  var cur = null;
  function stopVoice() {
    if (cur) { try { cur.pause(); } catch (e) {} cur = null; }
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
  }
  function clipFor(key) {
    var p = D.voice.phrases[lang] && D.voice.phrases[lang][key];
    return p || null;
  }
  function speak(key, text, onend) {
    stopVoice();
    var p = key && clipFor(key);
    var info = "";
    if (p) {
      var a = new Audio(p.file);
      cur = a;
      a.onended = function () { if (onend) onend(); };
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { if (onend) setTimeout(onend, 1500); });
      return "recorded voice clip: " + p.file;
    }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = { en: "en-US", fi: "fi-FI", sv: "sv-SE" }[lang];
      u.onend = function () { if (onend) onend(); };
      speechSynthesis.speak(u);
      return "browser voice (no recorded clip exists for this verdict)";
    } catch (e) {
      if (onend) setTimeout(onend, 1500);
      return "no audio available";
    }
  }

  var ART="Art: isaiah658, Kenney (CC0, opengameart.org)";
  var INF="";
  function info(html){ $("ovb").innerHTML=html+'<div class="tiny">'+ART+'</div>'; $("ov").className=""; }
  $("ovx").onclick=function(){ $("ov").className="hide"; };
  function ib(html){ INF=html; return '<button class="btn ico mid" id="inf" aria-label="info">i</button>'; }
  function bindInfo(){ var b=$("inf"); if(b) b.onclick=function(){ info(INF); }; }
  function h(s) { var d = document.createElement("div"); d.innerHTML = s; return d; }
  function set(html) { ui.innerHTML = html; }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function scoreBar(on) {
    $("score").className = on ? "" : "hide";
    $("sp").textContent = "YOU " + S.you;
    $("sh").textContent = "";
    $("sr").textContent = S.mode === "r1" ? "ROUND 1  " + Math.min(S.i + 1, S.order.length) + "/" + S.order.length : S.mode === "r2" ? "ROUND 2" : "";
  }
  function langRow() {
    return '<div class="row"><span class="tiny" style="margin:0 8px 0 0">&#128266;</span>' + ["en", "fi", "sv"].map(function (l) {
      return '<button class="btn small mid' + (l === lang ? "" : " off") + '" data-lang="' + l + '">' + l.toUpperCase() + "</button>";
    }).join("") + "</div>";
  }
  function bindLang() {
    var bs = ui.querySelectorAll("[data-lang]");
    for (var i = 0; i < bs.length; i++) bs[i].onclick = function () { lang = this.getAttribute("data-lang"); bindAndRefresh(); };
  }
  var refresh = null;
  function bindAndRefresh() { if (refresh) refresh(); }

  function title() {
    S.mode = "title"; S.scene = "pharmacy"; scoreBar(false);
    player.x = -20; player.y = 108; player.hold = false;
    (function walk() { player.tx = 340; player.ty = 108; player.dir = 3; player.cb = function () { player.x = -20; if (S.mode === "title") walk(); }; })();
    set('<div class="panel"><div class="row"><button class="btn" id="start" style="font-size:22px;flex:1">&#9654; Start</button>' + ib('<div class="q">Meta glasses read your meds and say safe or not.</div><div class="tiny">Offline demo from recorded repo data. Not on glasses, not medical advice.</div>') + '</div></div>'); bindInfo();
    $("start").onclick = function () { beep(520, 0.08); menu(); };
  }

  function menu() {
    stopVoice(); stopCam(); clearTimeout(cueT); S.order = []; S.r2 = [];
    S.mode = "menu"; S.scene = "pharmacy"; scoreBar(false);
    player.tx = null; player.x = 150; player.y = 100; player.dir = 0; player.hold = false;
    refresh = menu;
    set('<div class="panel"><div class="row"><div class="big" style="font-size:22px;flex:1">PICK ONE</div>' + ib('Round 1: five labels, guess safe or unsafe. Round 2: one blindfold box. Under 3 minutes.') + '</div>' +
      '<div class="row" style="margin-top:6px"><button class="btn safe" id="r1">&#128269; Spot it</button><button class="btn bad" id="r2">&#128065; Blindfold</button></div>' +
      langRow() + '</div>');
    bindLang(); bindInfo();
    $("r1").onclick = startR1;
    $("r2").onclick = startR2;
  }

  function cardByid(id) {
    var c = D.cases;
    for (var i = 0; i < c.photos.length; i++) if (c.photos[i].id === id) return { kind: "photo", d: c.photos[i] };
    for (var j = 0; j < c.cards.length; j++) if (c.cards[j].id === id) return { kind: "card", d: c.cards[j] };
  }
  function listFor(c) {
    var P = D.profile;
    if (c.kind === "photo") {
      var m = P.demo;
      return "Your list: " + m.meds.map(function (x) { return x.name + " " + x.strength; }).join(", ") + ". Avoid: " + m.avoid.join(", ") + ". Allergies: " + m.allergies.join(", ") + ".";
    }
    var found = P.suite.meds.filter(function (x) { return x.ingredient.toLowerCase() === String(c.d.ingredient).toLowerCase(); })[0];
    if (found) return "Your list: " + found.name + " " + found.strength + " (" + found.schedule.join(", ") + ").";
    return "Your list: see " + "data/profile.json";
  }
  function labelHTML(c) {
    if (c.kind === "photo") {
      return '<div class="card"><img src="' + esc(c.d.image) + '" alt="medication box photo"></div>';
    }
    var d = c.d;
    var str = d.strength ? d.strength : "??? (smudged)";
    return '<div class="card"><div class="lbl"><b>' + esc(d.product) + '</b><b style="font-size:30px;color:' + (d.strength ? "#1d1a2b" : "#a32a2a") + '">' + esc(str) + '</b>EXP ' + esc(d.expiry) + '</div></div>';
  }
  function labelInfo(c) {
    if (c.kind === "photo") return "FIXTURE PHOTO: server/fixtures, looks AI generated.";
    return "LABEL CARD, DRAWN FROM RECORDED READ. Read confidence " + c.d.readability + ".";
  }
  function question(c) { return c.d.question; }
  function expectedOf(c) { return c.d.expected_level; }
  function hopLevel(c) { return c.kind === "photo" ? c.d.expected_level : c.d.predicted_level; }
  function verdictText(c, lv) {
    if (c.kind === "photo") return c.d.headline;
    if (lv === "unsure") return clipFor("not_sure") ? clipFor("not_sure").text : "I'm not sure.";
    var r = c.d.reasons.join("; ");
    return (lv === "warning" ? "Warning. " : "Yes. ") + r.charAt(0).toUpperCase() + r.slice(1) + ".";
  }

  function startR1() {
    S.mode = "r1"; S.scene = "pharmacy"; S.you = 0; S.hu = 0; S.i = 0; S.order = D.cases.round1_order.slice(); S.log = [];
    refresh = null;
    player.x = -20; player.y = 110;
    scoreBar(true);
    set("");
    player.tx = 150; player.ty = 100; player.dir = 3;
    player.cb = function () { player.dir = 1; r1Card(); };
  }

  function r1Card() {
    scoreBar(true);
    var c = cardByid(S.order[S.i]);
    set('<div class="panel">' + labelHTML(c) + '<div class="q">' + esc(question(c)) + '</div>' +
      '<div class="row"><button class="btn safe" data-g="match">&#10004; Safe</button><button class="btn bad" data-g="warning">&#10006; Unsafe</button><button class="btn mid" data-g="unsure">? Not sure</button>' + ib('<div class="tiny">' + esc(labelInfo(c)) + '</div><div class="tiny">' + esc(listFor(c)) + '</div>') + '</div></div>');
    bindInfo();
    var bs = ui.querySelectorAll("[data-g]");
    for (var i = 0; i < bs.length; i++) bs[i].onclick = function () { r1Reveal(c, this.getAttribute("data-g")); };
  }

  function r1Reveal(c, g) {
    var exp = expectedOf(c), hu = hopLevel(c);
    var ok = g === exp, huok = hu === exp;
    if (ok) S.you++;
    if (huok) S.hu++;
    S.log.push({ id: c.d.id, you: g, exp: exp, hu: hu });
    scoreBar(true);
    pharm.nod = 0.5;
    if (ok) { sfxGood(); player.hop = 1; burst(player.x + 8, player.y, ["#ffd166", "#7bd88f", "#fff3c4"], 28); pop("+1 NICE", player.x - 4, player.y - 6, "#7bd88f"); S.flash = 0.3; S.flashC = "#7bd88f"; }
    else { sfxBad(); S.shake = 0.35; burst(player.x + 8, player.y, ["#ff6b6b", "#a32a2a"], 18); pop("MISS", player.x + 2, player.y - 6, "#ff6b6b"); S.flash = 0.3; S.flashC = "#ff6b6b"; }
    var text = verdictText(c, hu);
    var L = LV[hu];
    var last = S.i >= S.order.length - 1;
    set('<div class="panel">' + labelHTML(c) +
      '<div class="tiny" style="margin:0 0 6px">YOU said <span class="tag ' + LV[g].cls + '">' + LV[g].t + '</span> &nbsp; TRUTH <span class="tag ' + LV[exp].cls + '">' + LV[exp].t + '</span> ' + (ok ? "&#10004;" : "&#10006;") + '</div>' +
      '<div class="bub"><span class="tag ' + L.cls + '">HOLDUP: ' + L.t + '</span><div class="q" style="font-size:16px">' + esc(text) + '</div></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn" id="nx">' + (last ? "Finish" : "Next &#9654;") + '</button><button class="btn ico mid" id="rp" aria-label="replay">&#128266;</button>' + ib('<div class="tiny">' + esc(labelInfo(c)) + '</div><div class="tiny">Verdict source: ' + esc(c.d.verdict_origin) + '</div><div class="tiny" id="vinfo"></div>') + '</div></div>');
    bindInfo();
    var key = hu === "unsure" ? D.voice.level_clip.unsure : null;
    function play() { var v = speak(key, text); INF = INF.replace(/<div class="tiny" id="vinfo">[^<]*<\/div>/, "") + '<div class="tiny" id="vinfo">Voice: ' + v + "</div>"; }
    play();
    $("rp").onclick = play;
    $("nx").onclick = function () {
      stopVoice();
      if (last) { r1Done(); } else { S.i++; r1Card(); }
    };
  }

  function r1Done() {
    set('<div class="panel"><div class="big" style="font-size:22px">DONE</div><div class="q">YOU ' + S.you + ' / ' + S.order.length+ '</div><div class="row"><button class="btn bad" id="b2">&#128065; Blindfold</button><button class="btn mid" id="en">Results</button></div></div>');
    $("b2").onclick = function () { startR2(true); };
    $("en").onclick = end;
  }

  var stream = null, cueT = null, cueStop = null;
  function stopCam() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  function startR2(keep) {
    stopCam(); clearTimeout(cueT);
    S.mode = "r2"; S.scene = "home"; S.demos = 0; S.r2 = [];
    if (keep !== true) { S.you = 0; S.hu = 0; S.order = []; }
    refresh = null;
    scoreBar(true);
    player.hold = false; player.x = -20; player.y = 110;
    player.tx = 150; player.ty = 120; player.dir = 3;
    player.cb = function () { player.dir = 0; r2Intro(); };
    set("");
  }

  var ban = '<div style="background:#ff6b6b;color:#1d1a2b;font-weight:700;padding:4px 8px;text-align:center">DEMO, recorded</div>';

  function r2Intro() {
    var d = D.blindfold.demos[S.demos];
    set('<div class="panel">' + ban + '<div class="q">&#128230; Grab a box</div>' +
      '<video id="vid" class="hide" playsinline muted></video><div class="tiny" id="camst"></div>' +
      '<div class="row"><button class="btn small mid" id="cam">&#128247; Camera</button><button class="btn" id="go">&#128065; Eyes closed, go</button>' + ib('Grab any box. Close your eyes and hold it up to the camera. HoldUp coaches you by voice, then reads it. There is no live model here, so the verdict is a recorded demo from the eval set and it will not be about your real box. Offline demo, not live, not running on glasses.') + '</div></div>'); bindInfo();
    $("cam").onclick = function () {
      var st = $("camst");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.textContent = "No camera. Go on."; return; }
      navigator.mediaDevices.getUserMedia(D.blindfold.camera.constraints).then(function (s) {
        stopCam(); stream = s;
        var v = $("vid"); if (!v) { stopCam(); return; }
        v.srcObject = s; v.className = ""; v.play();
        st.textContent = "Camera on.";
      }).catch(function () { st.textContent = "No camera. Go on."; });
    };
    $("go").onclick = function () { r2Coach(d); };
  }

  function r2Coach(d) {
    var cues = D.blindfold.coach_cues.slice();
    player.hold = true; player.dir = 1;
    var vid = $("vid") ? $("vid").className : "hide";
    var vidEl = $("vid");
    var vhtml = vidEl && vid === "" ? vidEl : null;
    var keep = vhtml;
    set('<div class="panel">' + ban + '<div class="big" style="font-size:20px">&#128065; EYES CLOSED</div><div class="q" id="cue">...</div></div>');
    if (keep) ui.firstChild.insertBefore(keep, ui.firstChild.children[1]);
    var i = 0, stop = false;
    var sk = document.createElement("button"); sk.className = "btn small mid"; sk.textContent = "Skip"; sk.onclick = function () { stop = true; clearTimeout(cueT); stopVoice(); r2Reveal(d); };
    ui.firstChild.appendChild(sk);
    cueStop = function () { stop = true; clearTimeout(cueT); };
    function next() {
      if (stop) return;
      if (i >= cues.length) { cueT = setTimeout(function () { r2Reveal(d); }, 400); return; }
      var k = cues[i++];
      var p = clipFor(k);
      $("cue").textContent = p ? p.text : k;
      beep(440, 0.05);
      var done = false;
      function adv() { if (done || stop) return; done = true; cueT = setTimeout(next, 500); }
      speak(k, p ? p.text : k, adv);
      cueT = setTimeout(adv, 4200);
    }
    next();
  }

  function r2Reveal(d) {
    if (cueStop) cueStop();
    player.hold = false;
    stopCam();
    var c = cardByid(d.case);
    var lv = d.level;
    var L = LV[lv];
    var text = c.d.headline;
    S.demos++;
    S.r2.push(d.id);
    pharm.nod = 0.4;
    sfxGood(); burst(player.x + 8, player.y - 8, ["#a9b4ff", "#ffd166", "#fff3c4"], 24); pop("OPEN EYES", player.x - 10, player.y - 14, "#ffd166");
    var last = true;
    set('<div class="panel">' + ban + labelHTML(c) +
      '<div class="bub"><span class="tag ' + L.cls + '">HOLDUP: ' + L.t + '</span><div class="q" style="font-size:16px">' + esc(text) + '</div></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn" id="nx">Finish</button><button class="btn ico mid" id="rp" aria-label="replay">&#128266;</button>' + ib('<div class="tiny">' + esc(labelInfo(c)) + '</div><div class="tiny">Verdict source: ' + esc(c.d.verdict_origin) + '</div><div class="tiny" id="vinfo"></div>') + '</div></div>');
    bindInfo();
    var key = lv === "unsure" ? D.voice.level_clip.unsure : null;
    function play() { var v = speak(key, text); INF = INF.replace(/<div class="tiny" id="vinfo">[^<]*<\/div>/, "") + '<div class="tiny" id="vinfo">Voice: ' + v + "</div>"; }
    play();
    $("rp").onclick = play;
    $("nx").onclick = function () { stopVoice(); if (last) end(); else { player.tx = 150; player.ty = 120; r2Intro(); } };
  }

  function end() {
    stopVoice(); stopCam();
    S.mode = "end"; S.scene = "pharmacy"; scoreBar(false);
    player.hold = false; player.tx = null; player.x = 150; player.y = 100; player.dir = 0;
    var ss = D.cases.suite_summary;
    var win = S.order.length ? "YOU " + S.you + " / " + S.order.length : "THANKS!";
    burst(160, 80, ["#ffd166", "#7bd88f", "#a9b4ff", "#ff6b6b"], 60);
    var src = "Source: eval/suites/anticoagulant_nti_traps/results.json (n=" + ss.n_cases + ", small suite, CI95 " + Math.round(ss.verdict_accuracy_ci95[0] * 100) + "% to " + Math.round(ss.verdict_accuracy_ci95[1] * 100) + "%). HoldUp measured on its eval suite: " + ss.verdict_matches + " of " + ss.n_cases + " verdicts matched, " + ss.confident_wrong_count + " confident wrong, " + ss.unsafe_reassurance_count + " unsafe reassurance, " + ss.abstain_or_unsure_count + " abstained, p50 latency " + Math.round(ss.latency_p50_ms) + " ms. Round 2 demos watched: " + (S.r2 ? S.r2.length : 0) + " (recorded, offline). Offline demo. Not running on glasses. Not medical advice. Fixture photos look AI generated. Data: data/*.json, built from this repo.";
    set('<div class="panel"><div class="big">' + win + '</div>' +
      '<div class="bub"><div class="big" style="font-size:30px">&#129302; ' + ss.verdict_matches + " / " + ss.n_cases + '</div><div class="tiny">&#10006; wrong ' + ss.confident_wrong_count + ' &middot; &#9888; unsafe ok ' + ss.unsafe_reassurance_count + ' &middot; ? unsure ' + ss.abstain_or_unsure_count + ' &middot; ' + Math.round(ss.latency_p50_ms) + ' ms</div></div>' +
      '<div class="row"><button class="btn" id="again">&#8635; Again</button>' + ib('<div class="tiny">' + esc(src) + '</div>') + '</div></div>');
    bindInfo();
    $("again").onclick = menu;
  }

  cv.addEventListener("click", function (e) {
    var r = cv.getBoundingClientRect();
    player.tx = Math.max(8, Math.min(W - 24, (e.clientX - r.left) / r.width * W - 8));
    player.ty = Math.max(S.scene === "pharmacy" ? 88 : 56, Math.min(H - 20, (e.clientY - r.top) / r.height * H - 9));
    player.cb = null;
  });

  window.__game = { player: player, S: S, menu: menu, startR1: startR1, startR2: startR2, end: end };
  requestAnimationFrame(frame);
  title();
})();
