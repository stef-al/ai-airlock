import { evaluate, loadFixtures, pct, precision, recall, type Counts, type Evaluation } from '../tests/harness';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const details = args.includes('--details');
const only = args.find((a) => a.startsWith('--set='))?.slice(6) as 'dev' | 'holdout' | undefined;
const all = loadFixtures();

const f = (n: number, w: number, d = 1) => n.toFixed(d).padStart(w);
function table(title: string, ev: Evaluation) {
  console.log(`\n${title}`);
  const head = (first: string) => `${first.padEnd(24)} ${'exp'.padStart(4)} ${'hits'.padStart(5)} ${'TP'.padStart(4)} ${'FP'.padStart(4)} ${'FN'.padStart(4)} ${'prec%'.padStart(7)} ${'recall%'.padStart(8)} ${'exact%'.padStart(7)}`;
  const row = (name: string, c: Counts, hasExp = true, hasPrec = true) =>
    `${name.padEnd(24)} ${hasExp ? String(c.expected).padStart(4) : '   -'} ${hasPrec ? String(c.hits).padStart(5) : '    -'} ${String(c.tp).padStart(4)} ${hasPrec ? String(c.fp).padStart(4) : '   -'} ${hasExp ? String(c.fn).padStart(4) : '   -'} ${hasPrec ? f(precision(c), 7) : '      -'} ${hasExp ? f(recall(c), 8) : '       -'} ${hasPrec ? f(pct(c.exact, c.tp), 7, 0) : '      -'}`;
  console.log(head('category'));
  for (const [k, c] of Object.entries(ev.byCategory).sort()) console.log(row(k, c));
  console.log(head('detector (hits it produced)'));
  for (const [k, c] of Object.entries(ev.byDetector).sort()) console.log(row(k, c, false));
  console.log(head('expected type'));
  for (const [k, c] of Object.entries(ev.byType).sort()) if (c.expected) console.log(row(k, c, true, false));
  console.log(row('TOTAL', ev.total));
}

const sets: ['dev' | 'holdout' | 'all', typeof all][] = [];
if (!only || only === 'dev') sets.push(['dev', all.filter((x) => x.set === 'dev')]);
if (!only || only === 'holdout') sets.push(['holdout', all.filter((x) => x.set === 'holdout')]);
if (!only) sets.push(['all', all]);

let missed = false;
for (const [name, fx] of sets) {
  const ev = evaluate(fx);
  table(`== ${name} set (${fx.length} fixtures) ==`, ev);
  if (details) for (const d of ev.details) console.log(`  ${d.kind} ${d.fixture}:${d.line} ${d.type} ${JSON.stringify(d.text)}${d.reason ? '  <- ' + d.reason : ''}`);
  const s = ev.byCategory.secret;
  const ok = !!s && recall(s) >= 95 && precision(s) >= 90;
  console.log(`secrets target (recall>=95, precision>=90): ${ok ? 'MET' : 'MISSED'}`);
  if (!ok && name === 'all') missed = true;
}
if (strict && missed) process.exit(1);
