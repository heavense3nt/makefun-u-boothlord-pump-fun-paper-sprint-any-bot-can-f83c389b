// Fresh-launch scalper for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Idea: buy VERY early — within the first 30 slots of a launch — when the
// first tape already shows several different (non-creator) buyers putting
// real SOL in and the price has not run away yet. Then scale out: sell half
// at +15%, let the rest ride to +150% (or out on the trailing stop), and cut
// everything at −10%, on a rug-sized sell, or after 400 slots. One entry per
// curve, at most five open positions, fully deterministic: no clock, no
// randomness, no environment.
//
// All amounts are lamports (bigint). Prices are compared with integer
// cross-multiplication on the virtual reserves, never with floats.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---- entry tape thresholds -----------------------------------------------
const AGE_MIN_SLOTS = 1;
const AGE_MAX_SLOTS = 30;
const MIN_BUYS = 3;
const MIN_DISTINCT_BUYERS = 3;
const MIN_NET_INFLOW_LAMPORTS = 300_000_000n; // 0.3 SOL of net buying
const MIN_GAIN_BPS = 0; // price at or above creation (never buy a dump)
const MAX_GAIN_BPS = 1200; // ... but not more than +12% hot already
const MAX_TOP_BUYER_BPS = 5000; // largest single buyer <= 50% of buy flow
const MIN_REAL_SOL_LAMPORTS = 1_000_000_000n; // 1 SOL
const MAX_REAL_SOL_LAMPORTS = 40_000_000_000n; // 40 SOL

// ---- sizing ----------------------------------------------------------------
const FIRST_BUY_LAMPORTS = 50_000_000n; // 0.05 SOL
const MAX_STAKE_LAMPORTS = 200_000_000n; // 0.20 SOL per mint
const MIN_ORDER_LAMPORTS = 10_000_000n; // 0.01 SOL (round-trip guardrail)
const MAX_ORDERS_PER_BATCH = 12;
const SLIPPAGE_BPS = 500;
const PYRAMID_PROFIT_BPS = 10_500; // pyramid only while the position is >= +5%

// ---- exits (all price-based, vs the entry price) ---------------------------
const PARTIAL_BPS = 11_500; // sell half at +15%
const FULL_BPS = 25_000; // sell the rest at +150%
const STOP_LOSS_BPS = 9_000; // sell all at -10%
const TRAIL_BPS = 9_000; // sell all at 90% of the peak price
const MAX_HOLD_SLOTS = 400;
const RUG_SELL_LAMPORTS = 2_000_000_000n; // one sell >= 2 SOL in a batch

interface Tape {
  mint: string;
  createdSlot: number;
  /** The curve's creator: their own buys don't count as dispersed demand. */
  creator: string;
  /** Creation price as virtual quote / virtual token (numerator / denominator). */
  createQuote: bigint;
  createToken: bigint;
  buys: number;
  sells: number;
  buySol: bigint;
  sellSol: bigint;
  buyers: Map<string, bigint>;
  entered: boolean;
  entrySlot: number;
  /** Virtual reserves at the moment the first buy was sent (entry price). */
  entryQuote: bigint;
  entryToken: bigint;
  /** Peak price seen since entry, as virtual quote / virtual token. */
  peakQuote: bigint;
  peakToken: bigint;
  /** Whether the +15% half has been sold already. */
  partialTaken: boolean;
}

export class Scalper {
  private tapes = new Map<string, Tape>();

