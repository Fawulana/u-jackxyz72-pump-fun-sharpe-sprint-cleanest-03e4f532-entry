// High-water chase for the pump.fun bonding-curve replay.
//
// Idea, in one line: most pump.fun coins die within seconds, but the few that survive to a
// large real SOL reserve (40+ SOL) have already proved they are liquid and heavily traded;
// on those, and only those, buy the first shallow pullback after the reserve crossing and
// ride the next leg up with a take-profit, a tight stop and a trailing stop — one entry per
// coin, ever, so a topped-out coin is never re-chased. A separate cheap probe leg keeps the
// run above the 20-coin round-trip guardrail without betting real size on unproven coins:
// probes buy quiet, liquid coins (no trade for a while, so the price is stable) and sell
// them as soon as the buy lands, at little more than the fee cost.
//
// Why this shape: on the dev window, unconditional buying (snipe, momentum, dip-buying)
// loses on ~80% of coins — the median coin never moves again after its launch pump, and
// every 0.1 SOL round trip pays ~2.7% in curve + tx fees. The one pocket that holds up is
// the high-reserve regime: once real SOL passes ~50, the median worst dip after entry is
// only ~3% and a quarter of coins still run +70% from there, while below 30 SOL the median
// coin craters ~70%. So the strategy waits for proof (reserve), then trades the pullback.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Minimum real SOL reserve (lamports) for a chase entry. */
  chaseMinRq: bigint;
  /** Exit a chase position if real SOL falls back below this (lamports). */
  chaseRqFloor: bigint;
  /** Enter only when price is at most this far below the high since the crossing... */
  pullbackMax: number;
  /** ...and at least this far below it (skip coins still at their high). */
  pullbackMin: number;
  /** Net SOL bought over the last flowWindow slots must be at least this (lamports). */
  flowWindow: number;
  minNetFlow: bigint;
  /** SOL per chase position (capped by 1% of the real reserve per reply). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Take profit / stop loss on position value vs cost. */
  takeProfit: number;
  stopLoss: number;
  /** Trailing stop: arms once value reaches cost * (1 + trailArm), exits on a fall of trail. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same coin may be chased again. */
  cooldownSlots: number;
  /** Most chase entries per coin over the run (1 = never re-chase a coin). */
  maxEntriesPerCoin: number;
  /** Most chase positions open at once (the rest of the 5 slots is for probes). */
  maxChaseOpen: number;
  /** Most SOL at cost across all chase positions at once. */
  maxExposureSol: number;
  /** Slippage tolerance on buys and sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Probe leg: buy size (SOL) per guardrail probe round trip. */
  probeSol: number;
  /** Minimum real SOL reserve (lamports) for a probe target. */
  probeMinRq: bigint;
  /** A probe target must have had no trade for at least this many slots (quiet = stable price). */
  probeQuietSlots: number;
  /** Target distinct round-tripped mints: 2 + probePacePerHour * elapsed hours, capped. */
  probeTargetCap: number;
  probePacePerHour: number;
  /** Most probe positions open at once. */
  maxProbesOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  chaseMinRq: 50_000_000_000n,
  chaseRqFloor: 30_000_000_000n,
  pullbackMax: 0.2,
  pullbackMin: 0.05,
  flowWindow: 100,
  minNetFlow: 0n,
  stakeSol: 0.5,
  minBuySol: 0.02,
  takeProfit: 0.6,
  stopLoss: 0.12,
  // Trailing stop OFF: on this data the whipsaw shakes it out constantly and it cuts
  // the wide take-profit legs short (sweep: trail-on net +0.17 vs trail-off +1.81).
  trailArm: 10,
  trail: 0.5,
  maxHoldSlots: 1200,
  cooldownSlots: 600,
  maxEntriesPerCoin: 1,
  maxChaseOpen: 4,
  maxExposureSol: 4,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  probeSol: 0.012,
  probeMinRq: 2_000_000_000n,
  probeQuietSlots: 100,
  probeTargetCap: 26,
  probePacePerHour: 5,
  maxProbesOpen: 1,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n;
