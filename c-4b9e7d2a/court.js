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

  // ---- terminal: the Court's capital at work (live books + clearly labelled simulations) ----
  const MORPHO_VAULT = '0xBeEff033F34C046626B8D0A041844C5d1A5409dd'; // Steakhouse USDG (Morpho Vaults V2)
  const CARRY = { since: '2026-10-01T00:00:00Z', leverage: 1.5, bufferOfMargin: 1.0, openCostBps: 19, oiCap: 0.10,
    markets: [ { symbol: 'PERP_ETH_USDC', label: 'ETH', notional: 50000 }, { symbol: 'PERP_NVDA_USDC', label: 'NVDA', notional: 4000 } ] };
  const SENIOR_SIM_DEPOSIT = 100000; // simulated treasury USDG parked in Senior (Morpho), for the terminal only

  async function morpho() {
    const q = '{ vaultV2ByAddress(address:"' + MORPHO_VAULT + '", chainId:4663){ name symbol netApy apy totalAssetsUsd idleAssetsUsd } }';
    const r = await fetch('https://api.morpho.org/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const j = await r.json(); const v = j.data && j.data.vaultV2ByAddress; if (!v) throw new Error('morpho: vault not found');
    return { name: v.name, symbol: v.symbol, netApy: v.netApy, apy: v.apy, tvlUsd: v.totalAssetsUsd, idleUsd: v.idleAssetsUsd, src: 'api.morpho.org · live' };
  }
  async function fundingSince(symbol, sinceMs) {
    let rows = [], page = 1;
    while (page <= 10) {
      const j = await (await fetch('https://api.orderly.org/v1/public/funding_rate_history?symbol=' + symbol + '&size=500&page=' + page)).json();
      const r = (j.data && j.data.rows) || []; rows = rows.concat(r);
      if (!r.length || r[r.length - 1].funding_rate_timestamp < sinceMs) break; page++;
    }
    return rows.filter(x => x.funding_rate_timestamp >= sinceMs).sort((a, b) => a.funding_rate_timestamp - b.funding_rate_timestamp);
  }
  async function carry() {
    const sinceMs = Date.parse(CARRY.since);
    const out = { since: CARRY.since, sim: true, params: { leverage: CARRY.leverage, bufferOfMargin: CARRY.bufferOfMargin, openCostBps: CARRY.openCostBps, oiCap: CARRY.oiCap }, markets: [] };
    for (const m of CARRY.markets) {
      try {
        const [hist, fut] = await Promise.all([fundingSince(m.symbol, sinceMs), (await fetch('https://api.orderly.org/v1/public/futures/' + m.symbol)).json()]);
        const f = fut.data || {};
        const mark = +f.mark_price || 0, oiUsd = (+f.open_interest || 0) * (+f.index_price || mark);
        const capacity = oiUsd * CARRY.oiCap, notional = Math.min(m.notional, capacity || m.notional);
        const margin = notional / CARRY.leverage, buffer = margin * CARRY.bufferOfMargin, capital = notional + margin + buffer;
        let funding = 0, neg = 0, negStreak = 0, worst = 0; const series = [];
        for (const r of hist) { const pnl = r.funding_rate * notional; funding += pnl; if (r.funding_rate < 0) { neg++; negStreak++; } else negStreak = 0; if (pnl < worst) worst = pnl; series.push({ t: r.funding_rate_timestamp, rate: r.funding_rate, pnl, cum: funding }); }
        const periods = hist.length, days = periods / 3;
        const openCost = notional * CARRY.openCostBps / 1e4;
        const meanRate = periods ? hist.reduce((a, r) => a + r.funding_rate, 0) / periods : 0;
        out.markets.push({ symbol: m.symbol, label: m.label, notional, capital, margin, buffer, mark, oiUsd, capacity, periods, days,
          funding, openCost, net: funding - openCost, negPeriods: neg, negStreak, worstPeriod: worst, lastRate: hist.length ? hist[hist.length - 1].funding_rate : null, estNextRate: f.est_funding_rate != null ? +f.est_funding_rate : null,
          annOnNotional: meanRate * 1095, annOnCapital: capital ? (meanRate * 1095 * notional) / capital : 0, series });
      } catch (e) { out.markets.push({ symbol: m.symbol, label: m.label, error: String(e.message || e) }); }
    }
    const ok = out.markets.filter(x => !x.error);
    out.totals = { notional: ok.reduce((a, x) => a + x.notional, 0), capital: ok.reduce((a, x) => a + x.capital, 0), funding: ok.reduce((a, x) => a + x.funding, 0), net: ok.reduce((a, x) => a + x.net, 0) };
    out.totals.annOnCapital = out.totals.capital ? ok.reduce((a, x) => a + x.annOnCapital * x.capital, 0) / out.totals.capital : 0;
    return out;
  }
  // everything the terminal page needs, in one call
  async function terminal() {
    const [L, mp, cy] = await Promise.allSettled([ledger(), morpho(), carry()]);
    const led = L.status === 'fulfilled' ? L.value : { rows: [], launch: LAUNCH };
    const M = mp.status === 'fulfilled' ? mp.value : null;
    const C = cy.status === 'fulfilled' ? cy.value : null;
    const rows = led.rows || [];
    const sum = k => rows.reduce((a, x) => a + (x[k] || 0), 0);
    const last30 = rows.slice(-30), d30 = Math.max(1, last30.length);
    const inc30 = k => last30.reduce((a, x) => a + (x[k] || 0), 0);
    // POL book (live)
    const fb = led.fables, polCapital = fb && fb.stats ? fb.stats.tvlUsd * POL_SHARE : null;
    const polDays = fb ? Object.keys(fb.days).length : 0;
    const pol = { live: true, capital: polCapital, fees: sum('fablesUsd'), days: polDays, annOnCapital: polCapital && polDays ? (sum('fablesUsd') / polDays * 365) / polCapital : null, poolApr: fb && fb.stats ? fb.stats.aprPct / 100 : null, share: POL_SHARE };
    // income with no capital behind it (live)
    const pons = { live: true, usd: sum('ponsUsd'), eth: sum('ponsEth'), usd30: inc30('ponsUsd'), runRate: inc30('ponsUsd') / d30 * 365 };
    const desk = { live: true, usd: sum('deskFee'), usd30: inc30('deskFee'), runRate: inc30('deskFee') / d30 * 365, vol: sum('deskVol') };
    // senior (simulated treasury deposit at Morpho's live rate)
    const senior = { sim: true, deposit: SENIOR_SIM_DEPOSIT, morpho: M, annOnCapital: M ? M.netApy : null, perYear: M ? SENIOR_SIM_DEPOSIT * M.netApy : null };
    // blend
    const capital = (polCapital || 0) + (C ? C.totals.capital : 0) + SENIOR_SIM_DEPOSIT;
    const annIncomeCapital = (pol.annOnCapital ? pol.annOnCapital * polCapital : 0) + (C ? C.totals.annOnCapital * C.totals.capital : 0) + (senior.perYear || 0);
    const annIncomeAll = annIncomeCapital + pons.runRate + desk.runRate;
    return { launch: led.launch, rows, pol, pons, desk, carry: C, senior, blend: { capital, annIncomeCapital, annIncomeAll, apyOnCapital: capital ? annIncomeCapital / capital : null, apyAllIn: capital ? annIncomeAll / capital : null, realizedSinceLaunch: sum('total'), days: rows.length } };
  }
  return { desk, pons, fables, ethUsd, ledger, morpho, carry, terminal, LAUNCH, POL_SHARE };
})();
