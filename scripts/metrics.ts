import { evaluate, loadFixtures, precision, recall, pct, type Counts, type Evaluation } from '../tests/harness';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const details = args.includes('--details');
const only = args.find((a) => a.startsWith('--set='))?.slice(6) as 'dev' | 'holdout' | undefined;
const all = loadFixtures();

function table(title: string, ev: Evaluation) {
  console.log(`\n${title}`);
  const row = (name: string, c: Counts) =>
    `${name.padEnd(22)} ${String(c.expected).padStart(4)} ${String(c.hits).padStart(5)} ${String(c.tp).padStart(4)} ${String(c.fp).padStart(4)} ${String(c.fn).padStart(4)}  ${precision(c).toFixed(1).padStart(6)}% ${recall(c).toFixed(1).padStart(6)}%  ${pct(c.exact, c.tp).toFixed(0).padStart(4)}%`;
  console.log(`${'category / detector'.padEnd(22)} ${'exp'.padStart(4)} ${'hits'.padStart(5)} ${'TP'.padStart(4)} ${'FP'.padStart(4)} ${'FN'.padStart(4)}  ${'prec'.padStart(7)} ${'recall'.padStart(7)}  exact`);
  for (const [k, c] of Object.entries(ev.byCategory).sort()) console.log(row(k, c));
  console.log('-- by detector (precision only meaningful) --');
  for (const [k, c] of Object.entries(ev.byDetector).sort()) console.log(row(k, c).replace(/ {2}\s*[\d.]+% (?= *\d)/, '  '));
  console.log(row('TOTAL', ev.total));
}

const sets: ['dev' | 'holdout' | 'all', typeof all][] = [];
if (!only || only === 'dev') sets.push(['dev', all.filter((f) => f.set === 'dev')]);
if (!only || only === 'holdout') sets.push(['holdout', all.filter((f) => f.set === 'holdout')]);
if (!only) sets.push(['all', all]);

let failed = false;
for (const [name, fx] of sets) {
  const ev = evaluate(fx);
  table(`== ${name} set (${fx.length} fixtures) ==`, ev);
  if (details) for (const d of ev.details) console.log(`  ${d.kind} ${d.fixture}:${d.line} ${d.type} ${JSON.stringify(d.text)}${d.reason ? '  <- ' + d.reason : ''}`);
  const s = ev.byCategory.secret;
  if (s && name !== 'dev' || (s && name === 'dev')) {
    const ok = recall(s) >= 95 && precision(s) >= 90;
    console.log(`secrets target (recall>=95, precision>=90): ${ok ? 'MET' : 'MISSED'}`);
    if (!ok && name === 'all') failed = true;
  }
}
if (strict && failed) process.exit(1);
