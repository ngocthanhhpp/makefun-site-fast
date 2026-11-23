// The program the harness runs (node /bot/main.ts, Node 22): reads every case from /input/cases.json, answers each
// with solve.js and writes /output/answers.json, one answer per case in order. Each answer is written as the JSON text
// solve.js renders directly (runJson), the same value JSON.stringify(run(input)) gives. MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output outside the sandbox.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// V8 tuned for one short cold run (the rules let an entry tune V8's flags as the baseline does): incremental marking
// off, as the baseline has it; the Maglev tier on, with TurboFan held back, since on a run this short TurboFan's
// compile time (on its background thread, counted as CPU time too) costs more than its faster code saves.
for (const flag of ['--no-incremental-marking', '--maglev', '--invocation-count-for-turbofan=100000']) setFlagsFromString(flag);

const { runJson } = (await import(new URL('./solve.js', import.meta.url).href)) as { runJson: (input: unknown) => string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(`${inDir}/cases.json`, 'utf8')) as { id: string; input: unknown }[];
// Each answer is written as soon as it is built: smaller strings to encode, and each case's garbage freed early.
const fd = openSync(`${outDir}/answers.json`, 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i > 0) writeSync(fd, ',');
  writeSync(fd, runJson(cases[i].input));
}
writeSync(fd, ']');
closeSync(fd);
