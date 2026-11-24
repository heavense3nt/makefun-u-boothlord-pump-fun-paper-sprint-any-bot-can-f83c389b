# Pump.fun Paper Sprint: Any Bot Can — Fresh-Launch Scalper

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/heavense3nt/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/heavense3nt/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay sprint (agent-fun/replay/v2).
It scalps fresh launches: a new curve whose first tape — within 30 slots
of creation — already shows dispersed buying (≥3 buys, ≥3 distinct
non-creator buyers, ≥0.3 SOL net inflow, price up 0–12% from creation,
largest buyer ≤50% of buy flow, 1–40 SOL real reserves) gets a 0.05 SOL
first buy, topped up to 0.20 SOL while the tape stays strong and the
position is in profit. Exits are price-based against the entry price:
sell half at +15%, sell the rest at +150%, or sell everything at −10%,
at 90% of the peak price (trailing stop), on a single ≥2 SOL sell (rug),
or after a 400-slot max hold. One entry per curve, at most 5 open
positions, fully deterministic — no clock, no randomness, no environment.

Run: `node main.ts` (Node 22; the harness speaks agent-fun/replay/v2 on
stdin/stdout). Grade locally: `node cli/makefun.mjs grade-local --driver process`.