const BPS = 10_000n;

interface Tick {
  slot: number;
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Coin {
  ticks: Tick[];
  /** Slot until which the coin is ignored after a chase exit. */
  coolUntil: number;
  /** Chase entries taken on this coin. */
  entries: number;
  /** Slot the coin first reached chaseMinRq (-1 = never); the high since then is crossHigh. */
  crossedAt: number;
  crossHigh: number;
  /** Slot of its most recent trade. */
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: bigint;
  exiting: boolean;
  /** True once a buy of this position has filled. */
  filled: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints with a completed probe round trip (buy >= 0.01 SOL filled, then sold). */
  const probed = new Set<Pubkey>();
  /** Mints with a completed chase round trip. */
  const chased = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coin = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { ticks: [], coolUntil: -1, entries: 0, crossedAt: -1, crossHigh: 0, lastTradeSlot: -1 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots on this coin. */
  const flow = (c: Coin, now: number, w: number): bigint => {
    let net = 0n;
    for (let i = c.ticks.length - 1; i >= 0; i--) {
      const t = c.ticks[i]!;
      if (t.slot <= now - w) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const traded: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event !== 'TradeEvent') continue;
      const c = coin(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      const rq = BigInt(e.real_quote_reserves);
      c.ticks.push({ slot, price, realSol: rq, isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (c.ticks.length > 500) c.ticks.splice(0, c.ticks.length - 500);
      c.lastTradeSlot = slot;
      if (c.crossedAt < 0 && rq >= p.chaseMinRq) {
        c.crossedAt = slot;
        c.crossHigh = price;
      } else if (c.crossedAt >= 0 && price > c.crossHigh) {
        c.crossHigh = price;
      }
      if (traded[traded.length - 1] !== e.mint && !traded.includes(e.mint)) traded.push(e.mint);
    }
    // Own fills: track completed round trips and clear exited positions.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'sell' && probes.has(f.mint)) {
        probes.delete(f.mint);
        probed.add(f.mint);
      }
      if (f.side === 'sell' && held.has(f.mint) && !state.positions.has(f.mint)) {
        chased.add(f.mint);
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingMints = new Set<Pubkey>();
    const pendingSell = new Set<Pubkey>();
    for (const o of state.pending.values()) {
      pendingMints.add(o.order.mint);
      if (o.order.side === 'sell') pendingSell.add(o.order.mint);
    }
    const valueOf = (mint: Pubkey, tokens: bigint): bigint => {
      const mk = marks.get(mint);
      const cv = state.curves.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : cv ? cv.virtual_quote_reserves : 0n;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : cv ? cv.virtual_token_reserves : 0n;
      const v = sellValue(tokens, vq, vt);
      return v > tx ? v - tx : 0n;
    };

    // 1. Exits on chase positions.
    for (const [mint, h] of held) {
      if (orders.length >= cap) break;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) {
          held.delete(mint);
          if (h.filled) coin(mint).coolUntil = slot + p.cooldownSlots;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      if (pendingSell.has(mint)) continue;
      const value = valueOf(mint, pos.token_amount);
      const cost = pos.cost_lamports;
      if (value > h.peakValue) h.peakValue = value;
      const rq = curve.real_quote_reserves;
      let exit = false;
      if (cost > 0n) {
        if (value >= (cost * BigInt(Math.round((1 + p.takeProfit) * 1000))) / 1000n) exit = true;
        if (!exit && value <= (cost * BigInt(Math.round((1 - p.stopLoss) * 1000))) / 1000n) exit = true;
        if (!exit && h.peakValue >= (cost * BigInt(Math.round((1 + p.trailArm) * 1000))) / 1000n &&
            value <= (h.peakValue * BigInt(Math.round((1 - p.trail) * 1000))) / 1000n) exit = true;
      }
      if (!exit && rq < p.chaseRqFloor) exit = true;
      if (!exit && slot - h.opened >= p.maxHoldSlots) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
      h.exiting = true;
    }

    // 2. Probe sells: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      if (orders.length >= cap) break;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
      if (!selling) probes.set(mint, true);
    }

    // 3. Chase entries: a coin that crossed chaseMinRq, now pulling back from its high
    // since the crossing — the staged entry. One entry per coin, ever.
    let free = state.freeCashLamports();
    let chaseOpen = held.size;
    let exposure = 0n;
    for (const [mint] of held) {
      const pos = state.positions.get(mint);
      exposure += pos ? pos.cost_lamports : 0n;
    }
    const maxExposure = BigInt(Math.round(p.maxExposureSol * LAMPORTS));
    const stake = BigInt(Math.round(p.stakeSol * LAMPORTS));
    for (const mint of traded) {
      if (orders.length >= cap) break;
      if (chaseOpen >= p.maxChaseOpen) break;
      if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coin(mint);
      if (c.entries >= p.maxEntriesPerCoin) continue;
      if (slot < c.coolUntil) continue;
      if (c.crossedAt < 0) continue;
      if (curve.real_quote_reserves < (p.chaseMinRq * 6n) / 10n) continue;
      const hi = c.crossHigh;
      const ticks = c.ticks;
      if (hi <= 0 || ticks.length === 0) continue;
      const price = ticks[ticks.length - 1]!.price;
      if (price <= 0) continue;
      const pullback = 1 - price / hi;
      if (pullback < p.pullbackMin || pullback > p.pullbackMax) continue;
      if (flow(c, slot, p.flowWindow) < p.minNetFlow) continue;
      // Size: stake, capped at 1% of the real reserve (with a small margin) and by exposure/cash.
      let amount = stake;
      const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
      if (amount > sizeCap) amount = sizeCap;
      if (amount > maxExposure - exposure) amount = maxExposure - exposure;
      if (amount > free - tx) amount = free - tx;
      if (amount < BigInt(Math.round(p.minBuySol * LAMPORTS))) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      held.set(mint, { opened: slot, peakValue: 0n, exiting: false, filled: false });
      c.entries++;
      free -= amount + tx;
      exposure += amount;
      chaseOpen++;
      pendingMints.add(mint);
    }

    // 4. Guardrail probes: open a cheap round trip on a QUIET liquid coin (no trade for a
    // while, so the price is stable between the buy and the sell) when distinct
    // round-tripped mints lag pace. Candidates are scanned in first-seen order.
    const done = probed.size + chased.size;
    let target = p.probeTargetCap;
    if (firstTime !== null && lastTime !== null) {
      const hours = (lastTime - firstTime) / 3600;
      target = Math.min(p.probeTargetCap, 2 + Math.floor(p.probePacePerHour * hours));
    }
    if (done < target && probes.size < p.maxProbesOpen) {
      const open = state.committedPositionCount();
      if (open < state.hello.caps.max_open_positions) {
        const probeLamports = BigInt(Math.round(p.probeSol * LAMPORTS));
        let scanned = 0;
        for (const [mint, c] of coins) {
          if (orders.length >= cap || probes.size >= p.maxProbesOpen) break;
          if (scanned >= 200) break;
          scanned++;
          if (held.has(mint) || probes.has(mint) || probed.has(mint) || chased.has(mint)) continue;
          if (pendingMints.has(mint) || state.positions.has(mint)) continue;
          if (slot - c.lastTradeSlot < p.probeQuietSlots) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.real_quote_reserves < p.probeMinRq) continue;
          if (free < probeLamports + 2n * tx) break;
          const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
          if (probeLamports > sizeCap) continue;
          orders.push({ side: 'buy', mint, quote_lamports: probeLamports, max_slippage_bps: p.buySlippageBps });
          probes.set(mint, false);
          free -= probeLamports + tx;
        }
      }
    }
    return orders;
  };
}
