// Ranch Strategy Game, economic model + balance gate (v2, ranch market)
// v1 replaced the agent-built v0 (circular value function, $0.85/head hay,
// noise-dominated bidding). v2 implements Steven's 7/06 decision: ranches are
// no longer DEALT by archetype. Every team starts with the SAME cash, sees its
// SECRET objective first, then BUYS a priced ranch listing as the first
// strategic decision (RBV by choice, not assignment). Big outfits cost more
// and leave less working capital.
//
// Engine: 8 ranches (6 secret archetypes + 2 probes) buying into a ranch market,
// sealed-bid bull auctions with common-value uncertainty, multi-year bull effects,
// drought Markov chain, market shocks, per-game winner vs each ranch's SECRET objective.
// Every constant cites _model_coefficients.md (real-data profiling 2026-07-05)
// or _context_brief.md section 2 (verified SMJ-paper numbers).
//
// HARD GATE (HANDOFF-RESUME.md): no multiplayer UI until
//   G1 every archetype wins a real share (no starvation, no dominance)
//   G2 the naive ROI-maximizer does NOT dominate (strategy, not econ)
//   G3 passivity loses
//   G4 different worlds crown different strategies (shock flips)
//   G5 winner's curse present but not degenerate
//   G6 highest-true-value bidder often loses the bull (fit + noise, decisions still matter)
//
// Run: node model-sim.js

'use strict';

// DIAG: real mutable object for market accumulation in playGame
// (Monte-Carlo reporting removed; scoreGame DIAG lines stripped)
const DIAG = { n: {}, kpi: {}, score: {}, market: {}, bulls: {} };


// ---------- tunables ----------
const YEARS = 5;              // 90-min class v1: 3-5 compressed years
const RUNS = 1500;            // Monte-Carlo games
const BULLS_PER_YEAR = 6;     // real median sale = 6 lots
const DISCOUNT = 0.92;

// ---------- regions (price mult from real ers_region medians; tech fit + labor from profiling) ----------
const REGIONS = {
  basin:   { name: 'Great Basin',      priceMult: 0.91, laborCost: 1.00, laborScarcity: 1.9,
             w: { ce: 1.2, growth: 0.8, marb: 0.4, forage: 2.0, milk: 0.6 },
             tech: { water: 2.0, vfence: 0.6, dogs: 0.9, drone: 1.0, genomic: 0.7 },
             droughtExposure: 1.25 },
  foothill:{ name: 'Foothill Brush',   priceMult: 0.95, laborCost: 1.00, laborScarcity: 1.3,
             w: { ce: 1.0, growth: 0.8, marb: 0.6, forage: 1.6, milk: 1.2 },
             tech: { water: 1.2, vfence: 1.8, dogs: 1.7, drone: 1.4, genomic: 1.0 },
             droughtExposure: 1.0 },
  plains:  { name: 'High Plains',      priceMult: 1.07, laborCost: 0.96, laborScarcity: 0.9,
             w: { ce: 1.2, growth: 1.6, marb: 0.6, forage: 1.2, milk: 1.0 },
             tech: { water: 1.0, vfence: 1.4, dogs: 1.3, drone: 1.6, genomic: 1.4 },
             droughtExposure: 1.1 },
  corn:    { name: 'Feedlot Corridor', priceMult: 1.12, laborCost: 1.07, laborScarcity: 1.5,
             w: { ce: 0.6, growth: 2.0, marb: 1.8, forage: 0.4, milk: 0.5 },
             tech: { water: 0.8, vfence: 0.9, dogs: 0.7, drone: 1.1, genomic: 1.9 },
             droughtExposure: 0.85 },
};

// counties from the real 264-county file: name, region key, operation scale
const COUNTIES = [
  { name: 'Weld, CO',        region: 'corn',     op: 2400 },
  { name: 'Gooding, ID',     region: 'corn',     op: 2000 },
  { name: 'Morrow, OR',      region: 'foothill', op: 1600 },
  { name: 'Elko, NV',        region: 'basin',    op: 1400 },
  { name: 'Beaverhead, MT',  region: 'plains',   op: 1200 },
  { name: 'Goshen, WY',      region: 'plains',   op: 1100 },
  { name: 'Box Elder, UT',   region: 'basin',    op: 900 },
  { name: 'Lemhi, ID',       region: 'foothill', op: 500 },
  { name: 'Juab, UT',        region: 'basin',    op: 420 },
  { name: 'Hot Springs, WY', region: 'plains',   op: 380 },
];

// ---------- ranch market (Steven 7/06: equal cash, priced listings, must buy round 0) ----------
// Pricing raised 7/08 (Steven: "ranch prices seem cheap"). A turnkey Western operation
// is land-dominated: ~$2,500/head of carrying capacity plus $800k of headquarters and
// improvements, times the regional land level. That puts the big outfits at $6-8M and
// the small places near $1.5-2M, so buying the ranch commits a real chunk of the stake
// instead of leaving idle cash. Stake raised to $6.5M so the spread stays affordable;
// gate re-passes on 4 runs (rapid_expansion holds 7-9%, the tightest archetype).
const START_CASH = 6500000;   // every team's identical investor stake
const LAND_MULT = { basin: 0.85, foothill: 1.05, plains: 0.95, corn: 1.15 };  // land price level by region
const LANDCAP_R = { basin: 2.0, foothill: 1.7, plains: 1.6, corn: 1.35 };     // expansion headroom (federal range vs fenced row-crop)

function makeListings() {
  return COUNTIES.map(c => {
    const herd = Math.round(c.op * (0.85 + Math.random() * 0.3));
    const landCap = Math.round(herd * LANDCAP_R[c.region] * (0.9 + Math.random() * 0.2));
    // price reflects scale: per-head land base + fixed headquarters/improvements, times
    // land level. Clamped so every listing is buyable but the biggest leaves only a
    // sliver of working capital (the trophy-ranch winner's curse in the land market).
    const ask = Math.min(Math.round(START_CASH * 0.97),
      Math.round((herd * 2500 + 800000) * LAND_MULT[c.region] * (1 + gauss() * 0.06)));
    return { county: c.name, region: c.region, herd, landCap, ask };
  });
}