  /** Fold this batch's events into the per-mint tapes. Call once per batch, first. */
  fold(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let t = this.tapes.get(e.mint);
        if (t === undefined) {
          t = {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createQuote: BigInt(e.virtual_quote_reserves),
            createToken: BigInt(e.virtual_token_reserves),
            buys: 0,
            sells: 0,
            buySol: 0n,
            sellSol: 0n,
            buyers: new Map(),
            entered: false,
            entrySlot: -1,
            entryQuote: 0n,
            entryToken: 0n,
            peakQuote: 0n,
            peakToken: 0n,
            partialTaken: false,
          };
          this.tapes.set(e.mint, t);
        }
      } else if (e.event === 'TradeEvent') {
        let t = this.tapes.get(e.mint);
        if (t === undefined) {
          // First seen through a trade: use its reserves as the creation price.
          t = {
            mint: e.mint,
            createdSlot: e.slot,
            creator: '',
            createQuote: BigInt(e.virtual_quote_reserves),
            createToken: BigInt(e.virtual_token_reserves),
            buys: 0,
            sells: 0,
            buySol: 0n,
            sellSol: 0n,
            buyers: new Map(),
            entered: false,
            entrySlot: -1,
            entryQuote: 0n,
            entryToken: 0n,
            peakQuote: 0n,
            peakToken: 0n,
            partialTaken: false,
          };
          this.tapes.set(e.mint, t);
        }
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          // The creator buying their own curve is not dispersed demand.
          if (e.user === t.creator) continue;
          t.buys += 1;
          t.buySol += sol;
          t.buyers.set(e.user, (t.buyers.get(e.user) ?? 0n) + sol);
        } else {
          t.sells += 1;
          t.sellSol += sol;
        }
      }
      // CompleteEvent: nothing to track; state.curves already marks it complete.
    }
  }

  /** Current mark-to-market value of a holding, in lamports, or null when unknown. */
  private valueOf(state: BotState, mint: string, tokens: bigint): bigint | null {
    const c = state.curves.get(mint);
    if (c === undefined || c.complete) return null;
    if (c.virtual_token_reserves <= 0n) return null;
    return (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
  }

  /** Price now >= creation price * (10000 + bps) / 10000, in integers. */
  private gainedAtLeast(state: BotState, t: Tape, bps: number): boolean {
    const c = state.curves.get(t.mint);
    if (c === undefined) return false;
    if (c.virtual_token_reserves <= 0n || t.createToken <= 0n) return false;
    // now/creation = (vqNow/vtNow) / (vqCreate/vtCreate)
    // >= (10000+bps)/10000  <=>  vqNow * vtCreate * 10000 >= (10000+bps) * vqCreate * vtNow
    const left = c.virtual_quote_reserves * t.createToken * 10_000n;
    const right = BigInt(10_000 + bps) * t.createQuote * c.virtual_token_reserves;
    return left >= right;
  }

  /** True when an order of this side for this mint is still in flight. */
  private pendingSide(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  /** Price now <= creation price * (10000 + bps) / 10000, in integers. */
  private gainedAtMost(state: BotState, t: Tape, bps: number): boolean {
    const c = state.curves.get(t.mint);
    if (c === undefined) return false;
    if (c.virtual_token_reserves <= 0n || t.createToken <= 0n) return false;
    const left = c.virtual_quote_reserves * t.createToken * 10_000n;
    const right = BigInt(10_000 + bps) * t.createQuote * c.virtual_token_reserves;
    return left <= right;
  }

  /** Current price vs a reference price (virtual reserves), in basis points:
   * 10000 = same price, 11500 = +15%, 9000 = -10%. Null when uncomputable. */
  private priceRatioBps(state: BotState, mint: string, refQ: bigint, refT: bigint): bigint | null {
    const c = state.curves.get(mint);
    if (c === undefined) return null;
    if (c.virtual_token_reserves <= 0n || refT <= 0n || refQ <= 0n) return null;
    return (c.virtual_quote_reserves * refT * 10_000n) / (c.virtual_token_reserves * refQ);
  }

  private tapeStrong(t: Tape): boolean {    if (t.buys < MIN_BUYS) return false;
    if (t.buyers.size < MIN_DISTINCT_BUYERS) return false;
    if (t.buySol - t.sellSol < MIN_NET_INFLOW_LAMPORTS) return false;
    if (t.buySol <= 0n) return false;
    let top = 0n;
    for (const v of t.buyers.values()) if (v > top) top = v;
    if ((top * 10_000n) / t.buySol > BigInt(MAX_TOP_BUYER_BPS)) return false;
    return true;
  }

  private entryEligible(state: BotState, t: Tape, slot: number): boolean {
    const age = slot - t.createdSlot;
    if (age < AGE_MIN_SLOTS || age > AGE_MAX_SLOTS) return false;
    if (t.entered) return false;
    const c = state.curves.get(t.mint);
    if (c === undefined || c.complete) return false;
    if (
      c.real_quote_reserves < MIN_REAL_SOL_LAMPORTS ||
      c.real_quote_reserves > MAX_REAL_SOL_LAMPORTS
    ) {
      return false;
    }
    if (!this.tapeStrong(t)) return false;
    if (!this.gainedAtLeast(state, t, MIN_GAIN_BPS)) return false;
    if (!this.gainedAtMost(state, t, MAX_GAIN_BPS)) return false;
    return true;
  }

  /** Decide this batch's orders. Exits first, then pyramids, then fresh entries. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    // SOL already committed by orders queued in this batch (freeCash only counts pending).
    let spent = 0n;
    const txFee = state.txFeeLamports();

    // Rug-sized sells seen in this batch, per mint.
    const rugMints = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'TradeEvent' && !e.is_buy && BigInt(e.sol_amount) >= RUG_SELL_LAMPORTS) {
        rugMints.add(e.mint);
      }
    }

    // ---- exits (price-based, vs the entry price) -------------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      const c = state.curves.get(mint);
      if (c === undefined || c.complete) continue;
      // A sell is already in flight for this mint: wait for its fill.
      if (this.pendingSide(state, mint, 'sell')) continue;
      const t = this.tapes.get(mint);
      if (t === undefined || t.entryQuote <= 0n || t.entryToken <= 0n) continue;
      // Track the peak price since entry (for the trailing stop).
      const vsPeakNow =
        t.peakToken === 0n ? null : this.priceRatioBps(state, mint, t.peakQuote, t.peakToken);
      if (vsPeakNow === null || vsPeakNow > 10_000n) {
        t.peakQuote = c.virtual_quote_reserves;
        t.peakToken = c.virtual_token_reserves;
      }
      const vsEntry = this.priceRatioBps(state, mint, t.entryQuote, t.entryToken);
      const vsPeak = this.priceRatioBps(state, mint, t.peakQuote, t.peakToken);
      if (vsEntry === null || vsPeak === null) continue;
      const tooOld = t.entrySlot >= 0 && slot - t.entrySlot >= MAX_HOLD_SLOTS;
      const rug = rugMints.has(mint);
      const fullExit =
        vsEntry >= BigInt(FULL_BPS) ||
        vsEntry <= BigInt(STOP_LOSS_BPS) ||
        vsPeak <= BigInt(TRAIL_BPS) ||
        tooOld ||
        rug;
      if (fullExit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      } else if (!t.partialTaken && vsEntry >= BigInt(PARTIAL_BPS)) {
        // Bank half at +15%; let the rest ride toward +150% or the trail.
        const half = pos.token_amount / 2n;
        if (half > 0n) {
          t.partialTaken = true;
          orders.push({
            side: 'sell',
            mint,
            token_amount: half,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
      }
    }

    // ---- pyramids + fresh entries -----------------------------------------
    if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
      for (const [mint, t] of this.tapes) {
        if (orders.length >= MAX_ORDERS_PER_BATCH) break;
        const c = state.curves.get(mint);
        if (c === undefined || c.complete) continue;
        const held = state.positions.get(mint);
        const age = slot - t.createdSlot;
        if (age < AGE_MIN_SLOTS || age > AGE_MAX_SLOTS) continue;
        if (!this.tapeStrong(t)) continue;
        if (!this.gainedAtLeast(state, t, MIN_GAIN_BPS)) continue;
        if (!this.gainedAtMost(state, t, MAX_GAIN_BPS)) continue;

        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) continue;
        // Free cash minus what this batch already queued (freeCash ignores it).
        const free = state.freeCashLamports() - txFee - spent;
        if (free < MIN_ORDER_LAMPORTS) continue;

        if (held !== undefined) {
          // Pyramid: top the stake up toward MAX_STAKE while the tape stays strong
          // AND the position is in profit — never add to a loser.
          // Never stack a second buy while one is still in flight (2-slot latency).
          if (this.pendingSide(state, mint, 'buy')) continue;
          const value = this.valueOf(state, mint, held.token_amount);
          if (value === null) continue;
          if ((value * 10_000n) / held.cost_lamports < BigInt(PYRAMID_PROFIT_BPS)) continue;
          const room = MAX_STAKE_LAMPORTS - held.cost_lamports;
          if (room < MIN_ORDER_LAMPORTS) continue;
          const amount = minBig(minBig(room, cap), free);
          if (amount < MIN_ORDER_LAMPORTS) continue;
          spent += amount + txFee;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        } else if (!t.entered) {
          if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) {
            continue;
          }
          if (
            c.real_quote_reserves < MIN_REAL_SOL_LAMPORTS ||
            c.real_quote_reserves > MAX_REAL_SOL_LAMPORTS
          ) {
            continue;
          }
          const amount = minBig(minBig(FIRST_BUY_LAMPORTS, cap), free);
          if (amount < MIN_ORDER_LAMPORTS) continue;
          t.entered = true;
          t.entrySlot = slot;
          t.entryQuote = c.virtual_quote_reserves;
          t.entryToken = c.virtual_token_reserves;
          t.peakQuote = c.virtual_quote_reserves;
          t.peakToken = c.virtual_token_reserves;
          t.partialTaken = false;
          spent += amount + txFee;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: amount,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
      }
    }

    return orders;
  }
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
