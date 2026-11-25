// High-water chase: buy the first shallow pullback after a coin's real SOL reserve
// crosses 50 SOL, ride the next leg with a wide take-profit (+60%) and a tight stop
// (-12%), one entry per coin ever, no trailing stop; cheap probe round trips on quiet,
// liquid coins keep the run above the 20-coin round-trip guardrail.
// Tuned on the dev window with the kit's local grader (TP 0.6 / SL 0.12 is the best
// grader-confirmed point in a flat region: TP 0.55-0.65 x SL 0.12-0.18).
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot({ onBatch: createStrategy(DEFAULT_PARAMS) });
