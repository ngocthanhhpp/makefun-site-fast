# makefun-site-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ngocthanhhpp/makefun-site-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ngocthanhhpp/makefun-site-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0's build: `run(input)` in `solve.js` returns the same output tree, byte for byte, about 2.8 times faster in CPU time on the practice set. Plain JavaScript for Node 22, no dependencies.

How it gets there, all with the same rules as the reference (front matter, Markdown subset, template dialect, slugs, report):

- Markdown inline text is HTML-escaped once per block with native string operations, then parsed; plain runs are found with a native regex search instead of a per-character loop.
- Templates are compiled to closures, and every `for` and `include` is memoised on the values of the free names it reads, so a tag cloud, a "recent posts" strip or a post's card is rendered once per build instead of once per page.
- Each answer is rendered straight into JSON-escaped text (`runJson`), so repeated fragments are JSON-escaped once rather than on every page by `JSON.stringify`.
- Slugs, long dates and link targets are memoised; hot paths avoid out-of-bounds reads and other deoptimisations.
- `main.ts` turns V8's Maglev tier on and holds TurboFan back: on a run this short, TurboFan's compile time costs more CPU than its faster code saves.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=nr0fkn76&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