// archetype purchase policies: score a listing GIVEN your secret objective.
// This is the self-selection that turns endowment into a choice.
const BUY_POLICY = {
  cost_leader:     (l, c) => l.herd / 2000 + (l.herd / l.ask) * 1e6 / 600
                             + (1.0 - c.reg.laborCost) * 1.5,                              // real scale, bought sharp, run lean
  elite_genetics:  (l, c) => c.left / 1e6 + c.reg.tech.genomic * 0.8
                             + (l.herd >= 350 && l.herd <= 900 ? 1.2 : 0),                 // small focused herd, war chest for bulls
  rapid_expansion: (l, c) => (l.landCap - l.herd) / 400 + l.herd / 1500
                             + (c.left < 500000 ? -4 : 0),                                 // headroom to grow, keep cash for cows
  conservative:    (l, c) => -Math.abs(l.herd - 1400) / 500
                             - c.reg.droughtExposure * 1.2,                                // real scale on sheltered ground, capital deployed
  family_survival: (l, c) => (c.reg.tech.water + c.reg.tech.dogs) / 3
                             + (l.herd >= 300 && l.herd <= 900 ? 1.0 : 0) + c.left / 3e6,  // defendable ground, modest scale
  seedstock:       (l, c) => c.left / 1.4e6 + (l.herd >= 400 && l.herd <= 1200 ? 1.4 : 0)
                             + c.reg.tech.genomic * 0.4,                                   // enough cows to sell bulls, cash for genetics
  naive_roi:       (l)    => l.herd,                                                       // biggest outfit money can buy, sticker price
  passive:         (l, c) => -Math.abs(l.ask - c.medianAsk) / 1e6,                         // the unremarkable middle
};

// ---------- market anchors ----------
const CALF_CWT_BASE = 230;      // $/cwt feeder anchor (2023-24 level)
const FEEDER_ELASTICITY = 0.54; // bull prices move with feeder index at this power
const TIER = [                  // verified medians, _context_brief section 2
  { key: 'commercial', anchor: 3900,  p: 0.08 },
  { key: 'mid',        anchor: 7250,  p: 0.34 },
  { key: 'premium',    anchor: 13500, p: 0.43 },
  { key: 'elite',      anchor: 37500, p: 0.15 },
];

// year-gated board unlocks (anti-iconification, 7/07): year 1 the board is herd-only,
// the tech shelf opens in year 2 (vendor pilot slots), and the credit line opens in
// year 3 (the bank wants two seasons of operating history). Distress borrowing is
// EXEMPT: survival credit is not a strategic lever. AI and humans obey the same
// calendar. Gate-tested 7/07: tech at yr3 starves elite_genetics (genomic is its
// engine) to a 5% share and fails G1; this 3-stage calendar passes on 3 runs.
const UNLOCKS = { debt: 3, tech: 2 };

// real Red Bluff sale bulls (bull-catalog.js, generated by build-bulls.js). In the
// browser the catalog loads as window.BULL_CATALOG before engine.js; in node it sits
// next to this file. If absent, makeBull falls back to the synthetic sire arcs.
// NAMED RB_BULLS, not BULL_CATALOG: sibling browser scripts share ONE global lexical
// scope, so redeclaring the catalog's own const here kills engine.js with
// "already been declared" and every page dies (live bug, 7/07).
const RB_BULLS = (typeof window !== 'undefined' && window.BULL_CATALOG)
  || (typeof require === 'function'
      ? (() => { try { return require('./bull-catalog.js'); } catch (e) { return null; } })()
      : null);

// real named sires (herd-board arcs)
const SIRES = [
  { name: 'Basin Payweight 1682',    arc: { ce: 5, growth: 9, marb: 5, forage: 6, milk: 6 } },
  { name: 'SAV Resource 1441',       arc: { ce: 7, growth: 7, marb: 6, forage: 7, milk: 7 } },
  { name: 'GB Fireball 672',         arc: { ce: 4, growth: 8, marb: 9, forage: 4, milk: 5 } },
  { name: 'Deer Valley Growth Fund', arc: { ce: 5, growth: 9, marb: 6, forage: 5, milk: 6 } },
  { name: 'Connealy Black Granite',  arc: { ce: 9, growth: 6, marb: 6, forage: 7, milk: 8 } },
  { name: 'SAV Renown 3439',         arc: { ce: 6, growth: 7, marb: 9, forage: 5, milk: 6 } },
];

// $Beef index: the terminal-index vocabulary students see in real catalogs. Display
// mapping only (the economy runs on traits): calibrated so the REAL Red Bluff $B
// distribution (p5 101, median 147, p95 195) lands where real sale bulls land, and a
// commodity cow herd (traits ~5) prints around 72, far below sale-bull genetics.
function dollarBeef(traits) {
  return Math.round(147 + ((traits.growth * 0.5 + traits.marb * 0.5) - 7.5) * 30);
}

// AI-sire semen programs (7/08, Steven's ask): proven elite genetics without the
// auction, cheap per straw, but AI does NOT always settle. Two real elite/premium
// sires offered per year at a FIXED price; semen is non-rival, so any number of teams
// can buy the same program. The trade is genetics-per-dollar vs RELIABILITY: a bought
// bull settles ~90% of his cows every year; an AI program conceives at ~55-65% and
// that rate is realized fresh each season, so the share of the calf crop it improves
// is a gamble. Proven sires carry low truth noise (you know the genetics), the risk is
// how MANY calves you get. A program lasts one breeding season, earns no reputation
// splash, and builds no brand: the make-vs-buy lesson. Genomic testing lifts the
// conception rate (synchronized-AI protocols) and doubles the reach.
const SEMEN = { offered: 2, coverage: 0.10, truthNoise: 0.12,
                conceptionMean: 0.60, conceptionSd: 0.10, genomicConceptionBonus: 0.12 };
function makeSemenCatalog(w) {
  const out = [];
  if (!(RB_BULLS && RB_BULLS.length)) return out;
  const pool = RB_BULLS.filter(b => b.tier === 'elite' || b.tier === 'premium');
  const used = new Set();
  for (let i = 0; i < SEMEN.offered && pool.length; i++) {
    let rb = pick(pool), tries = 0;
    while (used.has(rb.name) && tries++ < 20) rb = pick(pool);
    used.add(rb.name);
    // per-straw pricing: a fraction of a herd-bull's cost, but you pay for the whole
    // synchronized breeding group and only the settled share pays off
    const price = Math.round((rb.tier === 'elite' ? 6200 : 4200) * Math.pow(w.feederIdx, FEEDER_ELASTICITY));
    out.push({ name: rb.name, sire: rb.sire, tier: rb.tier, traits: rb.traits, epds: rb.epds, price });
  }
  return out;
}
function buySemen(r, w, item) {
  if (!item || r.cash < item.price) return false;
  if (r.semen && r.semen.boughtYear === w.year) return false; // one program per season
  const truth = {};
  TRAITS.forEach(t => truth[t] = clamp(item.traits[t] + gauss() * SEMEN.truthNoise, 1, 10));
  // conception rate rolls FRESH this season: the AI gamble. Genomic-synchronized herds
  // settle better. This scales how much of the herd the program actually improves.
  const base = SEMEN.conceptionMean + (r.tech.has('genomic') ? SEMEN.genomicConceptionBonus : 0);
  const conception = clamp(base + gauss() * SEMEN.conceptionSd, 0.30, 0.92);
  r.semen = { name: item.name, tier: item.tier, traits: item.traits, truth,
              boughtYear: w.year, paid: item.price, conception };
  r.cash -= item.price;
  return true;
}

