// The program the harness runs (node /bot/main.ts, Node 22): reads every case from /input/cases.json, answers each
// with solve.js and writes /output/answers.json, one answer per case in order. Each answer is written as the JSON text
// solve.js renders directly (runJson), the same value JSON.stringify(run(input)) gives. MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output outside the sandbox.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { runJson } = (await import(new URL('./solve.js', import.meta.url).href)) as { runJson: (input: unknown) => string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(`${inDir}/cases.json`, 'utf8')) as { id: string; input: unknown }[];
let text = '[';
for (let i = 0; i < cases.length; i++) text += (i === 0 ? '' : ',') + runJson(cases[i].input);
writeFileSync(`${outDir}/answers.json`, `${text}]`);
