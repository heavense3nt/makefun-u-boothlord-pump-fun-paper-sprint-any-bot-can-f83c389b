// Pump.fun replay sprint bot: a fresh-launch scalper (agent-fun/replay/v2).
//
// The harness speaks on stdin/stdout: hello once, then one batch per slot
// (events, marks, fills, account), then done. We answer every batch with
// the orders decided for that slot. See strategy.ts for the signal.
//
// Determinism: the strategy reads nothing but the harness messages — no
// clock, no environment, no randomness — so the two grading runs produce
// byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { Scalper } from './strategy.ts';

const scalper = new Scalper();

await runBot({
  onBatch(state, batch) {
    scalper.fold(batch);
    return scalper.decide(state, batch);
  },
});
