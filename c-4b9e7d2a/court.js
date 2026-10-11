// throne. court data. One loader shared by the home, ledger and app pages.
// Sources (all public, all realized):
//   desk fees / volume / traders  -> the venue's builder daily statistics (USDC)
//   pons fees                     -> data/pons.json on the throne-venue relay (ETH credited to THRONE's creator
//                                    fee recipient in the Pons fee escrow, per UTC day) + a live claimable read
//   ETH/USD                       -> coingecko daily closes, fallback Chainlink ETH/USD on Robinhood Chain (live only)
// Nothing here estimates. A source that fails reports itself as unreachable and contributes 0 to no total.
window.courtData = (function () {
  const RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const RELAY = 'https://raw.githubusercontent.com/ushouldcashout/throne-venue/main/data/';
  const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
  const RECIPIENT = '0xe8e60885b967aafd7f99f1f45e535481d53ee14c';
  const CL_ETH = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
  const LAUNCH = '2026-09-13'; // $THRONE launch on pons; first ledger day
  const POL_SHARE = 0.90; // the Court's share of the THRONE/USDG pool's liquidity (protocol-owned); fees to LPs × this = Court income

  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  };

  async function desk() {
    const r = await fetch('https://api.orderly.org/md/volume/builder/daily_stats?broker_id=throne', { cache: 'no-store' });
    const raw = await r.json();
    return raw.map(x => ({ d: String(x.date).slice(0, 10), fee: +x.builderFee || 0, vol: (+x.takerVolume || 0) + (+x.makerVolume || 0), users: +x.activeUser || 0 }))
      .filter(x => x.d >= LAUNCH).sort((a, b) => a.d < b.d ? -1 : 1);
  }
  async function pons() {
    const j = await (await fetch(RELAY + 'pons.json', { cache: 'no-store' })).json();
    let claimable = null;
    try { claimable = Number(BigInt(await rpc('eth_call', [{ to: ESCROW, data: '0x70a08231' + RECIPIENT.slice(2).padStart(64, '0') }, 'latest']))) / 1e18; } catch (e) {}
    return { days: Object.fromEntries(Object.entries(j.days || {}).map(([d, w]) => [d, Number(BigInt(w)) / 1e18])), credited: Number(BigInt(j.creditedWei)) / 1e18, claimed: Number(BigInt(j.claimedWei)) / 1e18, claimable, updated: j.updated, lastBlock: j.lastBlock };
  }
  async function fables() {
    const j = await (await fetch(RELAY + 'fables.json', { cache: 'no-store' })).json();
    return { days: j.days || {}, stats: j.stats || null, updated: j.updated, share: POL_SHARE };
  }
  async function ethUsd() {
    const out = { byDay: {}, now: null, src: '' };
    try {
      const j = await (await fetch('https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=60&interval=daily')).json();
      for (const [t, p] of j.prices || []) out.byDay[new Date(t).toISOString().slice(0, 10)] = p;
      out.now = (j.prices || []).slice(-1)[0]?.[1] || null; out.src = 'coingecko daily';
    } catch (e) {}
    try { const a = await rpc('eth_call', [{ to: CL_ETH, data: '0x50d25bcd' }, 'latest']); const p = Number(BigInt(a)) / 1e8; if (p > 0) { out.now = p; out.src = out.src ? out.src + ' + chainlink live' : 'chainlink live'; } } catch (e) {}
    return out;
  }
  // per-day merged ledger: [{d, deskFee, deskVol, users, ponsEth, ponsUsd, total}]
  async function ledger() {
    const [dk, pn, px, fb] = await Promise.allSettled([desk(), pons(), ethUsd(), fables()]);
    const D = dk.status === 'fulfilled' ? dk.value : [];
    const P = pn.status === 'fulfilled' ? pn.value : null;
    const X = px.status === 'fulfilled' ? px.value : { byDay: {}, now: null, src: '' };
    const FB = fb.status === 'fulfilled' ? fb.value : null;
    const days = new Set(D.map(x => x.d)); if (P) Object.keys(P.days).forEach(d => days.add(d)); if (FB) Object.keys(FB.days).forEach(d => days.add(d));
    const rows = [...days].filter(d => d >= LAUNCH).sort().map(d => {
      const k = D.find(x => x.d === d) || {}; const eth = P ? (P.days[d] || 0) : null;
      const price = X.byDay[d] || X.now || null;
      const usd = eth != null && price ? eth * price : null;
      const fbd = FB ? FB.days[d] : null;
      const poolFee = fbd ? fbd.feeUsd : null;               // fees paid to all LPs that day (Fables' figure)
      const fablesUsd = poolFee == null ? null : poolFee * POL_SHARE; // the Court's share
      return { d, deskFee: k.fee || 0, deskVol: k.vol || 0, users: k.users || 0, ponsEth: eth, ponsUsd: usd, poolFee, poolVol: fbd ? fbd.volumeUsd : null, fablesUsd, total: (k.fee || 0) + (usd || 0) + (fablesUsd || 0) };
    });
    return { rows, desk: dk.status === 'fulfilled', pons: P, fables: FB, eth: X, launch: LAUNCH };
  }
  return { desk, pons, fables, ethUsd, ledger, LAUNCH, POL_SHARE };
})();