// drought Markov chain (2013-2025 western DSI)
const DROUGHT_T = {
  mild:     { severe: 0.15, moderate: 0.35 },
  moderate: { severe: 0.25, moderate: 0.45 },
  severe:   { severe: 0.50, moderate: 0.35 },
};

// yearly global shocks; each flips who was right
const SHOCKS = [
  { id: 'calm',        p: 0.22 },
  { id: 'export_boom', p: 0.13 },
  { id: 'market_soft', p: 0.13 },
  { id: 'rate_hike',   p: 0.13 },
  { id: 'cheap_feed',  p: 0.13 },
  { id: 'tariff',      p: 0.13 },
  { id: 'processor',   p: 0.13 },
];

// tech shelf (capex, labor saving at full fit, drought mitigation)
const TECHS = {
  water:   { capex: 40000, laborSave: 0.05, droughtMitigation: 0.45 },
  vfence:  { capex: 28000, laborSave: 0.35, droughtMitigation: 0.25 },
  dogs:    { capex: 8000,  laborSave: 0.15, droughtMitigation: 0.0  },
  drone:   { capex: 14000, laborSave: 0.20, droughtMitigation: 0.0  },
  genomic: { capex: 12000, laborSave: 0.0,  droughtMitigation: 0.0  },
};
const WAGE_BASE = 39000;
const WAGE_DRIFT = 0.036;
const HANDS_PER_COW = 1 / 350;

// ---------- archetypes: secret objectives (KPI weights) + decision policies ----------
const ARCHETYPES = {
  cost_leader: {
    label: 'Cost Leader',
    kpi: { costEff: 0.35, cash: 0.30, herdGrowth: 0.15, resilience: 0.20 },
    traitVal: { ce: 0.8, growth: 1.2, marb: 0.2, forage: 1.5, milk: 0.8 },
    shade: 0.70, bidCashCap: 0.25, expandRate: 0.15, debtCap: 0.25, leanOps: 0.95,
    marketing: 'volume', techRule: (fit, t) => fit >= 1.2 && TECHS[t].capex <= 30000,
  },
  elite_genetics: {
    label: 'Elite Genetics',
    kpi: { genetics: 0.40, premium: 0.30, rep: 0.15, cash: 0.15 },
    traitVal: { ce: 1.0, growth: 0.6, marb: 1.8, forage: 0.4, milk: 0.8 },
    shade: 0.85, bidCashCap: 0.55, expandRate: 0.05, debtCap: 0.35, estNoise: 0.15,
    marketing: 'premium', techRule: (fit, t) => t === 'genomic' || fit >= 1.4,
  },
  rapid_expansion: {
    label: 'Rapid Expansion',
    kpi: { herdGrowth: 0.60, cash: 0.20, genetics: 0.10, resilience: 0.10 },
    traitVal: { ce: 0.8, growth: 1.4, marb: 0.3, forage: 1.0, milk: 1.4 },
    shade: 0.80, bidCashCap: 0.30, expandRate: 0.50, debtCap: 0.50,
    marketing: 'volume', techRule: (fit, t) => fit >= 1.3,
  },
  conservative: {
    label: 'Conservative / Low Debt',
    kpi: { lowDebt: 0.25, resilience: 0.30, cash: 0.25, herdGrowth: 0.20 },
    traitVal: { ce: 1.2, growth: 0.8, marb: 0.4, forage: 1.4, milk: 1.0 },
    shade: 0.70, bidCashCap: 0.15, expandRate: 0.05, debtCap: 0.0,
    marketing: 'volume', techRule: (fit, t) => fit >= 1.5 && TECHS[t].capex <= 45000,
  },
  family_survival: {
    label: 'Family Survival',
    // survival is herd CONTINUITY and cost discipline, not growth (growth was a
    // free KPI for cash-rich small buyers in the ranch market)
    kpi: { resilience: 0.40, lowDebt: 0.25, cash: 0.15, costEff: 0.20 },
    traitVal: { ce: 1.3, growth: 0.8, marb: 0.4, forage: 1.5, milk: 1.1 },
    shade: 0.72, bidCashCap: 0.10, expandRate: 0.08, debtCap: 0.10, leanOps: 0.90, // family labor, no hired crew
    marketing: 'volume', techRule: (fit, t) => (t === 'water' && fit >= 1.0) || (t === 'dogs' && fit >= 1.2),
  },
  seedstock: {
    label: 'Seedstock / Reputation',
    kpi: { rep: 0.40, premium: 0.30, genetics: 0.20, cash: 0.10 },
    traitVal: { ce: 1.0, growth: 0.8, marb: 1.4, forage: 0.6, milk: 1.0 },
    shade: 0.90, bidCashCap: 0.50, expandRate: 0.05, debtCap: 0.30, estNoise: 0.15,
    marketing: 'premium', techRule: (fit, t) => t === 'genomic' || fit >= 1.3,
  },
  // probes: they play, but the fairness gate is about the 6 above
  naive_roi: {
    label: 'Naive ROI Maximizer', probe: true,
    kpi: { cash: 0.60, herdGrowth: 0.25, genetics: 0.15 },
    traitVal: { ce: 1.0, growth: 1.0, marb: 1.0, forage: 1.0, milk: 1.0 },
    shade: 0.98, bidCashCap: 0.60, expandRate: 0.40, debtCap: 0.50, estNoise: 0.28,
    marketing: 'volume', techRule: () => true, leanOps: 1.05, // scale-fast, no operating discipline
  },
  passive: {
    label: 'Passive', probe: true,
    // scored under a REAL objective (conservative's): the gate tests whether a team
    // that does nothing can outscore active teams under the game's actual scorecards
    kpi: { lowDebt: 0.25, resilience: 0.30, cash: 0.25, herdGrowth: 0.20 },
    traitVal: { ce: 1.0, growth: 1.0, marb: 1.0, forage: 1.0, milk: 1.0 },
    shade: 0.0, bidCashCap: 0.0, expandRate: 0.0, debtCap: 0.0,
    marketing: 'volume', techRule: () => false,
  },
};
const TRAITS = ['ce', 'growth', 'marb', 'forage', 'milk'];

// ---------- utils ----------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function wpick(items) { const r = Math.random(); let acc = 0;
  for (const it of items) { acc += it.p; if (r < acc) return it; } return items[items.length - 1]; }
