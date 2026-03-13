import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";

// ─── PUBLIC CONFIG (no contract internals exposed) ───────
const OPNET_CONFIG = {
  network:  "testnet",
  rpc:      "https://api.opnet.org",
  rpcFallback: "https://testnet.opnet.org",
  explorer: "https://explorer.opnet.org",
  faucet:   "https://faucet.opnet.org",
  // Contract addresses are resolved server-side — not exposed in frontend bundle
};

// Internal resolver — fetches contract routing from backend (or env at build time)
// In production this would call your own API: /api/contracts
const _CONTRACTS = {
  PerpEngine:       import.meta?.env?.VITE_CONTRACT_PERP       || "opt1sqpzkfwhrwnr06zxy59as5dhxwyedsaqvjqe2pl2a",
  SwapRouter:       import.meta?.env?.VITE_CONTRACT_SWAP       || "opt1sqqdtff0pg0u9fz96hm38e4r9hll5npj6echm057y",
  LiquidityPool:    import.meta?.env?.VITE_CONTRACT_LP         || "opt1sqrae3j7zcs23w9speszaht004952wfn575z3tg4k",
  ReferralRegistry: import.meta?.env?.VITE_CONTRACT_REFERRAL   || "opt1sqplt3ew3gucdyh36pnj0l79edu60j5226squhxwk",
};
function getContract(name) { return _CONTRACTS[name]; }

// ─── OPNET RPC HELPER ─────────────────────────────────────
async function opnetRPC(method, params = []) {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const headers = { "Content-Type":"application/json" };
  try {
    const r = await fetch(OPNET_CONFIG.rpc, { method:"POST", headers, body });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "RPC error");
    return d.result;
  } catch {
    // fallback
    const r2 = await fetch(OPNET_CONFIG.rpcFallback, { method:"POST", headers, body });
    const d2 = await r2.json();
    return d2.result;
  }
}

// ─── WALLET PROVIDER DETECTION (v12 — definitive) ─────────────────────────
//
// CONFIRMED ROOT CAUSE:
//   OP_WALLET is a direct UniSat fork. It injects into window.unisat ONLY.
//   It does NOT set window.opnet. It has NO brand flags (no isOKExWallet,
//   no isUnisat). OKX also injects into window.unisat AND window.okxwallet.
//   UniSat sets window.unisat_wallet (added to prevent conflicts) AND
//   window.unisat with isUnisat=true.
//
// PRIORITY MAP (unique namespaces, no collisions):
//   OP_WALLET → window.unisat           (no brand flags, not OKX, not UniSat)
//   UniSat    → window.unisat_wallet    (authoritative UniSat key, no conflict)
//   OKX       → window.okxwallet.bitcoin (own namespace, never overlaps)
//   Xverse    → window.BitcoinProvider
//
// DETECTION ORDER — always check most-specific namespaces first:
//   1. OKX     via window.okxwallet.bitcoin   (private namespace, unambiguous)
//   2. UniSat  via window.unisat_wallet        (UniSat added this to prevent conflicts)
//   3. Xverse  via window.BitcoinProvider
//   4. OP_WALLET = whatever is left in window.unisat (it's the ONLY one that
//      doesn't have its own unique namespace — process of elimination)
//
// IMPORTANT: We NEVER use window.unisat for UniSat detection. We use
//   window.unisat_wallet instead. This is the key insight that makes it work.

// Wait for a specific window key to appear (extensions inject async after page load)
function waitForProvider(getProvider, timeoutMs = 3000) {
  if (typeof window === "undefined") return Promise.resolve(null);
  const found = getProvider();
  if (found) return Promise.resolve(found);
  return new Promise(resolve => {
    const start = Date.now();
    const iv = setInterval(() => {
      const p = getProvider();
      if (p) { clearInterval(iv); resolve(p); return; }
      if (Date.now() - start >= timeoutMs) { clearInterval(iv); resolve(null); }
    }, 80);
  });
}

// Snapshot of currently-installed wallets for the UI
function detectWallets() {
  if (typeof window === "undefined") return {};
  const r = {};
  // OKX — own private namespace
  if (window.okxwallet?.bitcoin) r.OKX = window.okxwallet.bitcoin;
  // UniSat — use window.unisat_wallet (their anti-conflict key), NOT window.unisat
  if (window.unisat_wallet) r.UniSat = window.unisat_wallet;
  // Xverse
  if (window.BitcoinProvider) r.Xverse = window.BitcoinProvider;
  // OP_WALLET — whatever remains in window.unisat that isn't OKX or UniSat
  // (process of elimination: OP_WALLET is the only one with no unique namespace)
  const u = window.unisat;
  if (u && !r.OKX && !r.UniSat) {
    // Both OKX and UniSat are absent but window.unisat exists → must be OP_WALLET
    r.OP_WALLET = u;
  } else if (u && !u.isOKExWallet && !u.isOKX && !u.isUnisat) {
    // OKX or UniSat present in their own namespaces, window.unisat has no brand flags
    r.OP_WALLET = u;
  }
  return r;
}

// Connect to the EXACT provider the user selected
async function connectSpecificWallet(walletKey) {
  let provider = null;

  if (walletKey === "OP_WALLET") {
    // Wait for window.unisat with no OKX/UniSat brand flags
    // Also accept window.opnet if the extension ever starts setting it
    provider = await waitForProvider(() => {
      if (window.opnet) return window.opnet;
      const u = window.unisat;
      if (!u) return null;
      // Confirm it's not OKX and not UniSat (process of elimination = OP_WALLET)
      if (u.isOKExWallet || u.isOKX || u.isUnisat) return null;
      return u;
    }, 3000);
    if (!provider) throw new Error("OP_WALLET_NOT_FOUND");

  } else if (walletKey === "UniSat") {
    // Use window.unisat_wallet first (UniSat's own anti-conflict key)
    // Fall back to window.unisat only if it has isUnisat=true flag
    provider = await waitForProvider(() => {
      if (window.unisat_wallet) return window.unisat_wallet;
      const u = window.unisat;
      if (u && u.isUnisat === true && !u.isOKExWallet) return u;
      return null;
    }, 3000);
    if (!provider) throw new Error("NO_WALLET");

  } else if (walletKey === "OKX") {
    provider = await waitForProvider(() => window.okxwallet?.bitcoin || null, 3000);
    if (!provider) throw new Error("NO_WALLET");

  } else if (walletKey === "Xverse") {
    provider = await waitForProvider(() => window.BitcoinProvider || null, 3000);
    if (!provider) throw new Error("NO_WALLET");
  }

  if (!provider) throw new Error("NO_WALLET");

  try {
    const accounts = await provider.requestAccounts();
    if (!accounts?.length) throw new Error("No accounts returned");
    let pubkey = "", balance = 0, network = "testnet";
    try { pubkey  = await provider.getPublicKey(); } catch {}
    try { const b  = await provider.getBalance(); balance = (b.confirmed || b.total || 0) / 1e8; } catch {}
    try { network = await provider.getNetwork(); } catch {}
    return { address: accounts[0], name: walletKey, pubkey, balance, network };
  } catch(e) {
    if (e.message?.includes("User rejected") || e.code === 4001 || e.code === -32603)
      throw new Error("USER_REJECTED");
    throw e;
  }
}

// Auto-reconnect on page load — non-prompting (getAccounts vs requestAccounts)
async function connectOPNetWallet() {
  const wallets = detectWallets();
  const key = ["OP_WALLET","UniSat","OKX","Xverse"].find(k => wallets[k]);
  if (!key) throw new Error("NO_WALLET");
  return connectSpecificWallet(key);
}

// ─── THEME ───────────────────────────────────────────────
const ThemeCtx = createContext(null);
const useTheme = () => useContext(ThemeCtx);
function ThemeProvider({ children }) {
  const [dark, setDark] = useState(true);
  const th = dark ? {
    dark, toggle: () => setDark(d => !d),
    bg:"#0a0500", bg2:"#110800", bg3:"#180c00",
    border:"#2e1800", border2:"#1e1000",
    text:"#fff4e6", textMid:"#c8924a", textDim:"#7a5228", textFaint:"#3d2810",
    accent:"#F7931A", red:"#ff3a3a",
    card:"rgba(16,8,0,0.97)", input:"#0d0600",
    navBg:"rgba(10,5,0,0.97)",
  } : {
    dark, toggle: () => setDark(d => !d),
    bg:"#fff8f0", bg2:"#fff0dc", bg3:"#ffffff",
    border:"#f5d4a0", border2:"#ffe0b0",
    text:"#1a0d00", textMid:"#7a3d00", textDim:"#b86a1a", textFaint:"#d49050",
    accent:"#e07800", red:"#cc2200",
    card:"rgba(255,255,255,0.97)", input:"#fff8f0",
    navBg:"rgba(255,248,240,0.97)",
  };
  return <ThemeCtx.Provider value={th}>{children}</ThemeCtx.Provider>;
}

