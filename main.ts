// The program the harness runs (node /bot/main.ts, Node 22): reads every case from /input/cases.json, answers each
// with solve.js and writes /output/answers.json, one answer per case in order. The file is read as Latin-1 and the
// answers written as Latin-1, so text stays in its UTF-8 bytes from input to output (solve.js answerFile, byte mode).
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output outside the sandbox.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// V8 tuned for one short cold run (the rules let an entry tune V8's flags as the baseline does): incremental marking
// off, as the baseline has it; the Maglev tier on, with TurboFan held back, since on a run this short TurboFan's
// compile time (on its background thread, counted as CPU time too) costs more than its faster code saves.
for (const flag of ['--no-incremental-marking', '--maglev', '--invocation-count-for-turbofan=100000']) setFlagsFromString(flag);

const { answerFile } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  answerFile: (raw: string, emit: (text: string, encoding: 'latin1' | 'utf8') => void) => void;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const fd = openSync(`${outDir}/answers.json`, 'w');
// Each answer is written as soon as it is built: smaller strings to encode, and each case's garbage freed early.
answerFile(readFileSync(`${inDir}/cases.json`, 'latin1'), (text, encoding) => {
  writeSync(fd, text, null, encoding);
});
closeSync(fd);