function avg(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

// ---------- world ----------
function newWorld() {
  return {
    year: 0, feederIdx: 1.0, drought: 'mild', wageRatchet: 1.0,
    rateHikeYears: 0, processorRegion: null, shock: 'calm',
    droughtHist: [], shockHist: [], feederHist: [],
  };
}
function stepWorld(w) {
  w.year++;
  const t = DROUGHT_T[w.drought]; const r = Math.random();
  w.drought = r < t.severe ? 'severe' : r < t.severe + t.moderate ? 'moderate' : 'mild';
  w.droughtHist.push(w.drought);
  w.shock = wpick(SHOCKS).id;
  w.shockHist.push(w.shock);
  if (w.shock === 'rate_hike') w.rateHikeYears = 2;
  else if (w.rateHikeYears > 0) w.rateHikeYears--;
  if (w.shock === 'processor' && !w.processorRegion) w.processorRegion = pick(Object.keys(REGIONS));
  // feeder index: +1% drift, sigma 5%, drought liquidation echo
  let dr = 0.01 + gauss() * 0.05;
  const h = w.droughtHist;
  if (h.length >= 2 && h[h.length - 2] === 'severe') dr -= 0.03;
  if (h.length >= 3 && h[h.length - 3] === 'severe') dr += 0.07;
  if (w.shock === 'export_boom') dr += 0.06;
  if (w.shock === 'market_soft') dr -= 0.06;
  w.feederIdx = clamp(w.feederIdx * (1 + dr), 0.6, 2.2);
  w.feederHist.push(w.feederIdx);
  const wg = w.drought === 'severe' ? 0.08 + Math.random() * 0.03 : WAGE_DRIFT;
  w.wageRatchet *= (1 + wg);
  // this season's AI-semen offerings (same two sires every team sees; opens with the
  // tech shelf, UNLOCKS.tech). Regenerated each year so the sires rotate.
  w.semenCatalog = w.year >= UNLOCKS.tech ? makeSemenCatalog(w) : [];
}
function droughtSeverity(w, region) {
  const base = w.drought === 'severe' ? 1.0 : w.drought === 'moderate' ? 0.5 : 0.0;
  return clamp(base * REGIONS[region].droughtExposure, 0, 1.2);
}

// ---------- ranches ----------
function makeRanch(key, l) {
  const a = ARCHETYPES[key];
  const g = {}; TRAITS.forEach(t => g[t] = clamp(4.5 + gauss() * 0.8, 3, 7));
  return {
    key, a, county: l.county, region: l.region, herd: l.herd, herd0: l.herd,
    cash: START_CASH - l.ask, ranchAsk: l.ask,
    debt: 0, g, rep: 25 + Math.round(Math.random() * 15),
    tech: new Set(), bulls: [], semen: null,
    landCap: l.landCap,
    // a ranch only needs so many herd sires; deep pockets no longer mean infinite bulls
    rosterCap: clamp(Math.round(l.herd / 250), 2, 8),
    peakEquity: 0, maxDrawdown: 0, totalCost: 0, totalLbs: 0, premSum: 0, premN: 0,
    revHist: [], semenRoyalty: 0, lastStmt: null,
  };
}
function equity(r, w) {
  const gAvg = avg(TRAITS.map(t => r.g[t]));
  // better-genetics herds appraise higher (0.7 + g/10*0.6: g5 = 1.0x, g7 = 1.12x)
  return r.cash - r.debt + r.herd * 1400 * Math.pow(w.feederIdx, 0.8) * (0.7 + gAvg / 10 * 0.6);
}

// ---------- bulls ----------
// Real-bull path: sample a Red Bluff sale bull; its tier came from its real price
// percentile and its traits from real EPD ranks (quantile-mapped to the synthetic
// moments, so the balance gates keep meaning). A small jitter keeps repeat draws of
// the same animal from being clones; truth noise is the same common-value uncertainty.
function makeRealBull(w) {
  const rb = pick(RB_BULLS);
  const tier = TIER.find(t => t.key === rb.tier);
  const catalog = {}, truth = {};
  TRAITS.forEach(t => {
    catalog[t] = clamp(rb.traits[t] + gauss() * 0.3, 1, 10);
    truth[t] = clamp(catalog[t] + gauss() * 0.5, 1, 10);
  });
  const anchor = tier.anchor * Math.pow(w.feederIdx, FEEDER_ELASTICITY);
  return { name: rb.name, sire: rb.sire, breed: rb.breed, consignor: rb.consignor,
           epds: rb.epds, dollars: rb.dollars, realYear: rb.saleYear,
           tier: rb.tier, catalog, truth, anchor,
           reserve: anchor * 0.82, tierIdx: TIER.findIndex(x => x.key === rb.tier) };
}
function makeBull(w) {
  if (RB_BULLS && RB_BULLS.length) return makeRealBull(w);
  const tier = wpick(TIER);
  const sire = pick(SIRES);
  const tierBoost = { commercial: -0.8, mid: 0, premium: 0.9, elite: 1.9 }[tier.key];
  const catalog = {}, truth = {};
  TRAITS.forEach(t => {
    catalog[t] = clamp(sire.arc[t] + tierBoost + gauss() * 0.9, 1, 10);
    truth[t] = clamp(catalog[t] + gauss() * 0.5, 1, 10); // catalog vs reality: common-value uncertainty
  });
  const anchor = tier.anchor * Math.pow(w.feederIdx, FEEDER_ELASTICITY);
  return { sire: sire.name, tier: tier.key, catalog, truth, anchor,
           reserve: anchor * 0.82, tierIdx: TIER.findIndex(x => x.key === tier.key) };
}

// bull trait value to THIS ranch, per year, from production fundamentals (not price)
function bullYearValue(r, w, traits, coverage) {
  const rw = REGIONS[r.region].w, tv = r.a.traitVal;
  const calfPrice = calfCwt(r, w);
  const calves = r.herd * 0.88;
  let v = 0;
  // PRODUCTION channels cap at trait 7.5: production differences between good bulls
  // are small (EPDs explain 0.3% of price; the top end is brand/pedigree, not lbs)
  const capT = t => Math.min(t, 7.5);
  // growth: extra lbs on the covered calf crop
  const dG = Math.max(0, capT(traits.growth) - Math.max(r.g.growth, 5));
  v += dG * 12 * (calves * coverage) / 100 * calfPrice * (rw.growth / 1.2) * (tv.growth / 1.0) * 0.5;
  // marbling: grid premium; premium marketers sell into the NATIONAL branded market
  // (elite buyers travel; differentiation escapes the local commodity weights)
  const dM = Math.max(0, capT(traits.marb) - Math.max(r.g.marb, 5));
  const premOrient = r.a.marketing === 'premium' ? 1.0 : 0.25;
  const marbW = r.a.marketing === 'premium' ? Math.max(rw.marb, 1.5) : rw.marb;
  v += dM * 0.02 * (calves * coverage) * (550 / 100) * calfPrice * (marbW / 1.0) * premOrient;
  // calving ease: saved calves
  const dC = Math.max(0, capT(traits.ce) - Math.max(r.g.ce, 5));
  v += dC * 0.004 * (calves * coverage) * (550 / 100) * calfPrice * (rw.ce / 1.0) * (tv.ce / 1.0);
  // forage efficiency: cheaper cows
  const dF = Math.max(0, capT(traits.forage) - Math.max(r.g.forage, 5));
  v += dF * 0.012 * cowCost(r, w) * (r.herd * coverage) * (rw.forage / 1.4) * (tv.forage / 1.4);
  // maternal: daughters raise future weaning lbs
  const dMi = Math.max(0, capT(traits.milk) - Math.max(r.g.milk, 5));
  v += dMi * 4 * (calves * coverage) / 100 * calfPrice * 0.4 * (tv.milk / 1.0);
  return v;
}
function bullCoverage(r) {
  let c = clamp(150 / r.herd, 0.06, 0.5);
  if (r.tech.has('genomic')) c = Math.min(0.8, c * 2); // AI program spreads the genetics
  return c;
}
// willingness to pay: PV of increments vs a $4,000 commodity bull, on CATALOG traits
function bullEstValue(r, w, bull, yearsLeft) {
  const cov = bullCoverage(r);
  const yrs = Math.min(4, Math.max(1, yearsLeft));
  let pv = 0, pvC = 0;
  const commodity = { ce: 5, growth: 5, marb: 5, forage: 5, milk: 5 };
  for (let y = 0; y < yrs; y++) {
    const d = Math.pow(DISCOUNT, y);
    pv += bullYearValue(r, w, bull.catalog, cov) * d;
    pvC += bullYearValue(r, w, commodity, cov) * d;
  }
  // premium marketers also buy the pedigree as a marketing asset (where elite value lives)
  if (r.a.marketing === 'premium') pv += Math.pow(bull.tierIdx, 1.5) * 2600 * (r.key === 'seedstock' ? 1.4 : 1.0);
  return Math.max(0, pv - pvC) + 4000;
}

// ---------- yearly economics ----------
function calfCwt(r, w) {
  const reg = REGIONS[r.region];
  // premium marketers sell into the national branded market, escaping the local discount
  const regMult = r.a.marketing === 'premium' ? Math.max(reg.priceMult, 1.0) : reg.priceMult;
  let p = CALF_CWT_BASE * w.feederIdx * regMult;
  if (w.shock === 'export_boom') p *= 1.15;
  if (w.shock === 'market_soft') p *= 0.85;
  if (w.processorRegion === r.region) p *= 1.08;
  return p;
}
function cowCost(r, w) {
  let c = 880;
  const sev = droughtSeverity(w, r.region);
  let feedBump = sev * 0.55;
  let mit = 0;
  if (r.tech.has('water')) mit += TECHS.water.droughtMitigation * (REGIONS[r.region].tech.water / 2);
  if (r.tech.has('vfence')) mit += TECHS.vfence.droughtMitigation * (REGIONS[r.region].tech.vfence / 1.8);
  mit += Math.max(0, r.g.forage - 5) * 0.03;
  feedBump *= (1 - clamp(mit, 0, 0.7));
  c *= (1 + feedBump * 0.6);
  if (w.shock === 'cheap_feed') c *= 0.88;
  return c;
}
function laborCost(r, w) {
  const reg = REGIONS[r.region];
  let hands = Math.max(0.7, r.herd * HANDS_PER_COW); // small places run on owner labor
  let save = 0;
  for (const t of r.tech) {
    const fitScale = { water: 2.0, vfence: 1.8, dogs: 1.7, drone: 1.6, genomic: 1.9 }[t];
    save += TECHS[t].laborSave * (reg.tech[t] / fitScale);
  }
  // VF and stockmanship are complements (tech profiling finding 5)
  if (r.tech.has('vfence') && r.tech.has('dogs')) save += 0.06;
  hands *= (1 - clamp(save, 0, 0.55));
  let wage = WAGE_BASE * reg.laborCost * w.wageRatchet;
  // tech-skill premium by scale: micro +25%, mid +15%, large +10%
  if (r.tech.has('vfence') || r.tech.has('drone')) {
    wage *= r.herd < 400 ? 1.25 : r.herd < 1000 ? 1.15 : 1.10;
  }
  wage *= 1 + (reg.laborScarcity - 1.0) * 0.06;
  return hands * wage;
}
function productionYear(r, w) {
  const sev = droughtSeverity(w, r.region);
  let rate = 0.88 + (r.g.ce - 5) * 0.004 - sev * 0.06;
  if (sev > 0.7 && r.tech.has('drone') && REGIONS[r.region].tech.drone >= 1.2) rate += sev * 0.018;
  const calves = r.herd * clamp(rate, 0.6, 0.97);
  const lbs = 550 + (r.g.growth - 5) * 12 + Math.max(0, r.g.milk - 5) * 4 - sev * 35;
  let price = calfCwt(r, w);
  let prem = 1.0;
  if (r.a.marketing === 'premium') {
    prem += Math.max(0, r.g.marb - 5) * 0.06 + (r.rep - 40) * 0.005;
    if (w.shock === 'tariff') prem = Math.max(0.85, prem - 0.15);
  } else {
    prem += (r.rep - 40) * 0.0008; // repeat-buyer trust, small
  }
  // herd maintenance: cull-and-replace nets out if you retain heifers (3.5% of the
  // calf crop stays home, herd holds); passive sells everything and the herd erodes
  let saleFrac = 0.965;
  if (r.key === 'passive') { saleFrac = 1.0; r.herd = Math.round(r.herd * 0.88); } // real cull rate, no retention
  let revenue = calves * saleFrac * (lbs / 100) * price * prem;
  let extraCost = 0;
  // seedstock: part of the crop sells as bulls at brand-driven prices (the 11-41x lesson)
  if (r.key === 'seedstock') {
    const nB = Math.round(calves * 0.10);
    const gAvg = avg(TRAITS.map(t => r.g[t]));
    const tierAnchor = 3900 + Math.max(0, gAvg - 4.5) * 5200;
    const brandMult = 0.7 + (r.rep / 100) * 1.1;
    const cv = clamp(0.45 - (r.rep / 100) * 0.30, 0.10, 0.45);
    const bullPrice = tierAnchor * brandMult * Math.pow(w.feederIdx, FEEDER_ELASTICITY)
                      * (1 + gauss() * cv / Math.sqrt(Math.max(1, nB)));
    // the order book is reputation-gated: buyers show up for PROVEN programs; until
    // the brand exists, the rest of the bull crop moves at commodity money
    const nBrand = Math.round(nB * clamp(r.rep / 70, 0.3, 1.0));
    revenue = revenue * 0.60 + nBrand * Math.max(1500, bullPrice)
            + (nB - nBrand) * 3900 * Math.pow(w.feederIdx, FEEDER_ELASTICITY);
    extraCost = nB * 2000; // bull development and marketing
    r.premSum += brandMult; r.premN++; r.lastPrem = brandMult;
  } else {
    r.premSum += prem; r.premN++; r.lastPrem = prem;
  }
  const lean = r.a.leanOps || 1.0; // cost-leader runs a no-frills operation
  // every herd needs bulls: commodity-bull replacement cost, offset by owned auction bulls
  const activeN = r.bulls.filter(b => w.year - b.boughtYear < 4).length;
  const commodityBullCost = Math.max(0, r.herd / 100 - activeN * 0.25) * 4000
                          * Math.pow(w.feederIdx, FEEDER_ELASTICITY);
  // AI-stud royalties: an active ELITE bull's straws sell into the national program,
  // and reputation prices them (proven brand moves semen). A make-side income line.
  const eliteN = r.bulls.filter(b => b.tier === 'elite' && w.year - b.boughtYear < 4).length;
  const semenRoyalty = eliteN * 1800 * clamp(r.rep / 60, 0.3, 1.3) * Math.pow(w.feederIdx, FEEDER_ELASTICITY);
  r.semenRoyalty = semenRoyalty;
  const cowCostTot = cowCost(r, w) * r.herd, laborTot = laborCost(r, w);
  const overhead = 35000, interest = r.debt * (w.rateHikeYears > 0 ? 0.13 : 0.07);
  // fixed overhead (equipment, insurance, facilities) is lumpy: small outfits pay it too
  const costs = (cowCostTot + laborTot) * lean + overhead + extraCost + commodityBullCost + interest;
  r.totalCost += costs; r.totalLbs += calves * lbs;
  const net = revenue + semenRoyalty - costs;
  r.cash += net;
  r.revHist.push(net);
  // income statement snapshot for the balance-sheet card (display only; the math above
  // is the source of truth). Rounded at render time, not here.
  r.lastStmt = { year: w.year, revenue, semenRoyalty, cowCost: cowCostTot * lean, labor: laborTot * lean,
                 overhead, bullCost: commodityBullCost, breeding: extraCost, interest, net,
                 calves: Math.round(calves), lbs: Math.round(lbs) };
  // genetics evolve toward active bulls' true traits, plus any AI semen program bought
  // this season. Semen contributes weighted by its CONCEPTION rate (the AI gamble): a
  // program that only settles 45% of cows moves the herd far less than one that hits 70%.
  const active = r.bulls.filter(b => w.year - b.boughtYear < 4);
  const cov = bullCoverage(r);
  const speed = r.tech.has('genomic') ? 0.30 : 0.22; // genomic selection accelerates progress
  const usableSemen = r.semen && r.semen.boughtYear === w.year ? r.semen : null;
  if (active.length || usableSemen) {
    TRAITS.forEach(t => {
      let pull = 0, wgt = 0;
      if (active.length) { const bAvg = avg(active.map(b => b.truth[t])); const cw = clamp(cov * active.length, 0.1, 0.8); pull += (bAvg - r.g[t]) * cw; wgt += cw; }
      if (usableSemen) { const sw = SEMEN.coverage * usableSemen.conception * (r.tech.has('genomic') ? 2 : 1); pull += (usableSemen.truth[t] - r.g[t]) * sw; wgt += sw; }
      // selection focus: breeders pull hardest on the traits their strategy values
      const focus = 0.5 + (r.a.traitVal[t] || 1) / 2;
      if (wgt > 0) r.g[t] += pull * speed * focus;
    });
  } else {
    TRAITS.forEach(t => r.g[t] += (4.3 - r.g[t]) * 0.08); // unimproved herds slide below average
  }
  // reputation dynamics
  let dRep = 0;
  if (r.a.marketing === 'premium') dRep += 2.5;
  if (r.bulls.some(b => b.tier === 'elite' && b.boughtYear === w.year)) dRep += 2.0; // the splash is the purchase year, then it is priced in
  if ([...r.tech].some(t => REGIONS[r.region].tech[t] >= 1.4)) dRep += 1.0;
  if (net < 0 && r.cash < 0) dRep -= 2;
  r.rep = clamp(r.rep + dRep - 0.5, 5, 100);
  // winner's-curse ledger: accrue discounted realized value on true traits, plus the
  // commodity-bull replacement the operation no longer buys (a real cash channel the
  // bid already priced in; see commodityBullCost above)
  for (const b of active) b.realized += (bullYearValue(r, w, b.truth, bullCoverage(r))
                                         + 0.25 * 4000 * Math.pow(w.feederIdx, FEEDER_ELASTICITY))
                                        * Math.pow(DISCOUNT, w.year - b.boughtYear);
}

// ---------- decisions ----------
function decideYear(r, w) {
  const a = r.a;
  // distress: borrow first if the archetype tolerates debt, then fire-sale cows
  if (r.cash < 0 && a.debtCap > 0) {
    const room = a.debtCap * Math.max(0, equity(r, w)) - r.debt;
    const draw = Math.min(-r.cash, Math.max(0, room));
    if (draw > 0) { r.debt += draw; r.cash += draw; }
  }
  if (r.cash < 0) {
    const sell = Math.min(Math.max(0, r.herd - 100), Math.ceil(-r.cash / (1200 * w.feederIdx)));
    if (sell > 0) { r.herd -= sell; r.cash += sell * 1150 * w.feederIdx; r.rep -= 2; }
  }
  if (r.key === 'passive') return;
  // conservative types destock EARLY in severe drought, then restock counter-cyclically
  // (sell before the crowd, rebuy cheap after the liquidation: the real-options play)
  if (r.key === 'conservative' || r.key === 'family_survival') {
    const sev = droughtSeverity(w, r.region);
    // owned water infrastructure means you ride out a moderate year instead of selling
    const thresh = (r.key === 'family_survival' ? 0.45 : 0.7) * (r.tech.has('water') ? 1.5 : 1.0);
    if (sev > thresh) {
      const sell = Math.round(r.herd * 0.12);
      r.herd -= sell; r.cash += sell * 1500 * w.feederIdx; // early sellers beat the liquidation crowd
    } else if (sev === 0 && r.herd < r.herd0 && r.cash > 120000) {
      const buy = Math.min(r.herd0 - r.herd, Math.floor((r.cash * 0.3) / (1750 * w.feederIdx)));
      if (buy > 0) { r.herd += buy; r.cash -= buy * 1750 * w.feederIdx; }
    }
  }
  // expansion
  if (a.expandRate > 0 && r.cash > 60000) {
    // bulk buyers pay up (thin bred-cow supply); modest expansion buys at market
    const cowPrice = (a.expandRate >= 0.4 ? 1750 : 1675) * w.feederIdx;
    let budget = r.cash * a.expandRate;
    if (r.key === 'naive_roi' && w.feederIdx > 1.0) budget = r.cash * 0.5; // optimizes the observed world
    // voluntary leverage waits for the credit line (year-gated unlock; distress
    // borrowing above is exempt because survival credit is not a strategic lever)
    if ((r.key === 'rapid_expansion' || r.key === 'naive_roi') && w.year >= UNLOCKS.debt) {
      const room = a.debtCap * equity(r, w) - r.debt;
      if (room > 0) { r.debt += room * 0.5; r.cash += room * 0.5; budget += room * 0.5; }
    }
    // management absorption: a crew can only integrate ~35% more cows a year
    const buy = Math.min(Math.floor(budget / cowPrice), r.landCap - r.herd, Math.round(r.herd * 0.35));
    if (buy > 0) { r.herd += buy; r.cash -= buy * cowPrice; }
  }
  // debt paydown for low-debt types
  if (r.debt > 0 && (r.key === 'conservative' || r.key === 'family_survival')) {
    const pay = Math.min(r.debt, Math.max(0, r.cash - 80000));
    r.debt -= pay; r.cash -= pay;
  }
  // tech adoption: one per year if policy triggers and cash allows.
  // The tech shelf is year-gated (UNLOCKS.tech): nobody adopts before it opens.
  if (w.year < UNLOCKS.tech) return;
  // AI-semen: genetics-led archetypes buy proven straws when they are NOT winning bulls
  // at auction (the make-vs-buy hedge). Cheaper per unit, but the conception gamble is
  // priced into how much it moves the herd. Bull-focused buyers skip it.
  if ((r.key === 'elite_genetics' || r.key === 'seedstock') && (w.semenCatalog || []).length
      && !(r.semen && r.semen.boughtYear === w.year)) {
    const best = w.semenCatalog.slice().sort((x, y) =>
      (y.traits.marb + y.traits.growth) - (x.traits.marb + x.traits.growth))[0];
    if (best && r.cash > best.price + 200000) buySemen(r, w, best);
  }
  for (const t of Object.keys(TECHS)) {
    if (r.tech.has(t)) continue;
    const fit = REGIONS[r.region].tech[t];
    const scaleOk = t === 'vfence' ? r.herd >= 250 : t === 'genomic' ? r.herd >= 300 : true;
    if (r.cash > TECHS[t].capex + 50000 && scaleOk && a.techRule(fit, t)) {
      r.tech.add(t); r.cash -= TECHS[t].capex;
      break;
    }
  }
}

// ---------- sealed-bid auction ----------
function auctionYear(ranches, w, ledger) {
  const yearsLeft = YEARS - w.year + 1;
  for (let i = 0; i < BULLS_PER_YEAR; i++) {
    const bull = makeBull(w);
    let best = null, bestBid = 0, bestTrue = null, bestTrueVal = -1, bestTrueOpen = false;
    for (const r of ranches) {
      if (r.a.bidCashCap <= 0) continue;
      const activeN = r.bulls.filter(b => w.year - b.boughtYear < 4).length;
      const open = activeN < r.rosterCap;
      // who the bull is TRULY worth most to (true traits, no noise); includes the
      // pedigree marketing asset, which is real value to premium marketers
      const cov = bullCoverage(r);
      let tv = 0;
      for (let y = 0; y < Math.min(4, yearsLeft); y++) tv += bullYearValue(r, w, bull.truth, cov) * Math.pow(DISCOUNT, y);
      if (r.a.marketing === 'premium') tv += Math.pow(bull.tierIdx, 1.5) * 2600 * (r.key === 'seedstock' ? 1.4 : 1.0);
      if (tv > bestTrueVal) { bestTrueVal = tv; bestTrue = r; bestTrueOpen = open; }
      if (!open) continue; // roster full: sits this one out
      // estimation noise by buyer sophistication (real ladder: soph buyers price better)
      const est = bullEstValue(r, w, bull, yearsLeft) * Math.exp(gauss() * (r.a.estNoise || 0.16));
      const bid = Math.min(est * r.a.shade, r.cash * r.a.bidCashCap);
      if (bid > bestBid && bid >= bull.reserve) { bestBid = bid; best = r; }
    }
    if (!best) continue; // no sale
    // could the true-best buyer have taken this bull? Losing on budget scarcity or a
    // full roster is a rational allocation, not noise-driven misallocation
    const affordable = bestTrueOpen && bestTrue.cash * bestTrue.a.bidCashCap >= bestBid;
    best.cash -= bestBid;
    // ledger bookkeeping: a bull covers a fixed head count (covHead) no matter how the
    // herd grows later, and a premium marketer's pedigree asset is real brand value
    // (it monetizes through reputation), so the realized side must count both
    const rec = { truth: bull.truth, tier: bull.tier, boughtYear: w.year, paid: bestBid,
                  covHead: best.herd * bullCoverage(best),
                  realized: best.a.marketing === 'premium'
                    ? Math.pow(bull.tierIdx, 1.5) * 2600 * (best.key === 'seedstock' ? 1.4 : 1.0) : 0 };
    best.bulls.push(rec);
    ledger.push({ rec, winnerKey: best.key, trueBestKey: bestTrue.key, affordable });
  }
}

// ---------- scoring: absolute anchors, weighted by SECRET objective ----------
// Absolute (not within-game min-max) so an archetype cannot auto-win by being the
// sole occupant of a dimension; anchors are the balance-tuning knobs.

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function computeKpis(r, w, medDD, medPerLb) {
  const eq = equity(r, w);
  const eq0 = r.eq0 || 1;
  const perLb = r.totalLbs > 0 ? r.totalCost / r.totalLbs : 3;
  return {
    cash:       clamp((eq / eq0 - 0.75) / 0.9, 0, 1),         // 1.0 at 1.65x equity growth
    // heads are worth what the market says: growth into a soft market scores less
    herdGrowth: clamp((r.herd / r.herd0 * Math.pow(w.feederIdx, 0.4) - 0.9) / 0.8, 0, 1),
    genetics:   clamp((avg(TRAITS.map(t => r.g[t])) - 4) / 2.6, 0, 1), // 1.0 at 6.6, reachable played well
    rep:        clamp(r.rep / 75, 0, 1),
    // relative-to-the-room: defense means weathering THIS world better than the table,
    // and it only counts if the OPERATION survives (herd continuity, not cash hoarding)
    costEff:    clamp(0.5 + (medPerLb - perLb) * 0.6, 0, 1),
    resilience: clamp(0.5 + (medDD - r.maxDrawdown / REGIONS[r.region].droughtExposure) * 1.5, 0, 1)
                * clamp(r.herd / (r.herd0 * 0.9), 0, 1), // strategic destock keeps credit at 90%+
    lowDebt:    clamp(1 - (r.debt / Math.max(1, eq)) * 2.5, 0, 1),
    premium:    clamp(((r.lastPrem || 1) - 0.95) / 0.45, 0, 1), // END-state brand premium
  };
}
function scoreGame(ranches, w) {
  // geography-adjusted drawdown: defense is judged against your county's exposure
  const ddAdj = r => r.maxDrawdown / REGIONS[r.region].droughtExposure;
  const medDD = median(ranches.map(ddAdj));
  const medPerLb = median(ranches.map(r => r.totalLbs > 0 ? r.totalCost / r.totalLbs : 3));
  return ranches.map(r => {
    const kpi = computeKpis(r, w, medDD, medPerLb);
    let s = 0;
    for (const [k, wgt] of Object.entries(r.a.kpi)) s += wgt * kpi[k];
    if (r.cash < 0 && r.herd < 150) s *= 0.3; // busted operations do not win
    // accumulate diagnostics
    // DIAG stripped
    // DIAG stripped
    // DIAG stripped
    return s;
  });
}

// ---------- one game ----------
function playGame(ledger) {
  const w = newWorld();
  // round 0, the ranch market: secret objective is already dealt (it IS the archetype),
  // every team holds the same START_CASH, and buys a listing that fits its strategy.
  // Purchase order shuffles each game, so rivals contest the same listings.
  const listings = makeListings();
  const medianAsk = median(listings.map(l => l.ask));
  const shuffle = a => a.sort(() => Math.random() - 0.5);
  const order = shuffle(Object.keys(ARCHETYPES));
  const remaining = [...listings];
  const bought = {};
  for (const k of order) {
    let bestI = 0, bestS = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const l = remaining[i];
      const s = BUY_POLICY[k](l, { left: START_CASH - l.ask, reg: REGIONS[l.region], medianAsk });
      if (s > bestS) { bestS = s; bestI = i; }
    }
    const l = remaining.splice(bestI, 1)[0]; // must buy a ranch round 0, no cash hoarding
    // the naive maximizer gets into a bidding war for the trophy outfit: the game's
    // first winner's-curse moment happens in the ranch market itself
    const paid = k === 'naive_roi'
      ? Math.min(Math.round(START_CASH * 0.99), Math.round(l.ask * 1.10)) : l.ask;
    bought[k] = { ...l, ask: paid };
  }
  const keys = Object.keys(ARCHETYPES);
  const ranches = keys.map(k => makeRanch(k, bought[k]));
  for (const r of ranches) {
    if (!DIAG.market[r.key]) DIAG.market[r.key] = { n: 0, herd: 0, ask: 0, left: 0, county: {} };
    const m = DIAG.market[r.key];
    m.n++; m.herd += r.herd; m.ask += r.ranchAsk; m.left += r.cash;
    m.county[r.county] = (m.county[r.county] || 0) + 1;
  }
  // resilience is judged on the OPERATION (herd value + operating cash flow), not the
  // bank account: an idle war chest is not a strategy for weathering drought
  for (const r of ranches) { r.cash0 = r.cash; r.peakEquity = equity(r, w) - r.cash0; r.eq0 = equity(r, w); }
  for (let y = 1; y <= YEARS; y++) {
    stepWorld(w);
    for (const r of ranches) decideYear(r, w);
    auctionYear(ranches, w, ledger);
    for (const r of ranches) {
      productionYear(r, w);
      const opEq = equity(r, w) - r.cash0;
      r.peakEquity = Math.max(r.peakEquity, opEq);
      r.maxDrawdown = Math.max(r.maxDrawdown, (r.peakEquity - opEq) / Math.max(300000, r.peakEquity));
    }
  }
  const scores = scoreGame(ranches, w);
  let win = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[win]) win = i;
  const sev = w.droughtHist.filter(d => d === 'severe').length;
  const f = avg(w.feederHist);
  const worldType = sev >= 2 ? 'droughtHeavy' : f > 1.12 ? 'boom' : f < 0.98 ? 'soft' : 'stable';
  return { winner: ranches[win].key, worldType,
           spend: ranches.map(r => ({ key: r.key, probe: !!r.a.probe,
                                      spend: r.bulls.reduce((s, b) => s + b.paid, 0) / (r.eq0 || 1),
                                      won: ranches[win].key === r.key })) };
}