// ─── TOAST ───────────────────────────────────────────────
const ToastCtx = createContext(null);
const useToast = () => useContext(ToastCtx);
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type = "info", dur = 3500) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-3), { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), dur);
  }, []);
  const clr = { success:"#F7931A", error:"#ff3a3a", warning:"#ffb347", info:"#ffcc66", trade:"#ff6600" };
  return (
    <ToastCtx.Provider value={add}>
      {children}
      <div style={{ position:"fixed", top:68, right:14, zIndex:999, display:"flex", flexDirection:"column", gap:7, pointerEvents:"none" }}>
        {toasts.map(t => (
          <div key={t.id} style={{ background:"#110800", border:`1px solid ${clr[t.type]}30`, borderLeft:`3px solid ${clr[t.type]}`, borderRadius:10, padding:"9px 14px", color:"#fff4e6", fontSize:12, fontFamily:"'IBM Plex Mono',monospace", animation:"fadeUp .2s ease", maxWidth:300 }}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ─── DATA ────────────────────────────────────────────────
const TOKENS = [
  { symbol:"BTC",  price:67420.50, change:+2.34, color:"#F7931A" },
  { symbol:"ETH",  price:3812.80,  change:+1.87, color:"#627EEA" },
  { symbol:"SOL",  price:182.40,   change:-0.92, color:"#9945FF" },
  { symbol:"OP",   price:2.847,    change:+4.21, color:"#FF0420" },
  { symbol:"ARB",  price:1.234,    change:-1.43, color:"#12AAFF" },
  { symbol:"AVAX", price:38.92,    change:+0.67, color:"#E84142" },
  { symbol:"LINK", price:16.74,    change:+3.05, color:"#375BD2" },
];
const POOLS = [
  { pair:"BTC/USDC", tvl:24.8, vol:8.4,  apy:18.4 },
  { pair:"ETH/USDC", tvl:18.2, vol:12.1, apy:22.1 },
  { pair:"SOL/USDC", tvl:7.6,  vol:3.2,  apy:31.7 },
  { pair:"OP/USDC",  tvl:4.1,  vol:1.8,  apy:44.2 },
  { pair:"ARB/USDC", tvl:3.3,  vol:2.1,  apy:38.9 },
];
const INIT_POS = [
  { id:1, market:"BTC/USDC", side:"LONG",  size:0.5,  entry:65200,  liq:58100,  leverage:10, pnl:+1110.25, tp:72000, sl:62000, margin:3260 },
  { id:2, market:"ETH/USDC", side:"SHORT", size:2.0,  entry:3950,   liq:4740,   leverage:5,  pnl:-274.40,  tp:3500,  sl:4100,  margin:1580 },
  { id:3, market:"SOL/USDC", side:"LONG",  size:20,   entry:175.20, liq:157.68, leverage:8,  pnl:+144.00,  tp:210,   sl:165,   margin:438  },
];
const LEADERS = [
  { rank:1, addr:"0xf3a1…8c2d", pnl:142840, roi:284.1, winRate:71.2, badge:"🏆" },
  { rank:2, addr:"0x9b22…1fa0", pnl:98320,  roi:196.6, winRate:68.8, badge:"🥈" },
  { rank:3, addr:"0xd441…77bc", pnl:81100,  roi:162.2, winRate:63.4, badge:"🥉" },
  { rank:4, addr:"0x2c90…e321", pnl:64200,  roi:128.4, winRate:59.3, badge:"" },
  { rank:5, addr:"0x77ff…4a1c", pnl:52880,  roi:105.8, winRate:57.1, badge:"" },
  { rank:6, addr:"0xab44…c800", pnl:41200,  roi:82.4,  winRate:64.2, badge:"" },
  { rank:7, addr:"0x1d88…9923", pnl:34700,  roi:69.4,  winRate:61.2, badge:"" },
  { rank:8, addr:"0x6622…bb01", pnl:28100,  roi:56.2,  winRate:55.7, badge:"" },
];
const REFERRAL = {
  code:"OPPERPX-X7K2M", tier:2, progress:68,
  earned:2841.50, pending:124.80, count:47,
  tiers:[
    { n:1, label:"Starter",  need:0,  rebate:"10%", color:"#6a9a9a" },
    { n:2, label:"Builder",  need:10, rebate:"15%", color:"#F7931A" },
    { n:3, label:"Partner",  need:25, rebate:"20%", color:"#F7931A" },
    { n:4, label:"Champion", need:50, rebate:"25%", color:"#FFD700" },
  ],
  referred:[
    { addr:"0xaa11…bb22", vol:"$12,400", earned:"$37.20", active:true },
    { addr:"0xcc33…dd44", vol:"$8,200",  earned:"$24.60", active:true },
    { addr:"0xee55…ff66", vol:"$31,000", earned:"$93.00", active:true },
    { addr:"0x1122…3344", vol:"$19,700", earned:"$59.10", active:false },
  ],
};

// ─── UTILS ───────────────────────────────────────────────
const fmt = (n, d=2) => Number(n).toLocaleString("en-US", { minimumFractionDigits:d, maximumFractionDigits:d });
const fmtP = p => p >= 1000 ? fmt(p,2) : p >= 1 ? fmt(p,3) : fmt(p,4);
const rnd = () => "0x" + [...Array(12)].map(()=>"0123456789abcdef"[Math.random()*16|0]).join("");

function genCandles(base, n=55) {
  let p = base * 0.94; const out = [];
  for (let i=0; i<n; i++) {
    const o=p, d=(Math.random()-.47)*p*.013, c=o+d;
    out.push({ o, h:Math.max(o,c)*(1+Math.random()*.004), l:Math.min(o,c)*(1-Math.random()*.004), c, v:Math.random()*400+80 });
    p = c;
  }
  return out;
}

function buildBook(mid, g=0.5, lv=10) {
  const asks=[], bids=[];
  let cA=0, cB=0;
  for (let i=1; i<=lv; i++) {
    const ap = +(mid + i*g*1.6).toFixed(2); const sz = +(Math.random()*2.5+.1).toFixed(2); cA+=sz;
    asks.push({ price:ap, size:sz, total:+cA.toFixed(3) });
    const bp = +(mid - i*g*1.6).toFixed(2); const bs = +(Math.random()*2.5+.1).toFixed(2); cB+=bs;
    bids.push({ price:bp, size:bs, total:+cB.toFixed(3) });
  }
  return { asks:asks.sort((a,b)=>a.price-b.price), bids:bids.sort((a,b)=>b.price-a.price) };
}

// ─── CANDLE CHART ─────────────────────────────────────────
function CandleChart({ candles }) {
  const W=640, H=200, pl=6, pr=52, pt=8, pb=18;
  const n=candles.length, cw=W/n, bw=Math.max(cw*.62,2);
  const lo=Math.min(...candles.map(c=>c.l)), hi=Math.max(...candles.map(c=>c.h)), rng=hi-lo||1;
  const sy = v => H-pb-((v-lo)/rng)*(H-pt-pb);
  const last = candles[candles.length-1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"100%" }}>
      {[.25,.5,.75].map(f => (
        <g key={f}>
          <line x1={pl} x2={W-pr} y1={pt+f*(H-pt-pb)} y2={pt+f*(H-pt-pb)} stroke="#0d2828" strokeDasharray="3,5"/>
          <text x={W-pr+3} y={pt+f*(H-pt-pb)+3.5} fontSize="8" fill="#7a5228" fontFamily="'IBM Plex Mono',monospace">{fmtP(hi-f*rng)}</text>
        </g>
      ))}
      {candles.map((c,i) => {
        const x=pl+i*cw+cw/2, col=c.c>=c.o?"#F7931A":"#ff3a3a";
        return (
          <g key={i}>
            <line x1={x} y1={pt+sy(c.h)} x2={x} y2={pt+sy(c.l)} stroke={col} strokeWidth={.9}/>
            <rect x={pl+i*cw+(cw-bw)/2} y={pt+Math.min(sy(c.o),sy(c.c))} width={bw} height={Math.max(Math.abs(sy(c.o)-sy(c.c)),1)} fill={col} opacity={.87}/>
          </g>
        );
      })}
      {(() => {
        const y=pt+sy(last.c); const up=last.c>=last.o;
        return (<>
          <line x1={pl} x2={W-pr} y1={y} y2={y} stroke={up?"#F7931A40":"#ff3a3a40"} strokeDasharray="2,4"/>
          <rect x={W-pr+1} y={y-8} width={48} height={16} rx={3} fill={up?"#F7931A":"#ff3a3a"}/>
          <text x={W-pr+25} y={y+4} textAnchor="middle" fontSize="8" fill="#000" fontWeight="700" fontFamily="'IBM Plex Mono',monospace">{fmtP(last.c)}</text>
        </>);
      })()}
    </svg>
  );
}

// ─── ORDER BOOK ───────────────────────────────────────────
function OrderBook({ mid, onFill, th }) {
  const [book, setBook] = useState(() => buildBook(mid));
  useEffect(() => {
    const iv = setInterval(() => setBook(buildBook(mid)), 1300);
    return () => clearInterval(iv);
  }, [mid]);
  const maxT = Math.max(...book.asks.map(a=>a.total), ...book.bids.map(b=>b.total), 1);
  const Row = ({ row, side }) => (
    <div onClick={() => onFill({ price:row.price, side })}
      style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", padding:"2px 8px", cursor:"pointer", position:"relative" }}
      onMouseEnter={e => e.currentTarget.style.background = side==="sell"?"rgba(255,77,109,0.08)":"rgba(0,212,160,0.08)"}
      onMouseLeave={e => e.currentTarget.style.background = "none"}>
      <div style={{ position:"absolute", right:0, top:0, bottom:0, width:`${(row.total/maxT)*100}%`, background:side==="sell"?"rgba(255,77,109,0.07)":"rgba(0,212,160,0.07)" }} />
      <span style={{ color:side==="sell"?th.red:th.accent, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", position:"relative" }}>{fmtP(row.price)}</span>
      <span style={{ color:th.textMid, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", textAlign:"center", position:"relative" }}>{row.size}</span>
      <span style={{ color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", textAlign:"right", position:"relative" }}>{row.total}</span>
    </div>
  );
  const spread = book.asks[0]?.price - book.bids[0]?.price || 0;
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", padding:"5px 8px 3px", borderBottom:`1px solid ${th.border}` }}>
        {["Price","Size","Total"].map(h => <span key={h} style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{h}</span>)}
      </div>
      <div style={{ flex:1, overflowY:"auto" }}>
        {[...book.asks].reverse().map((a,i) => <Row key={"a"+i} row={a} side="sell"/>)}
        <div style={{ display:"flex", justifyContent:"space-between", padding:"3px 8px", background:"rgba(255,153,51,0.06)", borderTop:`1px solid ${th.border}`, borderBottom:`1px solid ${th.border}` }}>
          <span style={{ color:"#ff9933", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>Spread</span>
          <span style={{ color:"#ff9933", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{fmtP(spread)}</span>
        </div>
        {book.bids.map((b,i) => <Row key={"b"+i} row={b} side="buy"/>)}
      </div>
    </div>
  );
}

// ─── TX OVERLAY ───────────────────────────────────────────
function TxOverlay({ tx, onDismiss, th }) {
  if (!tx) return null;
  const col = tx.status==="confirmed"?"#F7931A":tx.status==="failed"?"#ff3a3a":"#ff9933";
  return (
    <div style={{ position:"fixed", bottom:76, right:14, zIndex:800, width:290, background:th.bg2, border:`1px solid ${col}35`, borderRadius:14, padding:"13px 15px", boxShadow:"0 8px 32px rgba(0,0,0,.5)", animation:"fadeUp .2s ease" }}>
      <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:5 }}>
        <span style={{ color:col, fontSize:17, display:"inline-block", animation:tx.status==="pending"?"spin 1s linear infinite":undefined }}>{tx.status==="confirmed"?"✓":tx.status==="failed"?"✕":"⟳"}</span>
        <span style={{ color:th.text, fontSize:12, fontFamily:"'Syne',sans-serif", fontWeight:700, flex:1 }}>{tx.label}</span>
        <button onClick={onDismiss} style={{ background:"none", border:"none", color:th.textFaint, fontSize:16, cursor:"pointer" }}>×</button>
      </div>
      <div style={{ color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>
        {tx.status==="pending"&&"Awaiting confirmation…"}
        {tx.status==="confirmed"&&"Confirmed ✓"}
        {tx.status==="failed"&&"Transaction failed"}
      </div>
      {tx.hash && <div style={{ color:th.accent, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginTop:3 }}>{tx.hash.slice(0,28)}…</div>}
    </div>
  );
}

// ─── SIM PREVIEW ──────────────────────────────────────────
function SimPreview({ order, livePrice, onConfirm, onCancel, th }) {
  const [loading, setLoading] = useState(true);
  const [res, setRes] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const slip = order.type==="market" ? (Math.random()*.04+.005) : 0;
      const ep = order.type==="market" ? livePrice*(order.side==="long"?1+slip/100:1-slip/100) : parseFloat(order.lp||livePrice);
      const n = parseFloat(order.size)*ep;
      setRes({ ep, slip, n, fee:n*.0006, liq:order.side==="long"?ep*(1-.9/order.lev):ep*(1+.9/order.lev), margin:n/order.lev });
      setLoading(false);
    }, 850);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.72)", zIndex:700, display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(4px)" }} onClick={onCancel}>
      <div onClick={e=>e.stopPropagation()} style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:20, padding:"22px 20px", width:330, boxShadow:"0 24px 64px rgba(0,0,0,.6)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:14 }}>
          <span style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700 }}>Transaction Preview</span>
          <button onClick={onCancel} style={{ background:"none", border:"none", color:th.textDim, fontSize:18, cursor:"pointer" }}>×</button>
        </div>
        <div style={{ background:order.side==="long"?"rgba(247,147,26,.07)":"rgba(255,58,58,.07)", border:`1px solid ${order.side==="long"?"#F7931A25":"#ff3a3a25"}`, borderRadius:9, padding:"9px 12px", marginBottom:14 }}>
          <span style={{ color:order.side==="long"?th.accent:th.red, fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:700 }}>{order.side==="long"?"▲ Long":"▼ Short"} {order.size} {order.sym}</span>
          <span style={{ color:th.textMid, fontSize:11, marginLeft:10, fontFamily:"'IBM Plex Mono',monospace" }}>{order.lev}x {order.type}</span>
        </div>
        {loading ? (
          <div style={{ textAlign:"center", padding:"24px 0" }}>
            <div style={{ fontSize:28, animation:"spin 1s linear infinite", display:"inline-block", color:th.accent }}>₿</div>
            <div style={{ color:th.textDim, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", marginTop:8 }}>Simulating…</div>
          </div>
        ) : (
          <>
            <div style={{ background:th.bg3, border:`1px solid ${th.border}`, borderRadius:10, padding:"11px", marginBottom:14 }}>
              {[["Exec. Price",`$${fmtP(res.ep)}`,th.text],["Slippage",order.type==="market"?`${res.slip.toFixed(3)}%`:"None",res.slip>.02?"#ff9933":th.accent],["Notional",`$${fmt(res.n)}`,th.textMid],["Fee (0.06%)",`$${fmt(res.fee,4)}`,th.textDim],["Margin",`$${fmt(res.margin)}`,th.textMid],["Liq. Price",`$${fmtP(res.liq)}`,"#ff9933"]].map(([k,v,c])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                  <span style={{ color:th.textFaint, fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>{k}</span>
                  <span style={{ color:c, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
              <button onClick={onCancel} style={{ background:"none", border:`1px solid ${th.border}`, borderRadius:10, padding:"11px", color:th.textMid, fontSize:12, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Cancel</button>
              <button onClick={onConfirm} style={{ background:`linear-gradient(135deg,${order.side==="long"?"#F7931A,#e07800":"#ff3a3a,#cc2200"})`, border:"none", borderRadius:10, padding:"11px", color:"#000", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Confirm</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── WALLET MODAL ─────────────────────────────────────────
function WalletModal({ onClose, onConnect, th }) {
  const [loading, setLoading]       = useState(null);
  const [err, setErr]               = useState("");
  const [status, setStatus]         = useState(""); // step-by-step status msg
  const [installed, setInstalled]   = useState({}); // { OP_WALLET: true, OKX: true, ... }

  // Re-scan every 800ms while modal is open so INSTALLED badge appears
  // even if extension injects slightly after modal opens
  useEffect(() => {
    const scan = () => setInstalled(prev => {
      const w = detectWallets();
      const next = {};
      ["OP_WALLET","UniSat","OKX","Xverse"].forEach(k => { next[k] = !!w[k]; });
      return next;
    });
    scan();
    const iv = setInterval(scan, 800);
    return () => clearInterval(iv);
  }, []);

  const WALLETS = [
    { k:"OP_WALLET", i:"₿", d:"Official OPNet wallet · detected via window.unisat", c:"#F7931A", primary:true,
      installUrl:"https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb" },
    { k:"UniSat",    i:"🟠", d:"Bitcoin Ordinals wallet · window.unisat_wallet",    c:"#F7931A",
      installUrl:"https://unisat.io" },
    { k:"OKX",       i:"⬛", d:"OKX multi-chain · window.okxwallet.bitcoin",        c:"#8247E5",
      installUrl:"https://www.okx.com/web3" },
    { k:"Xverse",    i:"🔵", d:"Stacks & Bitcoin · window.BitcoinProvider",        c:"#375BD2",
      installUrl:"https://www.xverse.app" },
  ];

  const connect = async k => {
    setErr(""); setStatus(""); setLoading(k);
    try {
      if (k === "OP_WALLET") {
        setStatus("Waiting for OP_WALLET (window.opnet)…");
      }
      const info = await connectSpecificWallet(k);
      setStatus("");
      if (info.network && !(info.network||"").includes("testnet") && info.network !== "unknown") {
        setErr("⚠ Switch OP_WALLET to Bitcoin Testnet 3 and retry.");
        setLoading(null); return;
      }
      onConnect({ name:info.name, address:info.address, pubkey:info.pubkey,
                  balance:info.balance, network:info.network, real:true });
      onClose();
    } catch(e) {
      setStatus("");
      if (e.message === "OP_WALLET_NOT_FOUND") {
        setErr("OP_WALLET not detected. Install it first ↗");
        setTimeout(() => window.open("https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb","_blank"), 600);
      } else if (e.message === "USER_REJECTED") {
        setErr("Connection cancelled — please approve in your wallet.");
      } else if (e.message === "NO_WALLET") {
        const w = WALLETS.find(w => w.k === k);
        if (k === "OP_WALLET") {
          setErr("OP_WALLET not found. Install it first ↗");
          setTimeout(() => window.open(w?.installUrl,"_blank"), 600);
        } else {
          // Non-OP_WALLET: offer demo mode so users can still explore the UI
          setErr(`${k} not detected — entering demo mode.`);
          await new Promise(r => setTimeout(r, 700));
          onConnect({ name:k, address:"tb1p"+rnd(), pubkey:"", balance:0, network:"demo", real:false });
          onClose();
        }
      } else {
        setErr(e.message || "Connection failed. Try again.");
      }
    }
    setLoading(null);
  };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.76)", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(6px)" }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:20, padding:"26px 22px", width:380, boxShadow:"0 32px 80px rgba(0,0,0,.7)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:7 }}>
          <span style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:17, fontWeight:700 }}>Connect Wallet</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:th.textDim, fontSize:20, cursor:"pointer" }}>×</button>
        </div>
        <p style={{ color:th.textDim, fontSize:11, marginBottom:4, fontFamily:"'IBM Plex Mono',monospace" }}>
          Connect your Bitcoin wallet to trade on OPNet Testnet.
        </p>
        {/* Show which wallets were detected */}
        {Object.values(installed).some(Boolean) && (
          <div style={{ background:th.accent+"10", border:`1px solid ${th.accent}25`, borderRadius:8, padding:"6px 10px", marginBottom:10, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", color:th.accent }}>
            ✓ Detected: {Object.entries(installed).filter(([,v])=>v).map(([k])=>k).join(", ")}
          </div>
        )}
        {err && (
          <div style={{ background:"#ff3a3a10", border:"1px solid #ff3a3a30", borderRadius:8, padding:"6px 10px", marginBottom:12, color:"#ff3a3a", fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>
            {err}
          </div>
        )}
        {/* Step status shown while connecting OP_WALLET (async inject) */}
        {status && (
          <div style={{ background:th.accent+"12", border:`1px solid ${th.accent}30`, borderRadius:8, padding:"7px 10px", marginBottom:8, display:"flex", alignItems:"center", gap:8, color:th.accent, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>
            <span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span>
            {status}
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
          {WALLETS.map(w => {
            const isInstalled = installed[w.k];
            const isLoading   = loading === w.k;
            return (
            <button key={w.k} onClick={() => connect(w.k)} disabled={!!loading}
              style={{ background:isLoading?w.c+"15":w.primary?w.c+"06":th.input, border:`2px solid ${isLoading?w.c:w.primary&&isInstalled?w.c+"50":th.border}`, borderRadius:12, padding:"12px 14px", cursor:loading?"wait":"pointer", display:"flex", alignItems:"center", gap:12, opacity:loading&&!isLoading?.45:1, transition:"all .15s" }}
              onMouseEnter={e=>{ if(!loading){ e.currentTarget.style.borderColor=w.c+"70"; e.currentTarget.style.background=w.c+"10"; }}}
              onMouseLeave={e=>{ if(!loading){ e.currentTarget.style.borderColor=isLoading?w.c:w.primary&&isInstalled?w.c+"50":th.border; e.currentTarget.style.background=isLoading?w.c+"15":w.primary?w.c+"06":th.input; }}}>
              <div style={{ width:38, height:38, borderRadius:10, background:w.c+"20", border:`1px solid ${w.c}35`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:19, flexShrink:0 }}>{w.i}</div>
              <div style={{ flex:1, textAlign:"left" }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                  <span style={{ color:th.text, fontSize:13, fontWeight:700, fontFamily:"'Syne',sans-serif" }}>{w.k}</span>
                  {w.primary && <span style={{ background:th.accent+"25", color:th.accent, fontSize:8, fontFamily:"'IBM Plex Mono',monospace", padding:"2px 6px", borderRadius:4, fontWeight:700, letterSpacing:1 }}>RECOMMENDED</span>}
                  {isInstalled
                    ? <span style={{ background:"#22cc4415", color:"#22cc44", fontSize:8, fontFamily:"'IBM Plex Mono',monospace", padding:"2px 6px", borderRadius:4, fontWeight:700 }}>✓ DETECTED</span>
                    : <span style={{ background:"#ff3a3a10", color:"#ff3a3a", fontSize:8, fontFamily:"'IBM Plex Mono',monospace", padding:"2px 6px", borderRadius:4 }}>NOT FOUND</span>
                  }
                </div>
                <div style={{ color:th.textDim, fontSize:9, marginTop:2, fontFamily:"'IBM Plex Mono',monospace" }}>{w.d}</div>
              </div>
              {isLoading
                ? <span style={{ color:w.c, fontSize:18, display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span>
                : isInstalled
                  ? <span style={{ color:th.accent, fontSize:14, fontWeight:700 }}>→</span>
                  : <span style={{ color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>install</span>
              }
            </button>
            );
          })}
        </div>
        <div style={{ marginTop:12, padding:"10px 12px", background:th.accent+"08", border:`1px solid ${th.accent}20`, borderRadius:10 }}>
          <div style={{ color:th.accent, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>⬡ OPNet Testnet · 4 contracts deployed</div>
          <div style={{ color:th.textDim, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginTop:3 }}>PerpEngine · SwapRouter · LiquidityPool · Referral</div>
        </div>
        <div style={{ marginTop:10, color:th.textFaint, fontSize:10, textAlign:"center", fontFamily:"'IBM Plex Mono',monospace" }}>Non-custodial · Session expires 24h · OP_NET</div>
      </div>
    </div>
  );
}

// ─── NAV ──────────────────────────────────────────────────
function Nav({ page, setPage, wallet, onConnect, onDisconnect, th }) {
  const [menu, setMenu] = useState(false);
  const links = [["trade","Trade"],["swap","Swap"],["liquidity","Pools"],["leaderboard","Leaders"],["copy","Copy"],["referral","Referral 🎁"]];
  return (
    <nav style={{ position:"fixed", top:0, left:0, right:0, zIndex:400, background:th.navBg, backdropFilter:"blur(14px)", borderBottom:`1px solid ${th.border}`, height:60, display:"flex", alignItems:"center", padding:"0 12px", gap:8 }}>
      <div onClick={() => setPage("landing")} style={{ cursor:"pointer", display:"flex", alignItems:"center", gap:7, flexShrink:0, marginRight:6 }}>
        <div style={{ width:28, height:28, background:"linear-gradient(135deg,#F7931A,#c45e00)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", color:"#000", fontWeight:900, fontSize:14, fontFamily:"'Syne',sans-serif" }}>Ω</div>
        <span style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700 }}>OP<span style={{ color:th.accent }}>Perp</span>DEX</span>
        <span style={{ background:"#ff980015", border:"1px solid #ff980040", borderRadius:5, padding:"2px 6px", color:"#ff9800", fontSize:8, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700, letterSpacing:1 }}>TESTNET</span>
      </div>
      <div style={{ display:"flex", gap:1, flex:1, overflowX:"auto" }}>
        {links.map(([id,l]) => (
          <button key={id} onClick={() => setPage(id)} style={{ background:page===id?th.accent+"18":"none", border:`1px solid ${page===id?th.accent+"28":"transparent"}`, borderRadius:7, padding:"4px 9px", color:page===id?th.accent:th.textDim, fontSize:11, fontFamily:"'Syne',sans-serif", fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>{l}</button>
        ))}
      </div>
      <div style={{ display:"flex", gap:6, alignItems:"center", flexShrink:0 }}>
        <button onClick={th.toggle} style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:7, width:30, height:30, cursor:"pointer", fontSize:13, color:th.textMid, display:"flex", alignItems:"center", justifyContent:"center" }}>{th.dark?"☀":"🌙"}</button>
        {wallet.connected ? (
          <div style={{ position:"relative" }}>
            <button onClick={() => setMenu(m => !m)} style={{ background:th.accent+"15", border:`1px solid ${wallet.real?th.accent+"40":"#ff980040"}`, borderRadius:8, padding:"5px 10px", color:wallet.real?th.accent:"#ff9800", fontSize:11, fontFamily:"'IBM Plex Mono',monospace", cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background:wallet.real?th.accent:"#ff9800", boxShadow:`0 0 5px ${wallet.real?th.accent:"#ff9800"}`, display:"inline-block" }}/>
              {(wallet.address||"").slice(0,8)}…
              {(wallet.balance||0)>0 && <span style={{ color:th.textMid, fontSize:9 }}>{(wallet.balance||0).toFixed(4)} tBTC</span>}
              {!wallet.real && <span style={{ color:"#ff9800", fontSize:8 }}>DEMO</span>}
            </button>
            {menu && (
              <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, background:th.bg2, border:`1px solid ${th.border}`, borderRadius:11, padding:5, minWidth:160, zIndex:600 }}>
                {[["Portfolio","portfolio"],["Referral","referral"],["Disconnect",null]].map(([label,pg]) => (
                  <button key={label} onClick={() => { pg?setPage(pg):onDisconnect(); setMenu(false); }} style={{ background:"none", border:"none", color:pg?th.textMid:th.red, fontSize:12, padding:"7px 10px", cursor:"pointer", width:"100%", textAlign:"left", fontFamily:"'Syne',sans-serif", borderRadius:7 }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button onClick={onConnect} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:8, padding:"7px 13px", color:"#000", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Connect</button>
        )}
      </div>
    </nav>
  );
}

// ─── TICKER ───────────────────────────────────────────────
function Ticker({ prices, th }) {
  const items = [...TOKENS,...TOKENS].map((t,i) => ({ ...t, price:prices[t.symbol]||t.price, key:i }));
  return (
    <div style={{ position:"fixed", top:60, left:0, right:0, zIndex:300, background:th.bg2, borderBottom:`1px solid ${th.border}`, height:30, overflow:"hidden" }}>
      <div style={{ display:"flex", animation:"ticker 38s linear infinite", width:"max-content" }}>
        {items.map(t => (
          <div key={t.key} style={{ display:"flex", alignItems:"center", gap:6, padding:"0 14px", height:30, whiteSpace:"nowrap" }}>
            <span style={{ color:t.color, fontSize:9.5, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>{t.symbol}</span>
            <span style={{ color:th.text, fontSize:9.5, fontFamily:"'IBM Plex Mono',monospace" }}>${fmtP(t.price)}</span>
            <span style={{ color:t.change>=0?"#F7931A":"#ff3a3a", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{t.change>=0?"+":""}{t.change}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LANDING ──────────────────────────────────────────────
function Landing({ setPage, th }) {
  return (
    <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"80px 20px 60px", background:`radial-gradient(ellipse at 50% 0%,${th.accent}12 0%,transparent 65%)` }}>
      <div style={{ fontSize:11, color:th.accent, fontFamily:"'IBM Plex Mono',monospace", letterSpacing:".12em", marginBottom:18, background:th.accent+"12", border:`1px solid ${th.accent}22`, borderRadius:20, padding:"4px 14px" }}>LIVE ON OP_NET BITCOIN TESTNET</div>
      <h1 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:"clamp(32px,6vw,70px)", fontWeight:800, textAlign:"center", lineHeight:1.1, marginBottom:16 }}>
        Trade Perps<br/><span style={{ color:th.accent }}>On Bitcoin</span>
      </h1>
      <p style={{ color:th.textDim, fontSize:15, textAlign:"center", maxWidth:460, lineHeight:1.65, marginBottom:34 }}>
        The first decentralized perpetual futures exchange on OP_NET. Up to 50× leverage, sub-cent fees, non-custodial.
      </p>
      <div style={{ display:"flex", gap:12, marginBottom:40, flexWrap:"wrap", justifyContent:"center" }}>
        <button onClick={() => setPage("trade")} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:13, padding:"13px 30px", color:"#000", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Start Trading →</button>
        <button onClick={() => setPage("liquidity")} style={{ background:"none", border:`1px solid ${th.border}`, borderRadius:13, padding:"13px 30px", color:th.textMid, fontSize:14, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Add Liquidity</button>
      </div>

      {/* Social row */}
      <div style={{ display:"flex", gap:10, marginBottom:36, alignItems:"center", justifyContent:"center", flexWrap:"wrap" }}>
        <span style={{ color:th.textFaint, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>Join the community:</span>
        {[
          { label:"Twitter/X", href:"https://x.com/opnetbtc",           icon:"𝕏", color:"#1DA1F2" },
          { label:"Telegram",  href:"https://t.me/opnetbtc",            icon:"✈", color:"#2CA5E0" },
          { label:"Discord",   href:"https://discord.com/invite/opnet", icon:"⬡", color:"#5865F2" },
        ].map(s => (
          <a key={s.label} href={s.href} target="_blank" rel="noreferrer"
            style={{ display:"flex", alignItems:"center", gap:5, color:th.textMid, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", textDecoration:"none", padding:"6px 12px", borderRadius:20, border:`1px solid ${th.border}`, background:th.card, transition:"all .15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor=s.color+"60"; e.currentTarget.style.color=s.color; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=th.border; e.currentTarget.style.color=th.textMid; }}>
            <span style={{ fontSize:14 }}>{s.icon}</span>{s.label}
          </a>
        ))}
      </div>

      {/* ── Testnet Getting Started ── */}
      <div style={{ width:"100%", maxWidth:680, background:th.card, border:`1px solid ${th.accent}20`, borderRadius:16, padding:"18px 20px", marginBottom:32 }}>
        <div style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:10, fontWeight:700, letterSpacing:2, marginBottom:12 }}>⬡ GET STARTED ON TESTNET</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:10 }}>
          {[
            { n:"1", title:"Install OP_WALLET", desc:"Chrome extension — the official OPNet wallet", href:"https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb", btn:"Install →" },
            { n:"2", title:"Get tBTC", desc:"Free testnet BTC from faucet.opnet.org", href:"https://faucet.opnet.org", btn:"Faucet →" },
            { n:"3", title:"Connect & Trade", desc:'Click "Connect Wallet" — select OP_WALLET', href:null, btn:null },
          ].map(s => (
            <div key={s.n} style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:10, padding:"12px" }}>
              <div style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:18, fontWeight:700, marginBottom:4 }}>{s.n}</div>
              <div style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:600 }}>{s.title}</div>
              <div style={{ color:th.textDim, fontSize:10, marginTop:3, marginBottom:8 }}>{s.desc}</div>
              {s.href && <a href={s.href} target="_blank" rel="noreferrer" style={{ color:th.accent, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", textDecoration:"none", border:`1px solid ${th.accent}30`, borderRadius:6, padding:"3px 8px" }}>{s.btn}</a>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:12, width:"100%", maxWidth:680 }}>
        {[["$142M","24h Volume"],["$48M","Open Interest"],["12,400","Traders"],["0.06%","Taker Fee"]].map(([v,l]) => (
          <div key={l} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, padding:"18px", textAlign:"center" }}>
            <div style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:22, fontWeight:700 }}>{v}</div>
            <div style={{ color:th.textDim, fontSize:11, marginTop:4 }}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TRADE PAGE ───────────────────────────────────────────
function Trade({ wallet, onConnect, th, setPage }) {
  const toast = useToast();
  const [mkt, setMkt]     = useState(TOKENS[0]);
  const [side, setSide]   = useState("long");
  const [otype, setOT]    = useState("market");
  const [size, setSize]   = useState("");
  const [lev, setLev]     = useState(10);
  const [lp, setLP]       = useState("");
  const [tp, setTp]       = useState("");
  const [sl, setSl]       = useState("");
  const [mm, setMM]       = useState("cross");
  const [preview, setPv]  = useState(null);
  const [candles, setCdl] = useState(() => genCandles(TOKENS[0].price));
  const [price, setPrice] = useState(TOKENS[0].price);
  const [pos, setPos]     = useState(INIT_POS);
  const [ptab, setPtab]   = useState("positions");
  const [tf, setTf]       = useState("1H");
  const [tx, setTx]       = useState(null);
  const [fill, setFill]   = useState(null);

  // keyboard shortcuts
  useEffect(() => {
    const h = e => {
      if (["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key==="b"||e.key==="B") setSide("long");
      else if (e.key==="s"&&!e.ctrlKey) setSide("short");
      else if (e.key==="m"||e.key==="M") setOT("market");
      else if (e.key==="l"&&!e.ctrlKey) setOT("limit");
      else if (e.key==="Escape") { setPv(null); setFill(null); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      setPrice(p => +(p + (Math.random()-.49)*p*.0015).toFixed(p>100?2:4));
      setCdl(prev => {
        const last = prev[prev.length-1];
        const nc = last.c + (Math.random()-.48)*last.c*.005;
        return [...prev.slice(0,-1), {...last, c:nc, h:Math.max(last.h,nc), l:Math.min(last.l,nc)}];
      });
    }, 1700);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => { setCdl(genCandles(mkt.price)); setPrice(mkt.price); setFill(null); }, [mkt]);

  const liqMul = mm==="isolated"?.9:.95;
  const liqP   = size&&lev ? (side==="long"?+(price*(1-liqMul/lev)).toFixed(2):+(price*(1+liqMul/lev)).toFixed(2)) : null;
  const margin = size&&lev ? +(parseFloat(size||0)*price/lev).toFixed(2) : null;
  const notional = size ? +(parseFloat(size||0)*price).toFixed(2) : null;

  const handleOrder = () => {
    if (!wallet.connected) { onConnect(); return; }
    if (!size || parseFloat(size) <= 0) { toast("Enter a valid size","warning"); return; }
    setPv({ sym:mkt.symbol, side, lev, size, type:otype, lp });
  };

  const confirmOrder = () => {
    const ep = otype==="limit"&&lp ? parseFloat(lp) : price;
    setPv(null);
    const label = `${side==="long"?"▲ Long":"▼ Short"} ${size} ${mkt.symbol}`;
    setTx({ status:"pending", hash:null, label });
    setTimeout(() => {
      const h = rnd();
      setTx(t => ({...t, hash:h}));
      setTimeout(() => {
        setTx(t => ({...t, status:"confirmed"}));
        setPos(p => [{ id:Date.now(), market:mkt.symbol+"/USDC", side:side.toUpperCase(), size:parseFloat(size), entry:ep, liq:liqP||ep*.9, leverage:lev, pnl:0, tp:tp?parseFloat(tp):null, sl:sl?parseFloat(sl):null, margin:margin||0 }, ...p]);
        toast(label+" opened","trade");
        setSize(""); setTp(""); setSl(""); setLP("");
        setTimeout(() => setTx(null), 3000);
      }, 2000);
    }, 200);
  };

  const closePos = id => {
    const p = pos.find(x=>x.id===id);
    setPos(prev => prev.filter(x=>x.id!==id));
    toast(`Closed · PnL ${p?.pnl>=0?"+":"-"}$${fmt(Math.abs(p?.pnl||0))}`, p?.pnl>=0?"success":"error");
  };

  const onFill = ({ price:fp, side:s }) => {
    setSide(s==="sell"?"short":"long");
    setLP(fp.toFixed(fp>100?2:4));
    setOT("limit");
    setFill({ price:fp, side:s });
    toast(`↵ ${fmtP(fp)} filled from order book`, "info", 2500);
  };

  const used = Math.min((pos.reduce((a,p)=>a+(p.margin||0),0)/10000)*100, 100);

  // reusable label
  const Label = ({t}) => <label style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", display:"block", marginBottom:3 }}>{t}</label>;
  const numInput = (val, set, ph) => (
    <input type="number" value={val} onChange={e=>set(e.target.value)} placeholder={ph||"0.00"} style={{ width:"100%", background:th.input, border:`1px solid ${th.border}`, borderRadius:8, padding:"8px 10px", color:th.text, fontSize:12, fontFamily:"'IBM Plex Mono',monospace", outline:"none", boxSizing:"border-box" }}/>
  );

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 270px 248px", gap:9, height:"calc(100vh - 92px)", overflow:"hidden", padding:"9px" }}>

      {/* Market strip */}
      <div style={{ gridColumn:"1/4", display:"flex", gap:5, alignItems:"center", overflowX:"auto" }}>
        {TOKENS.slice(0,7).map(t => (
          <button key={t.symbol} onClick={() => setMkt(t)} style={{ background:mkt.symbol===t.symbol?th.accent+"18":th.card, border:`1px solid ${mkt.symbol===t.symbol?th.accent+"30":th.border}`, borderRadius:8, padding:"5px 11px", color:mkt.symbol===t.symbol?th.accent:th.textDim, fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace", whiteSpace:"nowrap" }}>{t.symbol}/USDC</button>
        ))}
        <div style={{ marginLeft:"auto", background:th.bg2, border:`1px solid ${th.border}`, borderRadius:7, padding:"3px 9px", display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          <span style={{ width:5, height:5, borderRadius:"50%", background:"#F7931A", display:"inline-block", boxShadow:"0 0 4px #F7931A" }}/>
          <span style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>OP_NET · ~0.8s</span>
        </div>
      </div>

      {/* ── Col 1: chart + positions ── */}
      <div style={{ display:"flex", flexDirection:"column", gap:8, overflow:"hidden", minWidth:0 }}>
        {/* price header */}
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, padding:"9px 13px", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
          <div>
            <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{mkt.symbol}/USDC · PERP</div>
            <div style={{ color:th.text, fontFamily:"'IBM Plex Mono',monospace", fontSize:20, fontWeight:700 }}>${fmtP(price)}</div>
          </div>
          {[["24h",`${mkt.change>=0?"+":""}${mkt.change}%`,mkt.change>=0?th.accent:th.red],["OI","$28.4M",th.text],["Funding","+0.0082%",th.accent],["Vol","$142M",th.text]].map(([k,v,c]) => (
            <div key={k}><div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{k}</div><div style={{ color:c, fontFamily:"'IBM Plex Mono',monospace", fontSize:11, fontWeight:600 }}>{v}</div></div>
          ))}
        </div>
        {/* timeframes */}
        <div style={{ display:"flex", gap:3 }}>
          {["1m","5m","15m","1H","4H","1D"].map(t => (
            <button key={t} onClick={()=>setTf(t)} style={{ background:tf===t?th.accent+"18":"none", border:`1px solid ${tf===t?th.accent+"22":"transparent"}`, borderRadius:5, padding:"2px 8px", color:tf===t?th.accent:th.textFaint, fontSize:10, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace" }}>{t}</button>
          ))}
          {/* keyboard hints */}
          <div style={{ marginLeft:"auto", display:"flex", gap:7 }}>
            {[["B","Long"],["S","Short"],["Esc","Close"]].map(([k,v]) => (
              <span key={k} style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>
                <span style={{ background:th.border, borderRadius:3, padding:"1px 4px", color:th.textDim, marginRight:2 }}>{k}</span>{v}
              </span>
            ))}
          </div>
        </div>
        {/* chart */}
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, flex:1, minHeight:0, padding:"7px 5px 3px", overflow:"hidden" }}>
          <CandleChart candles={candles}/>
        </div>
        {/* positions */}
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, padding:"9px 11px" }}>
          <div style={{ display:"flex", gap:3, marginBottom:7 }}>
            {["positions","orders","history"].map(t => (
              <button key={t} onClick={()=>setPtab(t)} style={{ background:ptab===t?th.accent+"18":"none", border:`1px solid ${ptab===t?th.accent+"22":"transparent"}`, borderRadius:6, padding:"3px 9px", color:ptab===t?th.accent:th.textDim, fontSize:10, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600, textTransform:"capitalize" }}>{t}</button>
            ))}
            {ptab==="positions" && <span style={{ marginLeft:"auto", color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", alignSelf:"center" }}>{pos.length} open</span>}
          </div>
          {ptab==="positions" && (pos.length===0 ? (
            <div style={{ padding:"16px 0", textAlign:"center", color:th.textFaint, fontSize:12 }}>📭 No open positions · <b style={{ color:th.textDim }}>B</b> Long · <b style={{ color:th.textDim }}>S</b> Short</div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                <thead><tr style={{ color:th.textFaint, fontFamily:"'IBM Plex Mono',monospace" }}>
                  {["Market","Side","Size","Entry","Liq","Lev","PnL",""].map(h => <th key={h} style={{ padding:"2px 6px", textAlign:"left", fontWeight:400, whiteSpace:"nowrap" }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {pos.map(p => {
                    const risk = Math.abs((price-p.liq)/price)*100 < 10;
                    return (
                      <tr key={p.id} style={{ borderTop:`1px solid ${th.border2}`, background:risk?"rgba(255,153,51,.03)":"none" }}>
                        <td style={{ padding:"6px 6px", color:th.text, fontFamily:"'IBM Plex Mono',monospace" }}>{p.market}</td>
                        <td style={{ padding:"6px 6px" }}><span style={{ background:p.side==="LONG"?th.accent+"18":th.red+"18", color:p.side==="LONG"?th.accent:th.red, borderRadius:3, padding:"1px 5px", fontSize:9, fontWeight:700 }}>{p.side}</span></td>
                        <td style={{ padding:"6px 6px", color:th.textMid, fontFamily:"'IBM Plex Mono',monospace" }}>{p.size}</td>
                        <td style={{ padding:"6px 6px", color:th.textMid, fontFamily:"'IBM Plex Mono',monospace" }}>{fmtP(p.entry)}</td>
                        <td style={{ padding:"6px 6px", color:risk?"#ff9933":th.textDim, fontFamily:"'IBM Plex Mono',monospace", fontWeight:risk?700:400 }}>{risk&&"⚠ "}{fmtP(p.liq)}</td>
                        <td style={{ padding:"6px 6px", color:th.textMid, fontFamily:"'IBM Plex Mono',monospace" }}>{p.leverage}x</td>
                        <td style={{ padding:"6px 6px", color:p.pnl>=0?th.accent:th.red, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>{p.pnl>=0?"+":"-"}${fmt(Math.abs(p.pnl))}</td>
                        <td style={{ padding:"6px 6px" }}><button onClick={()=>closePos(p.id)} style={{ background:th.red+"18", border:`1px solid ${th.red}28`, borderRadius:4, padding:"2px 7px", color:th.red, fontSize:9, cursor:"pointer" }}>Close</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {ptab==="history" && (
            <div style={{ color:th.textFaint, fontSize:11, padding:"12px 0", textAlign:"center" }}>No recent history</div>
          )}
          {ptab==="orders" && (
            <div style={{ color:th.textFaint, fontSize:11, padding:"12px 0", textAlign:"center" }}>No open orders</div>
          )}
        </div>
      </div>

      {/* ── Col 2: order panel ── */}
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, padding:"13px 12px", flex:1, overflowY:"auto" }}>
          {fill && (
            <div style={{ background:th.accent+"10", border:`1px solid ${th.accent}20`, borderRadius:8, padding:"5px 10px", marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ color:th.accent, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>↵ ${fmtP(fill.price)}</span>
              <button onClick={()=>setFill(null)} style={{ background:"none", border:"none", color:th.textFaint, cursor:"pointer", fontSize:14 }}>×</button>
            </div>
          )}
          {/* margin mode + calc */}
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
            <div style={{ display:"flex", gap:3 }}>
              {["cross","isolated"].map(m => (
                <button key={m} onClick={()=>setMM(m)} style={{ background:mm===m?th.accent+"15":"none", border:`1px solid ${mm===m?th.accent+"28":th.border}`, borderRadius:6, padding:"3px 8px", color:mm===m?th.accent:th.textFaint, fontSize:9, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace", textTransform:"capitalize" }}>{m}</button>
              ))}
            </div>
          </div>
          {mm==="isolated" && <div style={{ background:"rgba(255,153,51,.07)", border:"1px solid rgba(255,153,51,.18)", borderRadius:7, padding:"5px 9px", marginBottom:10, color:"#ff9933", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>⚠ Risk limited to position margin</div>}
          {/* long/short */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:11 }}>
            {["long","short"].map(s => (
              <button key={s} onClick={()=>setSide(s)} style={{ background:side===s?(s==="long"?"rgba(0,212,160,.12)":"rgba(255,77,109,.12)"):"none", border:`1px solid ${side===s?(s==="long"?th.accent+"40":th.red+"40"):th.border}`, borderRadius:9, padding:"8px", color:side===s?(s==="long"?th.accent:th.red):th.textDim, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif", letterSpacing:".04em" }}>{s==="long"?"▲ Long":"▼ Short"}</button>
            ))}
          </div>
          {/* order type */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, marginBottom:10 }}>
            {["market","limit"].map(t => (
              <button key={t} onClick={()=>setOT(t)} style={{ background:otype===t?th.accent+"18":"none", border:`1px solid ${otype===t?th.accent+"22":th.border}`, borderRadius:6, padding:"5px", color:otype===t?th.accent:th.textDim, fontSize:10, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600, textTransform:"capitalize" }}>{t}</button>
            ))}
          </div>
          {otype==="limit" && (
            <div style={{ marginBottom:10 }}>
              <Label t="LIMIT PRICE (USDC)"/>
              {numInput(lp, setLP, fmtP(price))}
            </div>
          )}
          {/* size */}
          <div style={{ marginBottom:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
              <Label t={`SIZE (${mkt.symbol})`}/>
              {size && <span style={{ color:th.textDim, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>${fmt(parseFloat(size||0)*price)}</span>}
            </div>
            {numInput(size, setSize, "0.00")}
            <div style={{ display:"flex", gap:3, marginTop:4 }}>
              {["25%","50%","75%","Max"].map((p,i) => (
                <button key={p} onClick={()=>setSize(((i+1)*.025).toFixed(4))} style={{ flex:1, background:"none", border:`1px solid ${th.border}`, borderRadius:5, padding:"3px", color:th.textDim, fontSize:9, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace" }}>{p}</button>
              ))}
            </div>
          </div>
          {/* leverage */}
          <div style={{ marginBottom:10 }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
              <Label t="LEVERAGE"/>
              <span style={{ color:th.accent, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>{lev}×</span>
            </div>
            <input type="range" min="1" max="50" value={lev} onChange={e=>setLev(+e.target.value)} style={{ width:"100%", accentColor:th.accent }}/>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:2 }}>
              {[1,5,10,25,50].map(v => (
                <button key={v} onClick={()=>setLev(v)} style={{ background:lev===v?th.accent+"18":"none", border:`1px solid ${lev===v?th.accent+"28":th.border}`, borderRadius:4, padding:"2px 5px", color:lev===v?th.accent:th.textFaint, fontSize:8, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace" }}>{v}×</button>
              ))}
            </div>
          </div>
          {/* tp/sl */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:10 }}>
            {[["TP",tp,setTp,th.accent],["SL",sl,setSl,th.red]].map(([label,val,set,col]) => (
              <div key={label}>
                <label style={{ color:col+"80", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{label} (USDC)</label>
                <input type="number" value={val} onChange={e=>set(e.target.value)} placeholder="—" style={{ width:"100%", background:th.input, border:`1px solid ${val?col+"40":th.border}`, borderRadius:7, padding:"6px 8px", color:val?col:th.textDim, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", outline:"none", marginTop:2, boxSizing:"border-box" }}/>
              </div>
            ))}
          </div>
          {/* summary */}
          {size && (
            <div style={{ background:th.bg3, border:`1px solid ${th.border}`, borderRadius:9, padding:"9px 10px", marginBottom:11 }}>
              {[["Liq. Price",liqP?`$${fmtP(liqP)}`:"—","#ff9933"],["Margin",margin?`$${fmt(margin)}`:"—",th.textMid],["Fee",notional?`$${fmt(notional*.0006,4)}`:"—",th.textDim]].map(([k,v,c]) => (
                <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <span style={{ color:th.textFaint, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>{k}</span>
                  <span style={{ color:c, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>{v}</span>
                </div>
              ))}
            </div>
          )}
          <button onClick={handleOrder} style={{ width:"100%", background:`linear-gradient(135deg,${side==="long"?`${th.accent},#00a878`:"#ff3a3a,#cc2200"})`, border:"none", borderRadius:10, padding:"12px", color:"#000", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif", letterSpacing:".04em" }}>
            {!wallet.connected ? "Connect Wallet" : wallet.real ? (side==="long"?"▲ Open Long":"▼ Open Short") : "▲ Demo Mode — Connect OP_WALLET"}
          </button>
        </div>
        {/* account */}
        {wallet.real && (wallet.balance||0) === 0 && (
          <div style={{ background:"#ff980010", border:"1px solid #ff980030", borderRadius:9, padding:"8px 12px", marginBottom:8 }}>
            <div style={{ color:"#ff9800", fontSize:10, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>⚠ No tBTC — get from faucet</div>
            <a href="https://faucet.opnet.org" target="_blank" rel="noreferrer" style={{ color:"#ff9800", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>faucet.opnet.org →</a>
          </div>
        )}
        {wallet.real && wallet.network && !(wallet.network||"").includes("testnet") && wallet.network !== "unknown" && wallet.network !== "demo" && (
          <div style={{ background:"#ff3a3a10", border:"1px solid #ff3a3a30", borderRadius:9, padding:"8px 12px", marginBottom:8 }}>
            <div style={{ color:"#ff3a3a", fontSize:10, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700 }}>⚠ Wrong network: {wallet.network}</div>
            <div style={{ color:"#ff3a3a", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>Switch OP_WALLET to Bitcoin Testnet 3</div>
          </div>
        )}
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, padding:"11px 12px" }}>
          <div style={{ color:th.textMid, fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:600, marginBottom:7 }}>
            Account {wallet.real && <span style={{ color:th.accent, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>⬡ LIVE</span>}
          </div>
          <div style={{ height:3, background:th.border, borderRadius:2, marginBottom:7 }}>
            <div style={{ width:`${used}%`, height:"100%", background:`linear-gradient(90deg,${th.accent},${used>70?th.red:"#c45e00"})`, borderRadius:2, transition:"width .3s" }}/>
          </div>
          {[
            ["tBTC Balance", wallet.real ? `${(wallet.balance||0).toFixed(6)} tBTC` : "$10,979.85", th.text],
            ["Margin Used", `${used.toFixed(1)}%`, used>70?th.red:th.textMid],
            ["Total PnL", "+$979.85", th.accent]
          ].map(([k,v,c]) => (
            <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
              <span style={{ color:th.textFaint, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>{k}</span>
              <span style={{ color:c, fontSize:10, fontFamily:"'IBM Plex Mono',monospace" }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Col 3: order book ── */}
      <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:11, overflow:"hidden", display:"flex", flexDirection:"column" }}>
        <div style={{ padding:"8px 10px", borderBottom:`1px solid ${th.border}`, color:th.text, fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:700, flexShrink:0 }}>
          Order Book · {mkt.symbol}/USDC
        </div>
        <div style={{ flex:1, overflow:"hidden" }}>
          <OrderBook mid={price} onFill={onFill} th={th}/>
        </div>
      </div>

      {preview && <SimPreview order={preview} livePrice={price} onConfirm={confirmOrder} onCancel={()=>setPv(null)} th={th}/>}
      <TxOverlay tx={tx} onDismiss={()=>setTx(null)} th={th}/>
    </div>
  </div>
  );
}
// ─── SWAP ────────────────────────────────────────────────
function Swap({ wallet, onConnect, th }) {
  const toast = useToast();
  const [from, setFrom] = useState(TOKENS[1]);
  const [to, setTo]     = useState(TOKENS[3]);
  const [amt, setAmt]   = useState("");
  const [busy, setBusy] = useState(false);
  const rate = to.price / from.price;
  const out  = amt ? (parseFloat(amt)*rate*.997).toFixed(6) : "";
  const swap = async () => {
    if (!wallet.connected) { onConnect(); return; }
    if (!amt || parseFloat(amt)<=0) { toast("Enter amount","warning"); return; }
    setBusy(true);
    await new Promise(r => setTimeout(r, 1100));
    setBusy(false);
    toast(`Swapped ${amt} ${from.symbol} → ${parseFloat(out).toFixed(4)} ${to.symbol}`, "success");
    setAmt("");
  };
  const Tok = ({ t }) => (
    <div style={{ background:t.color+"18", border:`1px solid ${t.color}28`, borderRadius:8, padding:"5px 10px", display:"flex", alignItems:"center", gap:7 }}>
      <span style={{ color:t.color, fontWeight:700, fontSize:12, fontFamily:"'IBM Plex Mono',monospace" }}>{t.symbol}</span>
    </div>
  );
  return (
    <div style={{ maxWidth:440, margin:"36px auto", padding:"0 18px" }}>
      <h2 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, marginBottom:22 }}>Swap</h2>
      <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:18, padding:"20px" }}>
        <div style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:12, padding:"14px", marginBottom:5 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:9 }}>
            <Tok t={from}/>
            <span style={{ color:th.textDim, fontSize:11 }}>Balance: 1.24</span>
          </div>
          <input type="number" value={amt} onChange={e=>setAmt(e.target.value)} placeholder="0.00" style={{ width:"100%", background:"none", border:"none", color:th.text, fontSize:26, fontFamily:"'IBM Plex Mono',monospace", outline:"none", boxSizing:"border-box" }}/>
          {amt && <div style={{ color:th.textDim, fontSize:11, marginTop:3, fontFamily:"'IBM Plex Mono',monospace" }}>≈ ${fmt(parseFloat(amt)*from.price)}</div>}
        </div>
        <div style={{ display:"flex", justifyContent:"center", margin:"5px 0" }}>
          <button onClick={() => { const t=from; setFrom(to); setTo(t); }} style={{ width:34, height:34, borderRadius:"50%", background:th.accent+"18", border:`1px solid ${th.accent}28`, cursor:"pointer", fontSize:16, color:th.accent, display:"flex", alignItems:"center", justifyContent:"center" }}>⇅</button>
        </div>
        <div style={{ background:th.bg2, border:`1px solid ${th.border}`, borderRadius:12, padding:"14px", marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:9 }}>
            <Tok t={to}/>
            <span style={{ color:th.textDim, fontSize:11 }}>Balance: 0.00</span>
          </div>
          <div style={{ color:out?th.text:th.textFaint, fontSize:26, fontFamily:"'IBM Plex Mono',monospace" }}>{out||"0.00"}</div>
        </div>
        {amt && (
          <div style={{ background:th.bg3, border:`1px solid ${th.border}`, borderRadius:10, padding:"10px", marginBottom:14 }}>
            {[["Rate",`1 ${from.symbol} = ${rate.toFixed(4)} ${to.symbol}`,th.textMid],["Fee","0.3% LP + 0.06% protocol",th.textDim],["Min received",`${(parseFloat(out||0)*.99).toFixed(4)} ${to.symbol}`,th.textMid]].map(([k,v,c]) => (
              <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ color:th.textFaint, fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>{k}</span>
                <span style={{ color:c, fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <button onClick={swap} disabled={busy} style={{ width:"100%", background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:12, padding:"13px", color:"#000", fontSize:14, fontWeight:700, cursor:busy?"wait":"pointer", fontFamily:"'Syne',sans-serif", opacity:busy?.8:1 }}>
          {busy ? <span style={{ display:"inline-block", animation:"spin 1s linear infinite" }}>⟳</span> : (wallet.connected ? "Swap →" : "Connect Wallet")}
        </button>
      </div>
    </div>
  );
}

// ─── POOLS ────────────────────────────────────────────────
function Pools({ wallet, onConnect, th }) {
  const toast = useToast();
  return (
    <div style={{ padding:"26px 18px", maxWidth:900, margin:"0 auto" }}>
      <h2 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, marginBottom:5 }}>Liquidity Pools</h2>
      <p style={{ color:th.textDim, fontSize:12, marginBottom:22 }}>Earn fees from every trade on OP_NET.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {POOLS.map(pool => (
          <div key={pool.pair} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, padding:"15px 18px", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
            <div>
              <div style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:14, fontWeight:700 }}>{pool.pair}</div>
              <div style={{ color:th.textDim, fontSize:11, marginTop:2 }}>0.05% fee tier</div>
            </div>
            {[["TVL",`$${pool.tvl}M`,th.text],["24h Vol",`$${pool.vol}M`,th.textMid],["APY",`${pool.apy}%`,"#F7931A"]].map(([k,v,c]) => (
              <div key={k} style={{ textAlign:"center" }}>
                <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:3 }}>{k}</div>
                <div style={{ color:c, fontFamily:"'IBM Plex Mono',monospace", fontSize:14, fontWeight:700 }}>{v}</div>
              </div>
            ))}
            <button onClick={() => { if(!wallet.connected){onConnect();return;} toast(`Adding to ${pool.pair}…`,"info"); }} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:9, padding:"9px 20px", color:"#000", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Add Liquidity</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LEADERBOARD ──────────────────────────────────────────
function Leaderboard({ wallet, th, setPage }) {
  const toast = useToast();
  const [period, setPeriod] = useState("7D");
  const [copying, setCopying] = useState([]);
  const podCol = ["#FFD700","#C0C0C0","#CD7F32"];
  return (
    <div style={{ padding:"26px 18px", maxWidth:1000, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:22, flexWrap:"wrap", gap:12 }}>
        <div>
          <h2 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, marginBottom:4 }}>🏆 Leaderboard</h2>
          <p style={{ color:th.textDim, fontSize:12 }}>Top traders by profitability.</p>
        </div>
        <div style={{ display:"flex", gap:5 }}>
          {["24H","7D","30D","All"].map(p => (
            <button key={p} onClick={()=>setPeriod(p)} style={{ background:period===p?th.accent+"18":"none", border:`1px solid ${period===p?th.accent+"28":th.border}`, borderRadius:7, padding:"4px 11px", color:period===p?th.accent:th.textDim, fontSize:10, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace" }}>{p}</button>
          ))}
        </div>
      </div>
      {/* podium */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:20 }}>
        {LEADERS.slice(0,3).map((t,i) => (
          <div key={t.addr} style={{ background:`linear-gradient(135deg,${podCol[i]}08,transparent)`, border:`1px solid ${podCol[i]}22`, borderRadius:14, padding:"18px", textAlign:"center", order:[1,0,2][i] }}>
            <div style={{ fontSize:28, marginBottom:6 }}>{t.badge}</div>
            <div style={{ color:podCol[i], fontFamily:"'IBM Plex Mono',monospace", fontSize:10, marginBottom:4 }}>{t.addr}</div>
            <div style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:18, fontWeight:700 }}>+${(t.pnl/1000).toFixed(1)}K</div>
            <div style={{ color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", marginBottom:10 }}>+{t.roi}%</div>
            <button onClick={()=>setPage("copy")} style={{ background:th.accent+"18", border:`1px solid ${th.accent}28`, borderRadius:7, padding:"5px 14px", color:th.accent, fontSize:10, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>⇄ Copy</button>
          </div>
        ))}
      </div>
      {/* table */}
      <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"44px 1.6fr 1.2fr 1fr 1fr 100px", padding:"9px 14px", borderBottom:`1px solid ${th.border}` }}>
          {["#","Trader","PnL","ROI","Win%",""].map(h => <div key={h} style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{h}</div>)}
        </div>
        {LEADERS.map((t,i) => {
          const isMe = wallet.connected && i===7;
          const isCopy = copying.includes(t.addr);
          return (
            <div key={t.addr} style={{ display:"grid", gridTemplateColumns:"44px 1.6fr 1.2fr 1fr 1fr 100px", padding:"10px 14px", borderBottom:i<LEADERS.length-1?`1px solid ${th.border2}`:"none", background:isMe?th.accent+"05":"none", alignItems:"center" }}>
              <span style={{ color:i<3?podCol[i]:th.textDim, fontSize:12, fontFamily:"'IBM Plex Mono',monospace", fontWeight:i<3?700:400 }}>#{t.rank}</span>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <div style={{ width:24, height:24, borderRadius:"50%", background:`hsl(${parseInt(t.addr.slice(2,6),16)%360},38%,18%)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:th.textDim, flexShrink:0 }}>◉</div>
                <span style={{ color:th.text, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{t.addr}</span>
                {isMe && <span style={{ background:th.accent+"18", color:th.accent, fontSize:8, padding:"1px 5px", borderRadius:3, fontFamily:"'IBM Plex Mono',monospace" }}>YOU</span>}
              </div>
              <span style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:12, fontWeight:700 }}>+${(t.pnl/1000).toFixed(1)}K</span>
              <span style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>+{t.roi}%</span>
              <span style={{ color:th.textMid, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{t.winRate}%</span>
              {!isMe && (
                <button onClick={()=>{ setCopying(c=>isCopy?c.filter(a=>a!==t.addr):[...c,t.addr]); toast(isCopy?`Unfollowed`:`Copying ${t.addr}`,isCopy?"info":"success"); }} style={{ background:isCopy?th.accent+"18":"none", border:`1px solid ${isCopy?th.accent+"30":th.border}`, borderRadius:6, padding:"4px 8px", color:isCopy?th.accent:th.textDim, fontSize:9, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>{isCopy?"✓ Copying":"⇄ Copy"}</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── COPY TRADING ─────────────────────────────────────────
function Copy({ wallet, onConnect, th }) {
  const toast = useToast();
  const [tab, setTab]     = useState("following");
  const [followed, setFol] = useState(LEADERS.slice(0,2).map(t => ({ ...t, allocation:250, copyPnl:t.rank===1?+1420.50:+488.20, winRate:t.winRate, drawdown:t.rank===1?8.4:11.2 })));
  const discover = LEADERS.filter(l => !followed.find(f=>f.addr===l.addr));

  if (!wallet.connected) return (
    <div style={{ minHeight:"60vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, padding:"20px" }}>
      <div style={{ fontSize:40 }}>⇄</div>
      <div style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700 }}>Copy Trading</div>
      <div style={{ color:th.textDim, fontSize:12, textAlign:"center", maxWidth:300 }}>Mirror top traders automatically. Connect to get started.</div>
      <button onClick={onConnect} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:11, padding:"11px 24px", color:"#000", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Connect Wallet</button>
    </div>
  );

  return (
    <div style={{ padding:"26px 18px", maxWidth:900, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22, flexWrap:"wrap", gap:12 }}>
        <div>
          <h2 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, marginBottom:4 }}>⇄ Copy Trading</h2>
          <p style={{ color:th.textDim, fontSize:12 }}>Mirror top traders automatically.</p>
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {["following","discover"].map(t => (
            <button key={t} onClick={()=>setTab(t)} style={{ background:tab===t?th.accent+"18":"none", border:`1px solid ${tab===t?th.accent+"28":th.border}`, borderRadius:8, padding:"6px 13px", color:tab===t?th.accent:th.textDim, fontSize:11, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600, textTransform:"capitalize" }}>{t}</button>
          ))}
        </div>
      </div>
      {/* stats */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:11, marginBottom:22 }}>
        {[["Copying",followed.length,th.accent],["Allocated","$"+followed.reduce((a,t)=>a+t.allocation,0).toLocaleString(),th.text],["Copy PnL","+$"+fmt(followed.reduce((a,t)=>a+t.copyPnl,0)),th.accent],["Avg Win%",(followed.reduce((a,t)=>a+t.winRate,0)/Math.max(followed.length,1)).toFixed(1)+"%",th.text]].map(([k,v,c]) => (
          <div key={k} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:13, padding:"13px 15px" }}>
            <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:4 }}>{k}</div>
            <div style={{ color:c, fontFamily:"'IBM Plex Mono',monospace", fontSize:17, fontWeight:700 }}>{v}</div>
          </div>
        ))}
      </div>
      {tab==="following" && (followed.length===0 ? (
        <div style={{ textAlign:"center", padding:"40px 20px", color:th.textFaint, fontSize:13 }}>Not copying anyone · <button onClick={()=>setTab("discover")} style={{ background:"none", border:"none", color:th.accent, cursor:"pointer", fontFamily:"'Syne',sans-serif", fontWeight:600 }}>Discover traders →</button></div>
      ) : followed.map(t => (
        <div key={t.addr} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, padding:"15px 17px", marginBottom:10 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
            <div style={{ display:"flex", alignItems:"center", gap:11 }}>
              <div style={{ width:38, height:38, borderRadius:"50%", background:`hsl(${parseInt(t.addr.slice(2,6),16)%360},38%,18%)`, border:`2px solid ${th.accent}35`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, color:th.accent }}>◉</div>
              <div>
                <div style={{ color:th.text, fontFamily:"'IBM Plex Mono',monospace", fontSize:12, fontWeight:700 }}>{t.addr}</div>
                <div style={{ color:th.textDim, fontSize:10, marginTop:2 }}>Allocation: ${t.allocation}</div>
              </div>
            </div>
            <div style={{ display:"flex", gap:10, alignItems:"center" }}>
              <div style={{ textAlign:"right" }}>
                <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>COPY PnL</div>
                <div style={{ color:t.copyPnl>=0?th.accent:th.red, fontFamily:"'IBM Plex Mono',monospace", fontSize:14, fontWeight:700 }}>{t.copyPnl>=0?"+":""}${fmt(t.copyPnl)}</div>
              </div>
              <button onClick={()=>{ setFol(f=>f.filter(x=>x.addr!==t.addr)); toast("Stopped copying","info"); }} style={{ background:th.red+"18", border:`1px solid ${th.red}28`, borderRadius:7, padding:"5px 12px", color:th.red, fontSize:10, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Stop</button>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginTop:11, paddingTop:11, borderTop:`1px solid ${th.border}` }}>
            {[["ROI",`+${t.roi}%`,th.accent],["Win%",`${t.winRate}%`,th.text],["Max DD",`${t.drawdown||"—"}%`,"#ff9933"]].map(([k,v,c]) => (
              <div key={k}><div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:2 }}>{k}</div><div style={{ color:c, fontFamily:"'IBM Plex Mono',monospace", fontSize:12, fontWeight:700 }}>{v}</div></div>
            ))}
          </div>
        </div>
      )))}
      {tab==="discover" && discover.map(t => (
        <div key={t.addr} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, padding:"15px 17px", marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:11 }}>
            <div style={{ width:38, height:38, borderRadius:"50%", background:`hsl(${parseInt(t.addr.slice(2,6),16)%360},38%,18%)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, color:th.textDim }}>◉</div>
            <div>
              <div style={{ color:th.text, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}>{t.addr}</div>
              <div style={{ color:th.textDim, fontSize:10, marginTop:2 }}>+{t.roi}% ROI · {t.winRate}% win rate</div>
            </div>
          </div>
          <button onClick={()=>{ setFol(f=>[...f,{...t,allocation:100,copyPnl:0,drawdown:9}]); toast(`Copying ${t.addr}`,"success"); setTab("following"); }} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:9, padding:"8px 18px", color:"#000", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Follow</button>
        </div>
      ))}
    </div>
  );
}

// ─── REFERRAL ─────────────────────────────────────────────
function Referral({ wallet, onConnect, th }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const d = REFERRAL;

  if (!wallet.connected) return (
    <div style={{ minHeight:"60vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, padding:"20px" }}>
      <div style={{ fontSize:40 }}>🎁</div>
      <div style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:700 }}>Referral & Rewards</div>
      <button onClick={onConnect} style={{ background:`linear-gradient(135deg,${th.accent},#c45e00)`, border:"none", borderRadius:11, padding:"11px 24px", color:"#000", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Connect Wallet</button>
    </div>
  );

  const tier = d.tiers[d.tier-1];
  const next = d.tiers[d.tier];

  return (
    <div style={{ padding:"26px 18px", maxWidth:900, margin:"0 auto" }}>
      <h2 style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:700, marginBottom:4 }}>🎁 Referral & Rewards</h2>
      <p style={{ color:th.textDim, fontSize:12, marginBottom:20 }}>Earn fee rebates for every trader you refer.</p>
      {/* link */}
      <div style={{ background:th.card, border:`1px solid ${th.accent}28`, borderRadius:14, padding:"17px 18px", marginBottom:16 }}>
        <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:7 }}>YOUR REFERRAL LINK</div>
        <div style={{ display:"flex", gap:9, alignItems:"center" }}>
          <div style={{ flex:1, background:th.input, border:`1px solid ${th.border}`, borderRadius:8, padding:"9px 12px", color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}>opperpdex.xyz/r/{d.code}</div>
          <button onClick={()=>{ setCopied(true); toast("Link copied!","success",2000); setTimeout(()=>setCopied(false),2000); }} style={{ background:copied?th.accent+"20":th.accent, border:"none", borderRadius:9, padding:"9px 18px", color:copied?"#F7931A":"#000", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif", whiteSpace:"nowrap" }}>{copied?"✓ Copied!":"Copy Link"}</button>
        </div>
      </div>
      {/* kpis */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:11, marginBottom:20 }}>
        {[["Total Earned","$"+fmt(d.earned),th.accent],["Pending","$"+fmt(d.pending),"#FF9933"],["Referred",d.count,th.text],["Tier",tier.label,tier.color]].map(([k,v,c]) => (
          <div key={k} style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:13, padding:"13px 15px" }}>
            <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:4 }}>{k}</div>
            <div style={{ color:c, fontFamily:"'IBM Plex Mono',monospace", fontSize:19, fontWeight:700 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 270px", gap:13, marginBottom:20 }}>
        {/* tiers */}
        <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, padding:"17px" }}>
          <div style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700, marginBottom:13 }}>Tier Progress</div>
          {d.tiers.map(t => {
            const active = t.n===d.tier, done = t.n<d.tier;
            return (
              <div key={t.n} style={{ display:"flex", alignItems:"center", gap:11, marginBottom:12 }}>
                <div style={{ width:28, height:28, borderRadius:"50%", background:done||active?t.color+"18":th.bg2, border:`2px solid ${done||active?t.color:th.border}`, display:"flex", alignItems:"center", justifyContent:"center", color:done||active?t.color:th.textFaint, fontSize:10, fontWeight:700, flexShrink:0 }}>{done?"✓":t.n}</div>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", justifyContent:"space-between" }}>
                    <span style={{ color:active?th.text:done?th.textMid:th.textFaint, fontSize:12, fontFamily:"'Syne',sans-serif", fontWeight:active?700:400 }}>{t.label}</span>
                    <span style={{ color:t.color, fontSize:11, fontFamily:"'IBM Plex Mono',monospace" }}>{t.rebate}</span>
                  </div>
                  {active && next && (<>
                    <div style={{ height:3, background:th.border, borderRadius:2, marginTop:5 }}><div style={{ width:`${d.progress}%`, height:"100%", background:t.color, borderRadius:2 }}/></div>
                    <div style={{ color:th.textFaint, fontSize:9, marginTop:2, fontFamily:"'IBM Plex Mono',monospace" }}>{d.count}/{next.need} refs to {next.label}</div>
                  </>)}
                </div>
              </div>
            );
          })}
        </div>
        {/* claim */}
        <div style={{ background:"rgba(255,153,51,.06)", border:"1px solid rgba(255,153,51,.22)", borderRadius:14, padding:"17px", display:"flex", flexDirection:"column" }}>
          <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", marginBottom:5 }}>PENDING REWARDS</div>
          <div style={{ color:"#FF9933", fontFamily:"'IBM Plex Mono',monospace", fontSize:28, fontWeight:700, marginBottom:3 }}>${fmt(d.pending)}</div>
          <div style={{ color:th.textDim, fontSize:11, marginBottom:"auto", paddingBottom:16 }}>{tier.rebate} rebate · {d.count} referrals</div>
          <button onClick={()=>toast(`Claimed $${fmt(d.pending)} USDC`,"success")} style={{ width:"100%", background:"linear-gradient(135deg,#FF9933,#FF6600)", border:"none", borderRadius:11, padding:"12px", color:"#000", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'Syne',sans-serif" }}>Claim ${fmt(d.pending)} →</button>
        </div>
      </div>
      {/* table */}
      <div style={{ background:th.card, border:`1px solid ${th.border}`, borderRadius:14, overflow:"hidden" }}>
        <div style={{ padding:"11px 17px", borderBottom:`1px solid ${th.border}`, color:th.text, fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:700 }}>Referred Traders</div>
        <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 60px", padding:"6px 17px", borderBottom:`1px solid ${th.border}` }}>
          {["Trader","Volume","Reward","Status"].map(h => <span key={h} style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{h}</span>)}
        </div>
        {d.referred.map((r,i) => (
          <div key={r.addr} style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr 1fr 60px", padding:"10px 17px", borderBottom:i<d.referred.length-1?`1px solid ${th.border2}`:"none", alignItems:"center" }}>
            <span style={{ color:th.text, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{r.addr}</span>
            <span style={{ color:th.textMid, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{r.vol}</span>
            <span style={{ color:th.accent, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{r.earned}</span>
            <span style={{ background:r.active?th.accent+"18":"rgba(255,255,255,.05)", color:r.active?th.accent:th.textFaint, borderRadius:4, padding:"2px 7px", fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>{r.active?"Active":"Inactive"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MOBILE NAV ───────────────────────────────────────────
function MobileNav({ page, setPage, th }) {
  const items = [["trade","Trade","⇅"],["swap","Swap","⇄"],["liquidity","Pools","◈"],["leaderboard","Rank","🏆"],["copy","Copy","⇒"]];
  return (
    <div style={{ position:"fixed", bottom:0, left:0, right:0, background:th.navBg, borderTop:`1px solid ${th.border}`, display:"flex", justifyContent:"space-around", padding:"8px 0", zIndex:350 }}>
      {items.map(([id,l,i]) => (
        <button key={id} onClick={()=>setPage(id)} style={{ background:"none", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
          <span style={{ fontSize:16, color:page===id?th.accent:th.textDim }}>{i}</span>
          <span style={{ fontSize:9, color:page===id?th.accent:th.textDim, fontFamily:"'Syne',sans-serif" }}>{l}</span>
        </button>
      ))}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────
function AppInner() {
  const th = useTheme();
  const [page, setPage]       = useState("landing");
  const [wallet, setWallet]   = useState({ connected:false, address:"", name:"", pubkey:"", balance:0, network:"", real:false });
  const [modal, setModal]     = useState(false);
  const [prices, setPrices]   = useState(() => Object.fromEntries(TOKENS.map(t=>[t.symbol,t.price])));

  useEffect(() => {
    const iv = setInterval(() => {
      setPrices(prev => {
        const u = {};
        TOKENS.forEach(t => { const p=prev[t.symbol]; u[t.symbol]=+(p+(Math.random()-.49)*p*.001).toFixed(p>100?2:4); });
        return u;
      });
    }, 2400);
    return () => clearInterval(iv);
  }, []);

  const connect    = info => { if (info) setWallet({ connected:true,...info }); else setModal(true); };
  const disconnect = ()   => setWallet({ connected:false, address:"", name:"", pubkey:"", balance:0, network:"", real:false });

  // Auto-detect if OP_WALLET already connected
  useEffect(() => {
    const autoConnect = async () => {
      try {
        // Wait for extensions to inject (they load async — up to 1.5s)
        await new Promise(r => setTimeout(r, 800));
        const wallets = detectWallets();
        const key = ["OP_WALLET","UniSat","OKX","Xverse"].find(k => wallets[k]);
        if (!key) return;
        const prov = wallets[key];
        // Use getAccounts (silent, non-prompting) not requestAccounts (shows popup)
        const accounts = await prov.getAccounts();
        if (accounts && accounts.length > 0) {
          let balance = 0, pubkey = "", network = "testnet";
          try { const b = await prov.getBalance(); balance = (b.confirmed||b.total||0)/1e8; } catch {}
          try { pubkey = await prov.getPublicKey(); } catch {}
          try { network = await prov.getNetwork(); } catch {}
          setWallet({ connected:true, address:accounts[0], name:key, pubkey, balance, network, real:true });
        }
      } catch {}
    };
    autoConnect();
  }, []);

  return (
    <div style={{ minHeight:"100vh", background:th.bg, color:th.text, transition:"background .3s,color .3s" }}>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>

      <Nav page={page} setPage={setPage} wallet={wallet} onConnect={()=>setModal(true)} onDisconnect={disconnect} th={th}/>
      {page!=="landing" && <Ticker prices={prices} th={th}/>}

      <main style={{ paddingTop:page!=="landing"?92:60, paddingBottom:64 }}>
        {page==="landing"     && <Landing setPage={setPage} th={th}/>}
        {page==="trade"       && <Trade wallet={wallet} onConnect={()=>setModal(true)} th={th} setPage={setPage}/>}
        {page==="swap"        && <Swap wallet={wallet} onConnect={()=>setModal(true)} th={th}/>}
        {page==="liquidity"   && <Pools wallet={wallet} onConnect={()=>setModal(true)} th={th}/>}
        {page==="leaderboard" && <Leaderboard wallet={wallet} th={th} setPage={setPage}/>}
        {page==="copy"        && <Copy wallet={wallet} onConnect={()=>setModal(true)} th={th}/>}
        {page==="referral"    && <Referral wallet={wallet} onConnect={()=>setModal(true)} th={th}/>}
      </main>

      <MobileNav page={page} setPage={setPage} th={th}/>

      {/* ── Footer ── */}
      <footer style={{ borderTop:`2px solid ${th.accent}20`, padding:"28px 16px 80px", background:th.bg2 }}>
        <div style={{ maxWidth:960, margin:"0 auto" }}>
          {/* Top row: brand + social */}
          <div style={{ display:"flex", flexWrap:"wrap", gap:20, alignItems:"flex-start", justifyContent:"space-between", marginBottom:24 }}>
            {/* Brand */}
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                <div style={{ width:32, height:32, background:`linear-gradient(135deg,${th.accent},#c45e00)`, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", color:"#000", fontWeight:900, fontSize:16, fontFamily:"'Syne',sans-serif" }}>₿</div>
                <span style={{ color:th.text, fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800 }}>OP<span style={{ color:th.accent }}>Perp</span>DEX</span>
              </div>
              <div style={{ color:th.textDim, fontSize:10, fontFamily:"'IBM Plex Mono',monospace", lineHeight:1.7 }}>
                The first perpetual futures DEX<br/>on OPNet Bitcoin L2 · Testnet
              </div>
            </div>

            {/* Social links */}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700, letterSpacing:2, marginBottom:4 }}>COMMUNITY</div>
              {[
                { label:"Twitter / X",   href:"https://x.com/opnetbtc",             icon:"𝕏" },
                { label:"Telegram",       href:"https://t.me/opnetbtc",              icon:"✈" },
                { label:"Discord",        href:"https://discord.com/invite/opnet",   icon:"⬡" },
              ].map(s => (
                <a key={s.label} href={s.href} target="_blank" rel="noreferrer"
                  style={{ display:"flex", alignItems:"center", gap:8, color:th.textMid, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", textDecoration:"none", padding:"5px 10px", borderRadius:7, border:`1px solid ${th.border}`, background:th.bg3, transition:"all .15s" }}
                  onMouseEnter={e=>{ e.currentTarget.style.borderColor=th.accent+"50"; e.currentTarget.style.color=th.accent; }}
                  onMouseLeave={e=>{ e.currentTarget.style.borderColor=th.border; e.currentTarget.style.color=th.textMid; }}>
                  <span style={{ fontSize:13 }}>{s.icon}</span> {s.label}
                </a>
              ))}
            </div>

            {/* Resources */}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <div style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700, letterSpacing:2, marginBottom:4 }}>RESOURCES</div>
              {[
                { label:"tBTC Faucet",    href:"https://faucet.opnet.org",           icon:"💧" },
                { label:"OP_WALLET",      href:"https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb", icon:"₿" },
                { label:"OPNet Explorer", href:"https://opscan.org",                 icon:"🔍" },
                { label:"opnet.org",      href:"https://opnet.org",                  icon:"🌐" },
              ].map(s => (
                <a key={s.label} href={s.href} target="_blank" rel="noreferrer"
                  style={{ display:"flex", alignItems:"center", gap:8, color:th.textMid, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", textDecoration:"none", padding:"5px 10px", borderRadius:7, border:`1px solid ${th.border}`, background:th.bg3, transition:"all .15s" }}
                  onMouseEnter={e=>{ e.currentTarget.style.borderColor=th.accent+"50"; e.currentTarget.style.color=th.accent; }}
                  onMouseLeave={e=>{ e.currentTarget.style.borderColor=th.border; e.currentTarget.style.color=th.textMid; }}>
                  <span style={{ fontSize:13 }}>{s.icon}</span> {s.label}
                </a>
              ))}
            </div>
          </div>

          {/* Bottom bar */}
          <div style={{ borderTop:`1px solid ${th.border}`, paddingTop:14, display:"flex", flexWrap:"wrap", gap:10, justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace" }}>
              © 2025 OPPerpDEX · Built on OPNet · Testnet only — no real funds
            </span>
            <div style={{ display:"flex", gap:12 }}>
              {["Terms","Privacy","Docs"].map(l => (
                <span key={l} style={{ color:th.textFaint, fontSize:9, fontFamily:"'IBM Plex Mono',monospace", cursor:"default" }}>{l}</span>
              ))}
            </div>
          </div>
        </div>
      </footer>

      {modal && <WalletModal onClose={()=>setModal(false)} onConnect={info=>{ connect(info); setModal(false); }} th={th}/>}

      <style>{`
        @keyframes ticker  { from{transform:translateX(0)} to{transform:translateX(-50%)} }
        @keyframes fadeUp  { from{transform:translateY(8px);opacity:0} to{transform:none;opacity:1} }
        @keyframes spin    { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        * { box-sizing:border-box; margin:0; padding:0 }
        body { overflow-x:hidden }
        input[type=number] { -moz-appearance:textfield }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none }
        ::-webkit-scrollbar { width:3px; height:3px }
        ::-webkit-scrollbar-track { background:${th.bg} }
        ::-webkit-scrollbar-thumb { background:${th.border}; border-radius:2px }
        input[type=range] { height:3px; cursor:pointer }
        select { outline:none }
      `}</style>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppInner/>
      </ToastProvider>
    </ThemeProvider>
  );
}
