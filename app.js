/* 차트 계산기(11/8 유저 요청 "어플 따로 만들어 이것만. 계산기 어플처럼 차트 계산기로") — 서버 없는 정적 웹앱.
   트레이딩뷰 롱·숏 포지션 도구처럼 차트를 눌러 진입·손절·익절을 놓고, 놓은 것을 쌓아 평균 수익률·단리·복리·최대 낙폭·30일 뒤 시드를 본다.
   · 위: 순수 계산 CALC(node 시험이 DOM 없이 싣는다 — size·judge·stats·project30 …)
   · 아래: 화면(차트·덮개 상자·끌기·목록·요약·저장). 시세는 바이낸스 선물 공개 REST·웹소켓에 브라우저가 직접. 저장은 이 브라우저(localStorage)만. */
(function (G) {
  "use strict";
  const N = (v) => typeof v === "number" && isFinite(v);
  const CALC = {};
  CALC.NAME = "차트 계산기";            // 앱 이름 한 곳(화면 제목·머리) — manifest.webmanifest 의 name 도 같은 글(시험이 맞춰 본다)
  CALC.SYMS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  CALC.TFS = Object.freeze([["5m", "5분"], ["15m", "15분"], ["1h", "1시간"], ["4h", "4시간"], ["1d", "1일"]]);
  CALC.STEP = Object.freeze({ "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 });
  CALC.DP = Object.freeze({ BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 2 });
  CALC.DEF = Object.freeze({ sym: "BTCUSDT", tf: "15m", seed: 1000, risk: 1, lev: 1, fee: 0.1, slPct: 1, tpPct: 2, perDay: null });
  CALC.REST = "https://fapi.binance.com";
  CALC.WS = "wss://fstream.binance.com";
  CALC.round = (p, dp) => Math.round(p * Math.pow(10, dp)) / Math.pow(10, dp);

  // 설정 고르기 — 이상한 값은 기본값으로
  CALC.cfgOf = (c) => {
    c = c || {};
    const pos = (v, d) => (N(v) && v > 0 ? v : d);
    return {
      sym: CALC.SYMS.indexOf(c.sym) >= 0 ? c.sym : CALC.DEF.sym,
      tf: CALC.STEP[c.tf] ? c.tf : CALC.DEF.tf,
      seed: pos(c.seed, CALC.DEF.seed),
      risk: pos(c.risk, CALC.DEF.risk),
      lev: pos(c.lev, CALC.DEF.lev),
      fee: N(c.fee) && c.fee >= 0 ? c.fee : CALC.DEF.fee,
      slPct: pos(c.slPct, CALC.DEF.slPct),
      tpPct: pos(c.tpPct, CALC.DEF.tpPct),
      perDay: N(c.perDay) && c.perDay > 0 ? c.perDay : null,
    };
  };

  // 손익비 1 : x (가격 거리만, 수수료 전)
  CALC.rr = (p) => Math.abs(p.tp - p.e) / Math.abs(p.e - p.sl);

  // 포지션 놓기 — 진입 가격·시각, 손절·익절은 설정의 기본 거리(%)로
  CALC.place = (side, price, t, cfg, dp) => {
    const k = side === "short" ? -1 : 1;
    const d = N(dp) ? dp : 2, tick = Math.pow(10, -d);
    const e = CALC.round(price, d);
    let sl = CALC.round(e * (1 - k * cfg.slPct / 100), d), tp = CALC.round(e * (1 + k * cfg.tpPct / 100), d);
    if (Math.abs(sl - e) < tick) sl = CALC.round(e - k * tick, d);
    if (Math.abs(tp - e) < tick) tp = CALC.round(e + k * tick, d);
    return { side: side === "short" ? "short" : "long", t, e, sl, tp };
  };

  // 선 하나 옮기기 — 순서(롱: 손절 < 진입 < 익절 · 숏: 반대)를 지키게 한 눈금 안쪽에서 멈춘다
  CALC.move = (p, key, price, dp) => {
    const d = N(dp) ? dp : 2, tick = Math.pow(10, -d), v = CALC.round(price, d);
    const q = Object.assign({}, p);
    const long = p.side !== "short";
    const lo = (a) => CALC.round(a + tick, d), hi = (a) => CALC.round(a - tick, d);
    if (key === "sl") q.sl = long ? Math.min(v, hi(p.e)) : Math.max(v, lo(p.e));
    else if (key === "tp") q.tp = long ? Math.max(v, lo(p.e)) : Math.min(v, hi(p.e));
    else if (key === "e") {
      const a = Math.min(p.sl, p.tp), b = Math.max(p.sl, p.tp);
      q.e = Math.min(Math.max(v, lo(a)), hi(b));
    }
    if (!(q.sl > 0) || !(q.tp > 0) || !(q.e > 0)) return p;
    return q;
  };

  // 수량·금액(트레이딩뷰 롱·숏 도구와 같은 식: 수량 = min(위험 기준 수량, 레버리지 기준 수량)) — 수수료는 왕복 %를 진입·청산 금액에 반씩
  //  위험 기준: 손절 맞으면(수수료 포함) 정확히 시드의 risk% 를 잃는 수량 · 레버리지 기준: 진입 금액 ≤ 시드 × 레버리지
  //  순손익비 = 익절 순이익 ÷ 손절 순손실(수수료 뒤) · 손익분기 승률 = 손절 순손실 ÷ (익절 순이익 + 손절 순손실)
  CALC.size = (cfg, p) => {
    const f = cfg.fee / 100, dist = Math.abs(p.e - p.sl), gain = Math.abs(p.tp - p.e);
    const riskQty = (cfg.seed * cfg.risk / 100) / (dist + (p.e + p.sl) * f / 2);
    const levQty = cfg.seed * cfg.lev / p.e;
    const qty = Math.min(riskQty, levQty);
    const lossAmt = qty * dist + qty * (p.e + p.sl) * f / 2;
    const winAmt = qty * gain - qty * (p.e + p.tp) * f / 2;
    const beAmt = -qty * p.e * f;                        // 진입가에서 나옴 — 수수료만
    const notional = qty * p.e;
    const netRR = winAmt / lossAmt;
    return {
      qty, riskQty, levQty, capped: levQty < riskQty, notional, levEq: notional / cfg.seed, lossAmt, winAmt, beAmt,
      lossPct: lossAmt / cfg.seed * 100, winPct: winAmt / cfg.seed * 100, bePct: beAmt / cfg.seed * 100,
      slDist: dist / p.e * 100, tpDist: gain / p.e * 100, rr: gain / dist, netRR,
      beWin: winAmt > 0 ? lossAmt / (winAmt + lossAmt) * 100 : 100,
    };
  };
  // 위치 오류 — 롱: 손절 < 진입 < 익절 · 숏: 익절 < 진입 < 손절 · 가격 > 0
  CALC.check = (p) => {
    const out = [];
    if (!(p.e > 0) || !(p.sl > 0) || !(p.tp > 0)) out.push("가격은 0보다 커야 해요");
    const long = p.side !== "short", k = long ? "롱" : "숏";
    if (long ? p.sl >= p.e : p.sl <= p.e) out.push(k + "인데 손절이 진입가 " + (long ? "위(또는 같음)" : "아래(또는 같음)") + "예요");
    if (long ? p.tp <= p.e : p.tp >= p.e) out.push(k + "인데 익절이 진입가 " + (long ? "아래(또는 같음)" : "위(또는 같음)") + "예요");
    return out;
  };
  // 숫자 칸 읽기 — 소수점 8자리까지 · 쉼표 소수점(0,5)·천 단위 쉼표(100,000.5) 둘 다 · 빈칸·이상한 글 = null
  CALC.num = (s) => {
    let t = String(s == null ? "" : s).replace(/\s/g, "");
    if (!t) return null;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
    else if (/^\d*,\d+$/.test(t)) t = t.replace(",", ".");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const v = Number(t);
    return isFinite(v) ? Math.round(v * 1e8) / 1e8 : null;
  };
  CALC.decOf = (v) => {
    const m = /\.(\d*?)0*$/.exec(Math.abs(v).toFixed(8));
    return m ? m[1].length : 0;
  };

  // 자동 판정 — bars: [{t,o,h,l,c}] 오름차순(초) · 그 포지션을 놓은 시간봉. 진입 시각의 봉부터 본다.
  //  체결 = 진입가에 닿음(봉 범위 안, 또는 앞 봉 종가와 이 봉 시가 사이를 건너뜀) · 체결된 봉에서는 손절만(익절은 다음 봉부터 — 보수적)
  //  그 뒤 봉: 손절·익절 둘 다 닿으면 손절 · 하나만 닿으면 그쪽 · 없으면 진행 중
  //  → { st: 'none'(미체결) | 'open'(진행 중) | 'tp' | 'sl', ft: 체결 봉 시각, xt: 끝난 봉 시각 }
  CALC.judge = (bars, p) => {
    const long = p.side !== "short";
    const slHit = (b) => (long ? b.l <= p.sl : b.h >= p.sl);
    const tpHit = (b) => (long ? b.h >= p.tp : b.l <= p.tp);
    let ft = null, prevC = null;
    for (const b of bars || []) {
      if (!b || !N(b.t) || b.t < p.t) continue;
      if (ft == null) {
        const inBar = b.l <= p.e && b.h >= p.e;
        const gap = N(prevC) && ((prevC - p.e) * (b.o - p.e) < 0);
        prevC = b.c;
        if (!inBar && !gap) continue;
        ft = b.t;
        if (slHit(b)) return { st: "sl", ft, xt: b.t };
        continue;
      }
      const s = slHit(b), w = tpHit(b);
      if (s) return { st: "sl", ft, xt: b.t };
      if (w) return { st: "tp", ft, xt: b.t };
    }
    return ft == null ? { st: "none", ft: null, xt: null } : { st: "open", ft, xt: null };
  };

  CALC.MAN = Object.freeze({ tp: "익절", sl: "손절", be: "본전", skip: "빼기" });
  // 이 줄의 결과(손으로 바꾼 것이 먼저) → { res, manual, R }
  CALC.result = (p) => {
    const man = p.man && CALC.MAN[p.man] ? p.man : null;
    const res = man || (p.auto && p.auto.st) || "wait";
    const R = res === "tp" ? CALC.rr(p) : res === "sl" ? -1 : res === "be" ? 0 : null;
    return { res, manual: !!man, R };
  };
  // 이 건 수익률(시드 대비 %, 수수료 뒤) — 끝나지 않았으면 null
  CALC.retPct = (cfg, p) => {
    const r = CALC.result(p).res, z = CALC.size(cfg, p);
    return r === "tp" ? z.winPct : r === "sl" ? -z.lossPct : r === "be" ? z.bePct : null;
  };
  // 이 건의 순 R(수수료 뒤 손익 ÷ 손절 순손실) — 익절 = 순손익비, 손절 = −1, 본전 = 수수료만큼 −
  CALC.netR = (cfg, p) => {
    const r = CALC.result(p).res, z = CALC.size(cfg, p);
    return r === "tp" ? z.netRR : r === "sl" ? -1 : r === "be" ? z.beAmt / z.lossAmt : null;
  };
  CALC.DONE = (res) => res === "tp" || res === "sl" || res === "be";

  // 요약 — 끝난 건(익절·손절·본전)만, 진입 시각 순서로 복리
  CALC.stats = (list, cfg) => {
    const done = (list || []).filter((p) => CALC.DONE(CALC.result(p).res)).slice().sort((a, b) => a.t - b.t);
    const n = done.length;
    const out = { n, wins: 0, winRate: null, avgR: null, avgPct: null, simplePct: 0, compPct: 0, mddPct: 0, spanDays: 0, perDay: null,
                  open: 0, none: 0 };
    for (const p of list || []) {
      const r = CALC.result(p).res;
      if (r === "open") out.open += 1;
      else if (r === "none") out.none += 1;
    }
    if (!n) return out;
    let sumR = 0, sum = 0, eq = 1, peak = 1, mdd = 0;
    for (const p of done) {
      const r = CALC.result(p), x = CALC.retPct(cfg, p);
      if (r.res === "tp") out.wins += 1;
      sumR += CALC.netR(cfg, p);
      sum += x;
      eq *= 1 + x / 100;
      if (eq > peak) peak = eq;
      mdd = Math.max(mdd, (peak - eq) / peak * 100);
    }
    out.winRate = out.wins / n * 100;
    out.avgR = sumR / n;
    out.avgPct = sum / n;
    out.simplePct = sum;
    out.compPct = (eq - 1) * 100;
    out.mddPct = mdd;
    out.spanDays = (done[n - 1].t - done[0].t) / 86400;
    out.perDay = CALC.perDay(n, out.spanDays);
    return out;
  };
  // 하루 평균 건수 = 끝난 건수 ÷ 첫 건~마지막 건 날수(하루 안이면 1일로)
  CALC.MIN_N = 10;                       // 이보다 적으면 30일 칸을 흐리게(경쟁 비교 b-7 · 숫자는 가칭 — 02/12 가 정함)
  CALC.perDay = (n, spanDays) => (n > 0 ? n / Math.max(1, spanDays) : null);

  // 30일 뒤 시드 — 건당 평균 수익률로 (하루 건수 × 일수) 번 복리. curve = 0~days 일의 시드
  CALC.project30 = (seed, avgPct, perDay, days) => {
    const D = N(days) ? days : 30;
    if (!N(seed) || !N(avgPct) || !N(perDay) || perDay <= 0) return null;
    const g = 1 + avgPct / 100;
    if (g <= 0) return null;
    const curve = [];
    for (let d = 0; d <= D; d++) curve.push({ d, v: seed * Math.pow(g, perDay * d) });
    const final = curve[D].v;
    return { trades: perDay * D, final, gainPct: (final / seed - 1) * 100, curve };
  };

  CALC.basis = (cfg) => "기준 크기: 1회 위험 " + fmtNum(cfg.risk, 2) + "%(손절 맞으면 수수료 포함 시드의 " + fmtNum(cfg.risk, 2) + "%) · 레버리지 " +
    fmtNum(cfg.lev, 2) + "배 한도(진입 금액 ≤ 시드 × 레버리지 — 둘 중 작은 수량) · 수수료 왕복 " + fmtNum(cfg.fee, 2) + "%";
  // CSV(엑셀용) — 끝난 건·진행 건 모두, 금액은 지금 설정 기준
  CALC.csv = (list, cfg) => {
    const head = ["시각(UTC)", "종목", "시간봉", "방향", "진입", "손절", "익절", "가격 손익비", "순손익비", "결과", "손으로 바꿈", "순 R", "수익률 %(수수료 뒤)"];
    const rows = (list || []).slice().sort((a, b) => a.t - b.t).map((p) => {
      const r = CALC.result(p), z = CALC.size(cfg, p), x = CALC.retPct(cfg, p), nr = CALC.netR(cfg, p);
      return [new Date(p.t * 1000).toISOString().slice(0, 16).replace("T", " "), p.sym, p.tf, p.side === "short" ? "숏" : "롱", p.e, p.sl, p.tp,
        z.rr.toFixed(4), z.netRR.toFixed(4), r.res, r.manual ? "예" : "", nr == null ? "" : nr.toFixed(4), x == null ? "" : x.toFixed(4)];
    });
    return [head].concat(rows).map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : String(c))).join(",")).join("\r\n");
  };

  // 저장 글(내보내기·가져오기) — 모양이 맞는 줄만 받는다
  CALC.clean = (o) => {
    const cfg = CALC.cfgOf(o && o.cfg);
    const list = [];
    for (const p of (o && Array.isArray(o.list) ? o.list : [])) {
      if (!p || !N(p.t) || !N(p.e) || !N(p.sl) || !N(p.tp) || CALC.SYMS.indexOf(p.sym) < 0 || !CALC.STEP[p.tf]) continue;
      const side = p.side === "short" ? "short" : "long";
      const okOrder = side === "long" ? p.sl < p.e && p.e < p.tp : p.tp < p.e && p.e < p.sl;
      if (!okOrder) continue;
      const q = { id: String(p.id || "").slice(0, 24) || CALC.newId(), sym: p.sym, tf: p.tf, side, t: Math.floor(p.t), e: p.e, sl: p.sl, tp: p.tp,
                  man: CALC.MAN[p.man] ? p.man : null, auto: null };
      if (p.auto && ["none", "open", "tp", "sl"].indexOf(p.auto.st) >= 0) q.auto = { st: p.auto.st, ft: N(p.auto.ft) ? p.auto.ft : null, xt: N(p.auto.xt) ? p.auto.xt : null };
      list.push(q);
    }
    return { cfg, list: list.slice(0, CALC.MAX) };
  };
  CALC.MAX = 2000;
  let idN = 0;
  CALC.newId = () => Date.now().toString(36) + "-" + (idN++).toString(36) + Math.floor(Math.random() * 1296).toString(36);

  // 바이낸스 kline 배열 → 봉
  CALC.barOf = (k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });

  function fmtNum(v, d) {
    if (!N(v)) return "—";
    return v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  CALC.fmt = fmtNum;
  CALC.pct = (v, d) => (N(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), N(d) ? d : 2) + "%" : "—");
  CALC.money = (v) => (N(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + fmtNum(Math.abs(v), 2) : "—");

  G.CALC = CALC;
  if (typeof module !== "undefined" && module.exports) module.exports = CALC;

  // ───────────────────────────────── 화면 ─────────────────────────────────
  const d = G.document;
  if (!d || !d.getElementById || !G.LightweightCharts || !d.getElementById("ccChart")) return;
  const LW = G.LightweightCharts;
  const $ = (id) => d.getElementById(id);

  // 저장(이 브라우저만) — 열쇠 앞머리 calc.
  const KEY = "calc.";
  const store = {
    get(k, def) {
      try {
        const v = G.localStorage.getItem(KEY + k);
        return v == null ? def : JSON.parse(v);
      } catch (_) {
        return def;
      }
    },
    put(k, v) {
      try {
        G.localStorage.setItem(KEY + k, JSON.stringify(v));
      } catch (_) {}
    },
  };
  // 테마: 자동(기기 설정) → 어둠 → 밝음 · 색: 빨강 상승(국내 관행) 기본, 초록 상승으로 바꿀 수 있음
  const THEMES = ["auto", "dark", "light"], THEME_TEXT = { auto: "◐ 자동", dark: "● 어둠", light: "○ 밝음" };
  function applyTheme() {
    const t = store.get("theme", "auto");
    let dark = true;
    try {
      dark = G.matchMedia ? G.matchMedia("(prefers-color-scheme: dark)").matches : true;
    } catch (_) {}
    const r = d.documentElement;
    r.setAttribute("data-theme", t === "light" || t === "dark" ? t : dark ? "dark" : "light");
    r.setAttribute("data-updown", store.get("updown", "kr") === "global" ? "global" : "kr");
    const tb = $("ccTheme");
    if (tb) tb.textContent = THEME_TEXT[THEMES.indexOf(t) >= 0 ? t : "auto"];
  }
  d.title = CALC.NAME;
  if ($("ccName")) $("ccName").textContent = CALC.NAME;
  applyTheme();
  const css = (n) => {
    try {
      return G.getComputedStyle(d.documentElement).getPropertyValue(n).trim();
    } catch (_) {
      return "";
    }
  };

  const saved = CALC.clean({ cfg: store.get("cfg", null), list: store.get("list", []) });
  const S = { cfg: saved.cfg, list: saved.list, sel: null, arm: null, bars: [], loadingMore: false, drag: null, delAsk: null, sumOpen: !!store.get("sumOpen", false) };
  const save = () => {
    store.put("cfg", S.cfg);
    store.put("list", S.list);
  };
  const dpOf = (sym) => CALC.DP[sym] != null ? CALC.DP[sym] : 2;
  const pf = (v, sym) => fmtNum(v, Math.max(dpOf(sym), CALC.decOf(v)));      // 가격 글 — 손으로 넣은 소수점(8자리까지)은 그대로
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const kst = (t) => {
    const x = new Date(t * 1000), p = (n) => String(n).padStart(2, "0");
    return p(x.getMonth() + 1) + "/" + p(x.getDate()) + " " + p(x.getHours()) + ":" + p(x.getMinutes());
  };

  // ── 차트 ──
  const host = $("ccChart"), ov = $("ccOv");
  const INTERACTION = { handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
                        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true } };
  const chart = LW.createChart(host, Object.assign({
    autoSize: true,
    layout: { background: { type: "solid", color: css("--chart") || "#050913" }, textColor: css("--sub") || "#9aabcf", fontSize: 12 },
    grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderColor: css("--line") },
    timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, rightOffset: 8 },
    crosshair: { mode: 0 },
    localization: { locale: "ko-KR", timeFormatter: (t) => kst(t) },
  }, INTERACTION));
  const candleColors = () => ({ upColor: css("--up"), downColor: css("--down"), borderUpColor: css("--up"), borderDownColor: css("--down"),
                                wickUpColor: css("--up"), wickDownColor: css("--down") });
  const cs = chart.addSeries(LW.CandlestickSeries, Object.assign({
    priceFormat: { type: "price", precision: dpOf(S.cfg.sym), minMove: Math.pow(10, -dpOf(S.cfg.sym)) },
    lastValueVisible: false,                               // 축의 현재가 꼬리표가 눈금 글자를 덮어 끔 — 지금 가격은 머리줄(#ccPx) · 점선은 그대로
    autoscaleInfoProvider: (orig) => {
      const r = orig();
      const p = S.list.find((x) => x.id === S.sel);
      if (!r || !p || S.drag || p.sym !== S.cfg.sym) return r;
      const lo = Math.min(r.priceRange.minValue, p.sl, p.tp), hi = Math.max(r.priceRange.maxValue, p.sl, p.tp);
      return { priceRange: { minValue: lo, maxValue: hi }, margins: r.margins };
    },
  }, candleColors()));
  ov.parentNode === host && host.appendChild(ov);           // 덮개를 라이브러리 판 위로(나중에 붙인 것이 위)

  // 가격 축 손가락 끌기 = 세로 확대·축소(트레이딩뷰처럼, 유저 11/8). 라이브러리는 vertTouchDrag:false 일 때 축 터치 끌기도
  // 페이지 스크롤로 넘겨서 폰에선 안 됨 → 축 폭만큼 투명 띠를 덮어 직접 처리. 아래로 끌면 넓어짐(봉 납작), 위로 끌면 좁아짐(봉 길어짐).
  // 두 번 탭 = 자동 맞춤. 마우스는 라이브러리 기본(축 끌기·두 번 클릭)을 그대로 쓴다.
  const axisStrip = document.createElement("div");
  axisStrip.className = "cc-axis";
  axisStrip.setAttribute("aria-hidden", "true");
  host.appendChild(axisStrip);
  const AXIS_K = 0.006;                                    // 1px 당 배율 지수(200px 끌면 약 3.3배)
  let axisT = null, axisTap = 0;
  function placeAxisStrip() {
    try {
      axisStrip.style.width = Math.max(44, chart.priceScale("right").width()) + "px";
      axisStrip.style.bottom = chart.timeScale().height() + "px";
    } catch (_) {}
  }
  axisStrip.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const now = Date.now(), y = e.touches[0].clientY;
    if (now - axisTap < 350) {                             // 두 번 탭 → 자동 맞춤
      cs.priceScale().setAutoScale(true);
      axisTap = 0; axisT = null;
      return;
    }
    axisTap = now;
    const r = cs.priceScale().getVisibleRange();
    if (!r) return;
    cs.priceScale().setAutoScale(false);
    axisT = { y0: y, from: r.from, to: r.to };
  }, { passive: false });
  axisStrip.addEventListener("touchmove", (e) => {
    if (!axisT || e.touches.length !== 1) return;
    e.preventDefault();
    const dy = e.touches[0].clientY - axisT.y0;
    if (Math.abs(dy) > 6) axisTap = 0;                     // 끈 것은 탭으로 세지 않음
    const mid = (axisT.from + axisT.to) / 2, half = (axisT.to - axisT.from) / 2 * Math.exp(dy * AXIS_K);
    cs.priceScale().setVisibleRange({ from: mid - half, to: mid + half });
    paint();
  }, { passive: false });
  const axisEnd = () => { axisT = null; };
  axisStrip.addEventListener("touchend", axisEnd);
  axisStrip.addEventListener("touchcancel", axisEnd);
  placeAxisStrip();
  try { new ResizeObserver(placeAxisStrip).observe(host); } catch (_) {}
  setInterval(placeAxisStrip, 1000);                       // 가격 자릿수가 바뀌면 축 폭도 바뀜

  function retheme() {
    applyTheme();
    chart.applyOptions({ layout: { background: { type: "solid", color: css("--chart") }, textColor: css("--sub") },
                         grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } } });
    cs.applyOptions(candleColors());
    if (proj.chart) proj.chart.applyOptions({ layout: { background: { type: "solid", color: css("--card") }, textColor: css("--sub") } });
    paint();
  }
  try {
    G.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", retheme);
  } catch (_) {}

  // 시각 → 차트 논리 위치(봉 사이는 비례, 끝 너머는 봉 간격으로)
  function logicalOf(t) {
    const b = S.bars, n = b.length, step = CALC.STEP[S.cfg.tf];
    if (!n) return null;
    if (t <= b[0].t) return (t - b[0].t) / step;
    if (t >= b[n - 1].t) return n - 1 + (t - b[n - 1].t) / step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m].t <= t) lo = m;
      else hi = m;
    }
    return lo + (t - b[lo].t) / (b[hi].t - b[lo].t);
  }
  function xOf(l) {
    const ts = chart.timeScale();
    const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
    if (x0 == null || x1 == null) return null;
    return x0 + l * (x1 - x0);
  }
  const yOf = (p) => cs.priceToCoordinate(p);

  // ── 덮개 그리기(상자·선·끌기 손잡이) — DOM 몇 개뿐 ──
  let raf = 0;
  function paint() {
    if (raf) return;
    raf = (G.requestAnimationFrame || ((f) => setTimeout(f, 16)))(() => {
      raf = 0;
      paintNow();
    });
  }
  function paintNow() {
    const W = host.clientWidth, ps = chart.priceScale("right").width() || 0, plotW = W - ps;
    const ts = chart.timeScale();
    const sp = (ts.logicalToCoordinate(1) || 0) - (ts.logicalToCoordinate(0) || 0);
    const html = [];
    const bars = S.bars;
    for (const p of S.list) {
      if (p.sym !== S.cfg.sym || !bars.length) continue;
      const l0 = logicalOf(p.t);
      const r = CALC.result(p);
      const endT = r.res === "tp" || r.res === "sl" ? (p.auto && p.auto.xt) : null;
      let l1 = endT != null && !r.manual ? logicalOf(endT) + 0.5 : Math.max(l0 + 24 * CALC.STEP[p.tf] / CALC.STEP[S.cfg.tf], bars.length + 2);
      let x0 = xOf(l0 - 0.5), x1 = xOf(l1);
      if (x0 == null || x1 == null) continue;
      x1 = Math.max(x1, x0 + Math.max(sp * 2, 36));
      if (x1 < 0 || x0 > plotW) continue;
      const cx0 = Math.max(0, x0), cx1 = Math.min(plotW, x1);
      if (cx1 <= cx0) continue;
      const ye = yOf(p.e), ysl = yOf(p.sl), ytp = yOf(p.tp);
      if (ye == null || ysl == null || ytp == null) continue;
      const sel = p.id === S.sel;
      const box = (y1, y2, cls) => '<div class="cc-zone ' + cls + (sel ? " sel" : "") + '" style="left:' + cx0.toFixed(1) + "px;width:" + (cx1 - cx0).toFixed(1) +
        "px;top:" + Math.min(y1, y2).toFixed(1) + "px;height:" + Math.max(1, Math.abs(y2 - y1)).toFixed(1) + 'px"></div>';
      html.push(box(ye, ytp, "win"), box(ye, ysl, "loss"));
      html.push('<div class="cc-eline' + (sel ? " sel" : "") + '" style="left:' + cx0.toFixed(1) + "px;width:" + (cx1 - cx0).toFixed(1) + "px;top:" + ye.toFixed(1) + 'px"></div>');
      if (!sel) {
        html.push('<button type="button" class="cc-pick" data-a="sel" data-v="' + esc(p.id) + '" style="left:' + cx0.toFixed(1) + "px;width:" + Math.min(cx1 - cx0, 120).toFixed(1) +
          "px;top:" + (Math.min(ytp, ysl) ).toFixed(1) + "px;height:" + Math.max(12, Math.abs(ytp - ysl)).toFixed(1) + 'px" aria-label="이 포지션 고르기"></button>');
        continue;
      }
      const z = CALC.size(S.cfg, p), dp = dpOf(p.sym);
      const hw = Math.min(plotW, Math.max(cx1 - cx0, 270)), hx = Math.min(cx0, Math.max(0, plotW - hw));
      const handle = (k, y, txt, cls) => '<div class="cc-hd ' + cls + '" data-k="' + k + '" style="left:' + hx.toFixed(1) + "px;width:" + hw.toFixed(1) + "px;top:" + y.toFixed(1) +
        'px"><span class="cc-hdtag">' + txt + "</span></div>";
      html.push(handle("tp", ytp, "익절 " + pf(p.tp, p.sym) + " · " + CALC.pct(z.tpDist) + " · " + CALC.money(z.winAmt), "win"));
      html.push(handle("sl", ysl, "손절 " + pf(p.sl, p.sym) + " · " + CALC.pct(-z.slDist) + " · " + CALC.money(-z.lossAmt), "loss"));
      html.push(handle("e", ye, (p.side === "long" ? "롱 " : "숏 ") + pf(p.e, p.sym) + " · 순손익비 1 : " + fmtNum(z.netRR, 2), "ent"));
    }
    ov.innerHTML = html.join("");
  }

  // ── 끌기(마우스·터치 하나로 — pointer 이벤트) ──
  ov.addEventListener("pointerdown", (ev) => {
    const hd = ev.target.closest && ev.target.closest(".cc-hd");
    if (!hd) return;
    const p = S.list.find((x) => x.id === S.sel);
    if (!p) return;
    ev.preventDefault();
    ev.stopPropagation();
    const rect = host.getBoundingClientRect();
    const k = hd.getAttribute("data-k");
    const y0 = yOf(k === "e" ? p.e : p[k]);
    S.drag = { k, id: p.id, dy: (ev.clientY - rect.top) - (y0 || 0), moved: false, el: hd, pid: ev.pointerId };
    try {
      hd.setPointerCapture(ev.pointerId);
    } catch (_) {}
    hd.classList.add("on");
  });
  function dragMove(ev) {
    const g = S.drag;
    if (!g || ev.pointerId !== g.pid) return;
    ev.preventDefault();
    const p = S.list.find((x) => x.id === g.id);
    if (!p) return;
    const rect = host.getBoundingClientRect();
    const price = cs.coordinateToPrice(ev.clientY - rect.top - g.dy);
    if (!N(price)) return;
    const q = CALC.move(p, g.k, price, dpOf(p.sym));
    if (q.e !== p.e || q.sl !== p.sl || q.tp !== p.tp) {
      Object.assign(p, { e: q.e, sl: q.sl, tp: q.tp });
      g.moved = true;
      paintNow();
      const hd = ov.querySelector('.cc-hd[data-k="' + g.k + '"]');
      if (hd) {
        hd.classList.add("on");
        try {
          hd.setPointerCapture(g.pid);
        } catch (_) {}
        g.el = hd;
      }
      renderSel();
    }
  }
  function dragEnd(ev) {
    const g = S.drag;
    if (!g || (ev && ev.pointerId !== g.pid)) return;
    S.drag = null;
    const p = S.list.find((x) => x.id === g.id);
    if (p && g.moved) {
      p.auto = null;                                      // 가격이 바뀌면 다시 판정
      save();
      judgeOne(p).then(renderAll);
    }
    paint();
  }
  // 손잡이가 다시 그려져도 끌기가 이어지게 문서에서 받는다
  d.addEventListener("pointermove", dragMove, { passive: false });
  d.addEventListener("pointerup", dragEnd);
  d.addEventListener("pointercancel", dragEnd);

  // 차트를 움직이면(축 끌기·핀치·휠) 덮개도 — 범위 알림 + 누르고 있는 동안
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    paint();
    if (r && r.from < 30) loadMore();
  });
  for (const ev of ["pointermove", "wheel", "pointerup", "touchmove"]) host.addEventListener(ev, paint, { passive: true });
  if (G.ResizeObserver) new G.ResizeObserver(paint).observe(host);

  // 차트 누르기 — 놓기 대기 중이면 그 자리에 포지션
  chart.subscribeClick((prm) => {
    if (!S.arm || !prm || !prm.point || !S.bars.length) return;
    const price = cs.coordinateToPrice(prm.point.y);
    if (!N(price) || price <= 0) return;
    let t = N(prm.time) ? prm.time : null;
    if (t == null) {
      const l = N(prm.logical) ? Math.round(prm.logical) : S.bars.length - 1;
      const b = S.bars, last = b.length - 1;
      t = l >= last ? b[last].t + (l - last) * CALC.STEP[S.cfg.tf] : b[Math.max(0, l)].t;
    }
    const p = Object.assign({ id: CALC.newId(), sym: S.cfg.sym, tf: S.cfg.tf, man: null, auto: null }, CALC.place(S.arm, price, t, S.cfg, dpOf(S.cfg.sym)));
    S.list.push(p);
    if (S.list.length > CALC.MAX) S.list.shift();
    S.sel = p.id;
    S.arm = null;
    save();
    judgeOne(p).then(renderAll);
    renderAll();
  });

  // ── 시세 ──
  async function klines(sym, tf, q) {
    const u = CALC.REST + "/fapi/v1/klines?symbol=" + sym + "&interval=" + tf + "&limit=" + (q.limit || 1000) +
      (q.start != null ? "&startTime=" + q.start * 1000 : "") + (q.end != null ? "&endTime=" + q.end : "");
    const r = await G.fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error("시세 " + r.status);
    const j = await r.json();
    return Array.isArray(j) ? j.map(CALC.barOf).filter((b) => N(b.t) && N(b.h) && N(b.l)) : [];
  }
  const toSeries = (b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c });
  let loadSeq = 0;
  async function loadChart() {
    const my = ++loadSeq, sym = S.cfg.sym, tf = S.cfg.tf;
    setConn("○ 불러오는 중");
    let bars = [];
    try {
      bars = await klines(sym, tf, { limit: 1000 });
    } catch (_) {
      if (my === loadSeq) setConn("○ 시세를 못 받음 — 잠시 뒤 다시");
      if (my === loadSeq) G.setTimeout(() => my === loadSeq && loadChart(), 15000);
      return;
    }
    if (my !== loadSeq) return;
    S.bars = bars;
    setConn(ws ? "● 실시간" : "○ 실시간 잇는 중");
    cs.applyOptions({ priceFormat: { type: "price", precision: dpOf(sym), minMove: Math.pow(10, -dpOf(sym)) } });
    cs.setData(bars.map(toSeries));
    const n = bars.length;
    if (n) {
      const plotW = Math.max(200, host.clientWidth - (chart.priceScale("right").width() || 64));
      const k = Math.max(60, Math.min(160, Math.round(plotW / 4)));
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - k), to: n + Math.max(4, Math.round(k / 14)) });
    }
    setPx();
    openWs();
    await judgeAll();
    renderAll();
  }
  async function loadMore() {
    if (S.loadingMore || !S.bars.length || S.bars.length >= 6000) return;
    S.loadingMore = true;
    const my = loadSeq, first = S.bars[0].t;
    try {
      const more = (await klines(S.cfg.sym, S.cfg.tf, { limit: 1000, end: first * 1000 - 1 })).filter((b) => b.t < first);
      if (my === loadSeq && more.length) {
        const r = chart.timeScale().getVisibleLogicalRange();
        S.bars = more.concat(S.bars);
        cs.setData(S.bars.map(toSeries));
        if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + more.length, to: r.to + more.length });
        paint();
      }
    } catch (_) {}
    S.loadingMore = false;
  }

  let ws = null, wsTry = 0, wsTimer = 0, judgeTimer = 0;
  function setPx() {
    const el = $("ccPx"), b = S.bars[S.bars.length - 1];
    if (!el) return;
    el.hidden = !b;
    if (b) el.textContent = pf(b.c, S.cfg.sym);
  }
  function setConn(s) {
    const el = $("ccConn");
    if (el) el.textContent = s;
  }
  function closeWs() {
    if (wsTimer) G.clearTimeout(wsTimer);
    wsTimer = 0;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = null;
      try {
        ws.close();
      } catch (_) {}
    }
    ws = null;
  }
  function openWs() {
    closeWs();
    if (!G.WebSocket || d.hidden) return;
    const sym = S.cfg.sym, tf = S.cfg.tf;
    let s;
    try {
      s = new G.WebSocket(CALC.WS + "/market/ws/" + sym.toLowerCase() + "@kline_" + tf);
    } catch (_) {
      return;
    }
    ws = s;
    s.onopen = () => {
      wsTry = 0;
      setConn("● 실시간");
    };
    s.onmessage = (m) => {
      let j;
      try {
        j = JSON.parse(m.data);
      } catch (_) {
        return;
      }
      const k = j && j.k;
      if (!k || sym !== S.cfg.sym || tf !== S.cfg.tf) return;
      const b = { t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
      const bs = S.bars, last = bs[bs.length - 1];
      if (!last || b.t < last.t) return;
      if (b.t === last.t) bs[bs.length - 1] = b;
      else bs.push(b);
      try {
        cs.update(toSeries(b));
      } catch (_) {}
      setPx();
      if (!judgeTimer) judgeTimer = G.setTimeout(() => {
        judgeTimer = 0;
        judgeAll(true).then((ch) => ch && renderAll());
      }, 1500);
    };
    s.onclose = () => {
      ws = null;
      setConn("○ 다시 잇는 중");
      wsTry += 1;
      wsTimer = G.setTimeout(openWs, Math.min(30000, 2000 * wsTry));
    };
  }
  d.addEventListener("visibilitychange", () => {
    if (d.hidden) {
      closeWs();
      setConn("○ 쉬는 중");
    } else loadChart();
  });

  // ── 판정 — 그 포지션을 놓은 시간봉으로 ──
  const cache = new Map();
  async function barsFor(p) {
    if (p.sym === S.cfg.sym && p.tf === S.cfg.tf && S.bars.length && S.bars[0].t <= p.t) return S.bars;
    const key = p.sym + "|" + p.tf + "|" + p.t, hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.bars;
    let out = [], start = p.t;
    for (let i = 0; i < 4; i++) {
      const got = await klines(p.sym, p.tf, { limit: 1500, start });
      out = out.concat(got.filter((b) => !out.length || b.t > out[out.length - 1].t));
      if (got.length < 1500) break;
      const j = CALC.judge(out, p);
      if (j.st === "tp" || j.st === "sl") break;
      start = got[got.length - 1].t + 1;
    }
    cache.set(key, { at: Date.now(), bars: out });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return out;
  }
  async function judgeOne(p) {
    try {
      const bars = await barsFor(p);
      const j = CALC.judge(bars, p);
      const before = JSON.stringify(p.auto);
      p.auto = j;
      return before !== JSON.stringify(j);
    } catch (_) {
      return false;
    }
  }
  // 아직 안 끝난 줄만(끝난 자동 판정은 가격을 바꾸기 전까지 그대로) · onlyChart = 지금 차트 종목·봉 줄만(실시간 봉)
  let judging = false;
  async function judgeAll(onlyChart) {
    if (judging) return false;
    judging = true;
    let changed = false;
    try {
      for (const p of S.list) {
        if (p.auto && (p.auto.st === "tp" || p.auto.st === "sl")) continue;
        if (onlyChart && !(p.sym === S.cfg.sym && p.tf === S.cfg.tf)) continue;
        if (await judgeOne(p)) changed = true;
      }
    } finally {
      judging = false;
    }
    if (changed) save();
    return changed;
  }
  G.setInterval(() => {
    if (!d.hidden) judgeAll().then((ch) => ch && renderAll());
  }, 60000);

  // ── 그리기(글) ──
  function renderBar() {
    const sy = CALC.SYMS.map((s) => '<button type="button" class="cc-chip' + (s === S.cfg.sym ? " on" : "") + '" data-a="sym" data-v="' + s + '" aria-pressed="' + (s === S.cfg.sym) + '">' +
      s.replace("USDT", "") + "</button>").join("");
    const tf = CALC.TFS.map(([k, t]) => '<button type="button" class="cc-chip' + (k === S.cfg.tf ? " on" : "") + '" data-a="tf" data-v="' + k + '" aria-pressed="' + (k === S.cfg.tf) + '">' +
      t + "</button>").join("");
    $("ccBar").innerHTML = '<div class="cc-chips">' + sy + '</div><div class="cc-chips">' + tf + "</div>";
  }
  const RES_TEXT = { tp: "익절", sl: "손절", be: "본전", skip: "뺌", open: "진행 중", none: "미체결", wait: "판정 중" };
  function resCell(p) {
    const r = CALC.result(p), nr = CALC.netR(S.cfg, p);
    const txt = nr == null ? RES_TEXT[r.res] || r.res : (nr > 0 ? "+" : nr < 0 ? "−" : "") + fmtNum(Math.abs(nr), 2) + "R";
    return '<span class="cc-res r-' + r.res + '">' + txt + (r.manual ? ' <i class="cc-man" title="손으로 바꾼 결과">손</i>' : "") + "</span>";
  }
  // 고른 포지션 카드 — 입력 칸(진입·손절·익절, 소수점 8자리)은 고른 줄이 바뀔 때만 새로 만들고(치는 중 안 지워지게) 숫자 칸만 다시 그린다
  function renderSel() {
    const el = $("ccSel"), p = S.list.find((x) => x.id === S.sel);
    if (!p) {
      el.hidden = true;
      el.innerHTML = "";
      el.removeAttribute("data-id");
      return;
    }
    el.hidden = false;
    if (el.getAttribute("data-id") !== p.id) {
      el.setAttribute("data-id", p.id);
      const inp = (id, lab, k) => '<label class="cc-pin ' + k + '">' + lab + '<input id="' + id + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"></label>';
      el.innerHTML = '<div id="selHead" class="cc-selhead"></div>' +
        '<div class="cc-pins">' + inp("pE", "진입", "ent") + inp("pSl", "손절", "loss") + inp("pTp", "익절", "win") + "</div>" +
        '<p id="selWarn" class="cc-warn" role="alert" hidden></p><div id="selOut"></div>';
    }
    $("selHead").innerHTML = '<b class="' + (p.side === "long" ? "s-long" : "s-short") + '">' + (p.side === "long" ? "롱" : "숏") + "</b> " + p.sym.replace("USDT", "") + " · " +
      (CALC.TFS.find((x) => x[0] === p.tf) || ["", p.tf])[1] + " · " + kst(p.t) + " · " + resCell(p) +
      '<span class="cc-grow"></span><button type="button" class="cc-x" data-a="unsel" aria-label="고르기 풀기">✕</button>';
    for (const [id, k] of [["pE", "e"], ["pSl", "sl"], ["pTp", "tp"]]) {
      const ip = $(id);
      if (ip && d.activeElement !== ip) ip.value = String(p[k]);
    }
    const z = CALC.size(S.cfg, p);
    $("selOut").innerHTML = '<div class="cc-selgrid">' +
      '<div class="big"><span>순손익비(수수료 뒤)</span><b>1 : ' + fmtNum(z.netRR, 2) + "</b><small>가격만 1 : " + fmtNum(z.rr, 2) + "</small></div>" +
      '<div class="loss"><span>손절 ' + CALC.pct(-z.slDist) + "</span><b>" + CALC.money(-z.lossAmt) + "</b><small>" + CALC.pct(-z.lossPct) + " 시드 · 잔고 " + fmtNum(S.cfg.seed - z.lossAmt, 2) + "</small></div>" +
      '<div class="win"><span>익절 ' + CALC.pct(z.tpDist) + "</span><b>" + CALC.money(z.winAmt) + "</b><small>" + CALC.pct(z.winPct) + " 시드 · 잔고 " + fmtNum(S.cfg.seed + z.winAmt, 2) + "</small></div>" +
      '<div><span>손익분기 승률</span><b>' + fmtNum(z.beWin, 1) + "%</b><small>수수료 반영 · 이보다 자주 이겨야 본전</small></div>" +
      "</div>" +
      '<p class="cc-prices">수량 ' + fmtNum(z.qty, z.qty < 1 ? 6 : 3) + " · 진입 금액 " + fmtNum(z.notional, 2) + " USDT(시드의 " + fmtNum(z.levEq, 2) + "배)" +
      (z.capped ? ' · <b class="cc-cap">레버리지 ' + fmtNum(S.cfg.lev, 2) + "배 한도에 걸려 위험이 " + CALC.pct(-z.lossPct) + "로 줄었어요</b>" : "") + "</p>";
  }
  // 고른 포지션 가격 칸 입력 — 위치가 틀리면 경고만(적용 안 함), 맞으면 바로 적용 + 0.6초 뒤 다시 판정
  let typeTimer = 0;
  function priceInput(id, raw) {
    const p = S.list.find((x) => x.id === S.sel), w = $("selWarn");
    if (!p) return;
    const k = { pE: "e", pSl: "sl", pTp: "tp" }[id], v = CALC.num(raw);
    const q = Object.assign({}, p, { [k]: v });
    const errs = v == null ? ["숫자를 넣어 주세요(소수점 8자리까지)"] : CALC.check(q);
    if (errs.length) {
      w.hidden = false;
      w.textContent = "⚠ " + errs.join(" · ") + " — 고칠 때까지 계산에 안 넣어요";
      return;
    }
    w.hidden = true;
    p[k] = v;
    p.auto = null;
    save();
    renderSel();
    renderList();
    renderSum();
    paint();
    if (typeTimer) G.clearTimeout(typeTimer);
    typeTimer = G.setTimeout(() => judgeOne(p).then(() => {
      save();
      renderAll();
    }), 600);
  }
  function renderList() {
    const el = $("ccList");
    if (!S.list.length) {
      el.innerHTML = '<p class="cc-empty">아직 놓은 포지션이 없어요. 위에서 [롱 놓기]·[숏 놓기]를 누르고 차트를 눌러 보세요.</p>';
      return;
    }
    const rows = S.list.slice().sort((a, b) => b.t - a.t).map((p) => {
      const dp = dpOf(p.sym), x = CALC.retPct(S.cfg, p), r = CALC.result(p);
      const opts = [["", "자동"], ["tp", "익절"], ["sl", "손절"], ["be", "본전"], ["skip", "빼기"]]
        .map(([v, t]) => '<option value="' + v + '"' + ((p.man || "") === v ? " selected" : "") + ">" + t + "</option>").join("");
      const ask = S.delAsk === p.id;
      return '<div class="cc-row' + (p.id === S.sel ? " sel" : "") + (r.manual ? " man" : "") + '" data-a="sel" data-v="' + esc(p.id) + '">' +
        '<span class="cc-c1"><b class="' + (p.side === "long" ? "s-long" : "s-short") + '">' + (p.side === "long" ? "롱" : "숏") + "</b> " +
        p.sym.replace("USDT", "") + " " + (CALC.TFS.find((t) => t[0] === p.tf) || ["", p.tf])[1] + "<small>" + kst(p.t) + "</small></span>" +
        '<span class="cc-c2">' + pf(p.e, p.sym) + "<small>손 " + pf(p.sl, p.sym) + "</small><small>익 " + pf(p.tp, p.sym) + "</small></span>" +
        '<span class="cc-c3">1:' + fmtNum(CALC.size(S.cfg, p).netRR, 2) + "<small>순손익비</small></span>" +
        '<span class="cc-c4">' + resCell(p) + '<small class="' + (x > 0 ? "pos" : x < 0 ? "neg" : "") + '">' + (x == null ? "—" : CALC.pct(x)) + "</small></span>" +
        '<span class="cc-c5"><select class="cc-mansel" data-a="man" data-v="' + esc(p.id) + '" aria-label="결과 손으로 바꾸기">' + opts + "</select>" +
        '<button type="button" class="cc-del' + (ask ? " ask" : "") + '" data-a="del" data-v="' + esc(p.id) + '">' + (ask ? "한 번 더" : "지우기") + "</button></span></div>";
    }).join("");
    el.innerHTML = '<div class="cc-lhead"><b>놓은 포지션 ' + S.list.length + "건</b><span class=\"cc-muted\">줄을 누르면 차트가 그 자리로</span></div>" + rows;
  }
  // 30일 뒤 시드 작은 그래프(확대·축소·이동 되는 같은 라이브러리 차트)
  const proj = { chart: null, line: null };
  function renderProj(pj) {
    const box = $("ccProj");
    if (!box || !pj) {
      if (proj.chart) {
        try {
          proj.chart.remove();
        } catch (_) {}
        proj.chart = null;
      }
      return;
    }
    if (!proj.chart || proj.host !== box) {
      if (proj.chart) {
        try {
          proj.chart.remove();
        } catch (_) {}
      }
      proj.host = box;
      proj.chart = LW.createChart(box, Object.assign({
        autoSize: true,
        layout: { background: { type: "solid", color: css("--card") }, textColor: css("--sub"), fontSize: 11, attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, tickMarkFormatter: (t) => Math.round((t - BASE_DAY) / 86400) + "일" },
        localization: { locale: "ko-KR", timeFormatter: (t) => Math.round((t - BASE_DAY) / 86400) + "일 뒤" },
        crosshair: { mode: 0 },
      }, INTERACTION));
      proj.line = proj.chart.addSeries(LW.LineSeries, { color: css("--acc"), lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    }
    proj.line.setData(pj.curve.map((c) => ({ time: BASE_DAY + c.d * 86400, value: c.v })));
    proj.chart.timeScale().fitContent();
  }
  const BASE_DAY = 1767225600;            // 그래프 가로축 자리(날짜가 아니라 '며칠 뒤' 로만 읽는다)

  function renderSum() {
    const st = CALC.stats(S.list, S.cfg);
    const perDay = S.cfg.perDay != null ? S.cfg.perDay : st.perDay;
    const pj = st.n ? CALC.project30(S.cfg.seed, st.avgPct, perDay, 30) : null;
    const card = (lab, val, sub, cls) => '<div class="cc-card' + (cls ? " " + cls : "") + '"><span>' + lab + "</span><b>" + val + "</b>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
    const sign = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
    const main = card("건당 평균 수익률", CALC.pct(st.avgPct), "수수료 뒤 · 시드 대비", sign(st.avgPct)) +
      card("승률", st.n ? fmtNum(st.winRate, 1) + "%" : "—", "끝난 " + st.n + "건");
    // 30일 칸: 금액은 가정 문구·표본 n 과 같은 크기(경쟁 비교 b '금액은 같은 크기 이하') · n < MIN_N 이면 흐리게
    const projLine = '<p class="cc-pj proj' + (st.n < CALC.MIN_N ? " dim" : "") + '"><span>30일 뒤 시드(가정)</span> <b>' + (pj ? fmtNum(pj.final, 2) : "—") + "</b> · " +
      "<span>" + (pj ? "지금까지 " + st.n + "건 평균이 그대로라면" : "끝난 건이 없어요") + "</span> · <span>표본 " + st.n + "건</span></p>";
    const more = card("평균 R", st.n ? (st.avgR > 0 ? "+" : st.avgR < 0 ? "−" : "") + fmtNum(Math.abs(st.avgR), 2) + "R" : "—", "수수료 뒤 순 R") +
      card("누적 단리", CALC.pct(st.n ? st.simplePct : null), "더한 값", sign(st.simplePct)) +
      card("누적 복리", CALC.pct(st.n ? st.compPct : null), "곱한 값", sign(st.compPct)) +
      card("최대 낙폭", st.n ? "−" + fmtNum(st.mddPct, 2) + "%" : "—", "복리 곡선 꼭대기에서") +
      card("진행 · 미체결", st.open + " · " + st.none, "요약에서 뺌");
    const perDayTxt = perDay != null ? fmtNum(perDay, 2) + "건/일" + (S.cfg.perDay != null ? "(직접 넣음)" : "(기록 " + fmtNum(Math.max(1, st.spanDays), 1) + "일)") : "—";
    const open = S.sumOpen;
    // 위 표시판(계산기 화면처럼 큰 숫자 한 줄) — 건당 평균 · 30일 뒤 시드 · 승률
    $("ccDisp").innerHTML = '<div class="cc-cards main">' + main + "</div>" + projLine +
      (st.n && st.n < CALC.MIN_N ? '<p class="cc-thin">기록이 적어(' + st.n + "건) 계산값이 크게 흔들려요</p>" :
        st.n && st.n < 30 ? '<p class="cc-thin">표본 ' + st.n + "건 — 추정이 흔들릴 수 있음</p>" : "");
    $("ccSum").innerHTML =
      '<button type="button" class="cc-more" data-a="sum" aria-expanded="' + open + '">' + (open ? "▴ 접기" : "▾ 단리 · 복리 · 낙폭 · 30일 그래프") + "</button>" +
      '<div class="cc-sumx"' + (open ? "" : " hidden") + ">" +
      '<div class="cc-cards">' + more + "</div>" +
      '<p class="cc-basis">' + esc(CALC.basis(S.cfg)) + " · 시드 " + fmtNum(S.cfg.seed, 2) + " USDT</p>" +
      '<p class="cc-basis">30일 뒤 = 시드 × (1 + 건당 평균 수익률)^(하루 ' + perDayTxt + " × 30일) — 지난 기록의 평균을 그대로 늘린 계산</p>" +
      (pj ? '<div id="ccProj" class="cc-proj" aria-label="30일 동안 시드(일별 복리 곡선)"></div>' : "") +
      "</div>";
    if (open && pj) renderProj(pj);
    else renderProj(null);
  }
  function renderSet() {
    const c = S.cfg;
    const put = (id, v) => {
      const el = $(id);
      if (el && d.activeElement !== el) el.value = v == null ? "" : String(v);
    };
    put("fSeed", c.seed);
    put("fRisk", c.risk);
    put("fLev", c.lev);
    put("fFee", c.fee);
    put("fSl", c.slPct);
    put("fTp", c.tpPct);
    put("fPerDay", c.perDay);
    const ud = $("ccUpdown");
    if (ud) ud.textContent = store.get("updown", "kr") === "global" ? "초록 상승 · 빨강 하락" : "빨강 상승 · 파랑 하락";
    $("ccSetSum").textContent = "설정 · 시드 " + fmtNum(c.seed, 0) + " USDT · " + "위험 " + fmtNum(c.risk, 2) + "% · 레버리지 " + fmtNum(c.lev, 2) + "배" +
      " · 수수료 " + fmtNum(c.fee, 2) + "%";
  }
  function renderTools() {
    for (const b of d.querySelectorAll('[data-a="arm"]')) b.classList.toggle("on", b.getAttribute("data-v") === S.arm);
    $("ccHint").textContent = S.arm ? "차트에서 진입 가격을 누르세요 · 다시 누르면 취소" :
      S.list.length ? "상자를 누르면 고르고, 선을 끌어 옮겨요" : "롱·숏을 누르고 차트를 누르면 그 가격이 진입가예요";
    host.classList.toggle("arm", !!S.arm);
  }
  function renderAll() {
    renderBar();
    renderTools();
    renderSel();
    renderList();
    renderSum();
    renderSet();
    paint();
  }

  function focusPos(p) {
    if (p.sym !== S.cfg.sym || p.tf !== S.cfg.tf) {
      S.cfg.sym = p.sym;
      S.cfg.tf = p.tf;
      save();
      loadChart().then(() => focusPos(p));
      return;
    }
    const l = logicalOf(p.t);
    if (l == null) return;
    const r = chart.timeScale().getVisibleLogicalRange(), w = r ? Math.max(40, r.to - r.from) : 120;
    chart.timeScale().setVisibleLogicalRange({ from: l - w * 0.35, to: l + w * 0.65 });
    paint();
  }

  // ── 눌림 ──
  d.addEventListener("click", (ev) => {
    const t = ev.target.closest && ev.target.closest("[data-a]");
    if (!t || t.tagName === "SELECT") return;
    const a = t.getAttribute("data-a"), v = t.getAttribute("data-v");
    if (a !== "del" && a !== "import" && S.delAsk) S.delAsk = null;     // 가져오기 두 번 누르기 확인('__import')을 첫 줄에서 지우지 않게
    if (a === "sym" || a === "tf") {
      if (S.cfg[a] === v) return;
      S.cfg[a] = v;
      save();
      renderAll();
      loadChart();
    } else if (a === "arm") {
      S.arm = S.arm === v ? null : v;
      renderTools();
    } else if (a === "sel") {
      const p = S.list.find((x) => x.id === v);
      if (!p) return;
      S.sel = p.id;
      renderAll();
      if (t.classList.contains("cc-row")) focusPos(p);
    } else if (a === "unsel") {
      S.sel = null;
      renderAll();
    } else if (a === "del") {
      ev.stopPropagation();
      if (S.delAsk !== v) {
        S.delAsk = v;
        renderList();
        G.setTimeout(() => {
          if (S.delAsk === v) {
            S.delAsk = null;
            renderList();
          }
        }, 4000);
        return;
      }
      S.delAsk = null;
      S.list = S.list.filter((x) => x.id !== v);
      if (S.sel === v) S.sel = null;
      save();
      renderAll();
    } else if (a === "csv") {
      const txt = CALC.csv(S.list, S.cfg);
      $("fIo").value = txt;
      try {
        const url = G.URL.createObjectURL(new G.Blob(["﻿" + txt], { type: "text/csv;charset=utf-8" }));
        const aEl = d.createElement("a");
        aEl.href = url;
        aEl.download = "chart-calc-" + new Date().toISOString().slice(0, 10) + ".csv";
        d.body.appendChild(aEl);
        aEl.click();
        aEl.remove();
        G.setTimeout(() => G.URL.revokeObjectURL(url), 5000);
      } catch (_) {}
      $("ccIoMsg").textContent = S.list.length + "건을 CSV 로 만들었어요(파일 받기 · 칸에도 넣음)";
    } else if (a === "theme") {
      const cur = store.get("theme", "auto"), i = THEMES.indexOf(cur);
      store.put("theme", THEMES[(i + 1) % THEMES.length]);
      retheme();
    } else if (a === "updown") {
      store.put("updown", store.get("updown", "kr") === "global" ? "kr" : "global");
      retheme();
      renderSet();
    } else if (a === "sum") {
      S.sumOpen = !S.sumOpen;
      store.put("sumOpen", S.sumOpen);
      renderSum();
    } else if (a === "export") {
      const txt = JSON.stringify({ kind: "calc/1", cfg: S.cfg, list: S.list });
      $("fIo").value = txt;
      $("fIo").select();
      // 복사는 약속(Promise) — 끝난 뒤에만 '복사함'(권한 거부 시 콘솔 오류·거짓 '복사함' 막기)
      const n = S.list.length, msg = (s) => { $("ccIoMsg").textContent = n + "건을 글로 만들었어요" + s; };
      msg(" — 칸의 글을 복사해 두세요");
      try {
        const pr = G.navigator.clipboard && G.navigator.clipboard.writeText(txt);
        if (pr && pr.then) pr.then(() => msg("(복사함)"), () => {});
      } catch (_) {}
    } else if (a === "import") {
      let o = null;
      try {
        o = JSON.parse($("fIo").value);
      } catch (_) {}
      if (!o || typeof o !== "object") {
        $("ccIoMsg").textContent = "글 모양이 맞지 않아요(내보내기로 만든 글을 붙여 넣으세요)";
        return;
      }
      if (S.delAsk !== "__import") {
        S.delAsk = "__import";
        t.textContent = "한 번 더 누르면 지금 목록을 바꿔요";
        G.setTimeout(() => {
          if (S.delAsk === "__import") S.delAsk = null;
          t.textContent = "붙여넣은 글로 바꾸기";
        }, 4000);
        return;
      }
      S.delAsk = null;
      t.textContent = "붙여넣은 글로 바꾸기";
      const c = CALC.clean(o);
      S.cfg = c.cfg;
      S.list = c.list;
      S.sel = null;
      save();
      $("ccIoMsg").textContent = c.list.length + "건을 가져왔어요";
      renderAll();
      loadChart();
    }
  });
  d.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t && t.getAttribute && t.getAttribute("data-a") === "man") {
      const p = S.list.find((x) => x.id === t.getAttribute("data-v"));
      if (!p) return;
      p.man = CALC.MAN[t.value] ? t.value : null;
      save();
      renderAll();
    }
  });
  d.addEventListener("pointerdown", (ev) => {           // 결과 칸을 눌러도 줄 고르기(차트 이동)가 안 일어나게
    if (ev.target && ev.target.tagName === "SELECT") ev.stopPropagation();
  }, true);
  d.addEventListener("input", (ev) => {
    const id = ev.target && ev.target.id;
    if (id === "pE" || id === "pSl" || id === "pTp") priceInput(id, ev.target.value);
  });
  const FIELDS = { fSeed: "seed", fRisk: "risk", fLev: "lev", fFee: "fee", fSl: "slPct", fTp: "tpPct", fPerDay: "perDay" };
  d.addEventListener("input", (ev) => {
    const k = FIELDS[ev.target && ev.target.id];
    if (!k) return;
    const raw = ev.target.value.trim(), v = CALC.num(raw);
    if (k === "perDay" && raw === "") S.cfg.perDay = null;
    else if (v != null && (k === "fee" ? v >= 0 : v > 0)) S.cfg[k] = v;
    else return;
    save();
    renderSel();
    renderList();
    renderSum();
    renderSet();
    paint();
  });

  renderAll();
  loadChart();
  // 오프라인 껍데기(sw.js) — https 또는 이 컴퓨터 주소에서만
  try {
    if (G.navigator.serviceWorker && (G.location.protocol === "https:" || G.location.hostname === "127.0.0.1" || G.location.hostname === "localhost")) {
      G.navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  } catch (_) {}
  // 시험·확인용(읽기만 + 놓기 흉내) — 화면 동작과 같은 길
  CALC.debug = () => ({ cfg: S.cfg, list: S.list, sel: S.sel, bars: S.bars.length, stats: CALC.stats(S.list, S.cfg),
                       priceRange: (() => { try { return cs.priceScale().getVisibleRange(); } catch (_) { return null; } })() });
  CALC.yOf = (p) => yOf(p);
  CALC.xOfTime = (t) => xOf(logicalOf(t));
})(typeof window !== "undefined" ? window : globalThis);
