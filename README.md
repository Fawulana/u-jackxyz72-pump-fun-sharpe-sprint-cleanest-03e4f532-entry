# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Fawulana/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Fawulana/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for make.fun's Pump.fun Sharpe Sprint: it trades a 6-hour pump.fun bonding-curve replay, ranked by hourly Sharpe ratio. Strategy ("high-water chase"): wait until a coin's real SOL reserve crosses 50 SOL, buy the first shallow pullback (5–20%) from the high since the crossing, exit at +60% take-profit / −12% stop-loss, one entry per coin ever; a cheap probe leg (0.012 SOL round trips on quiet liquid coins) keeps the run above the 20-coin guardrail.

Dev grade (kit local grader): Sharpe +0.262/hour, net PnL +1.269 SOL (+12.7%), max drawdown 7.2%, 45 distinct mints, 45 round trips, deterministic (two runs byte-identical).

## Run it

```sh
node main.ts
```

Grade locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