// ==========================================================================
// Browser export block (appended by make-engine.js; do not hand-edit engine.js)
// Everything the multiplayer UI needs from the engine lives here.
// ==========================================================================
if (typeof window !== 'undefined') {
  window.RanchEngine = {
    REGIONS,
    COUNTIES,
    ARCHETYPES,
    TIER,
    SIRES,
    TECHS,
    UNLOCKS,
    SEMEN,
    dollarBeef,
    makeSemenCatalog,
    buySemen,
    DROUGHT_T,
    SHOCKS,
    TRAITS,
    START_CASH,
    LAND_MULT,
    LANDCAP_R,
    YEARS,
    BULLS_PER_YEAR,
    makeListings,
    BUY_POLICY,
    makeRanch,
    makeBull,
    bullEstValue,
    bullCoverage,
    bullYearValue,
    newWorld,
    stepWorld,
    droughtSeverity,
    decideYear,
    auctionYear,
    productionYear,
    scoreGame,
    computeKpis,
    equity,
    clamp,
    gauss,
    pick,
    wpick,
    avg,
    median,
    cowCost,
    laborCost,
    calfCwt,
    playGame,
  };
} else if (typeof module !== 'undefined') {
  // Node.js (smoke-test.js uses this path)
  module.exports = {
    REGIONS,
    COUNTIES,
    ARCHETYPES,
    TIER,
    SIRES,
    TECHS,
    UNLOCKS,
    SEMEN,
    dollarBeef,
    makeSemenCatalog,
    buySemen,
    DROUGHT_T,
    SHOCKS,
    TRAITS,
    START_CASH,
    LAND_MULT,
    LANDCAP_R,
    YEARS,
    BULLS_PER_YEAR,
    makeListings,
    BUY_POLICY,
    makeRanch,
    makeBull,
    bullEstValue,
    bullCoverage,
    bullYearValue,
    newWorld,
    stepWorld,
    droughtSeverity,
    decideYear,
    auctionYear,
    productionYear,
    scoreGame,
    computeKpis,
    equity,
    clamp,
    gauss,
    pick,
    wpick,
    avg,
    median,
    cowCost,
    laborCost,
    calfCwt,
    playGame,
  };
}
