import type { Lang, Pair } from '../types';
import { SegBuilder } from '../util';
import type { Part } from './part';

/**
 * Linear, config-driven lexer for the supported languages. It only needs to separate comments,
 * string literals, numbers, identifiers and structure; it is deliberately not a parser.
 */

type TK = 'id' | 'kw' | 'str' | 'num' | 'com' | 'op' | 'var' | 'qid';
interface Tok {
  k: TK;
  s: number;
  e: number;
  /** content range for strings */
  cs?: number;
  ce?: number;
  q?: string;
  bare?: boolean;
  /** text for ops / ids */
  t: string;
}

const kw = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const KW: Record<string, Set<string>> = {
  js: kw(`break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while with yield async await static get set type interface implements private public protected readonly declare namespace abstract as from`),
  python: kw(`False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self`),
  java: kw(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record`),
  csharp: kw(`abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await get set value`),
  go: kw(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil`),
  php: kw(`abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null`),
  sql: kw(`select from where and or not insert into values update set delete create alter drop table index view database schema user role login grant revoke on to with as join left right inner outer full cross union all distinct group by order having limit offset case when then else end null is in like between exists primary key foreign references default constraint unique check identified password begin commit rollback transaction procedure function trigger declare if while return exec execute use top into set going`),
  powershell: kw(`begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while true false null`),
};

interface Spec {
  line: string[];
  block: [string, string][];
  ci?: boolean;
  dollarVar?: boolean;
  regex?: boolean;
  sqlLike?: boolean;
  py?: boolean;
  cs?: boolean;
  php?: boolean;
  go?: boolean;
  ps?: boolean;
  java?: boolean;
  tpl?: boolean;
}

const SPEC: Record<string, Spec> = {
  js: { line: ['//'], block: [['/*', '*/']], regex: true, tpl: true },
  python: { line: ['#'], block: [], py: true },
  java: { line: ['//'], block: [['/*', '*/']], java: true },
  csharp: { line: ['//'], block: [['/*', '*/']], cs: true },
  go: { line: ['//'], block: [['/*', '*/']], go: true },
  php: { line: ['//', '#'], block: [['/*', '*/']], dollarVar: true, php: true },
  sql: { line: ['--', '#'], block: [['/*', '*/']], ci: true, sqlLike: true },
  powershell: { line: ['#'], block: [['<#', '#>']], ci: true, dollarVar: true, ps: true },
};

const KV_CALLS = new Set('define putenv setenv setproperty setdefault ini_set setitem setattribute setparameter setstring setvalue put set add setconfig setenvironmentvariable update_option setdefaultvalue config write_setting'.split(' '));
const OPS = /^(?:===|!==|\?\?=|\|\|=|&&=|\*\*=|<<=|>>=|\.\.\.|=>|->|:=|==|!=|<>|<=|>=|\+=|-=|\*=|\/=|%=|&&|\|\||\?\?|::|\+\+|--|<-|=~|!~)/;
const ASSIGN = new Set(['=', ':=', ':', '=>', '->', '==', '===', '!=', '!==', '+=', '||=', '??=', '<-', '=~']);

function lexGeneric(text: string, lang: Lang): Tok[] {
  const sp = SPEC[lang === 'ts' ? 'js' : lang];
  const kws = KW[lang === 'ts' ? 'js' : lang];
  const n = text.length;
  const toks: Tok[] = [];
  let i = 0;
  const push = (k: TK, s: number, e: number, extra?: Partial<Tok>) =>
    toks.push({ k, s, e, t: k === 'op' || k === 'id' || k === 'kw' || k === 'var' ? text.slice(s, e) : '', ...extra });
  const lastSig = () => toks[toks.length - 1];

  /** scan a quoted string whose opening quote is at `qi`; returns index after the closing quote. */
  const scanQuoted = (qi: number, q: string, mode: 'esc' | 'dbl' | 'raw' | 'both', startTok: number): number => {
    let j = qi + 1;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\' && (mode === 'esc' || mode === 'both')) {
        j += 2;
        continue;
      }
      if (ch === q) {
        if ((mode === 'dbl' || mode === 'both') && text[j + 1] === q) {
          j += 2;
          continue;
        }
        push('str', startTok, j + 1, { cs: qi + 1, ce: j, q });
        return j + 1;
      }
      if (ch === '\n' && mode !== 'raw' && q !== '`' && !sp.sqlLike && !sp.ps && !sp.php && !sp.cs) break;
      j++;
    }
    // unterminated: take to end of line
    let e = text.indexOf('\n', qi);
    if (e < 0) e = n;
    push('str', startTok, e, { cs: qi + 1, ce: e, q });
    return e;
  };

  const scanTriple = (qi: number, q: string, startTok: number): number => {
    const close = text.indexOf(q.repeat(3), qi + 3);
    const ce = close < 0 ? n : close;
    push('str', startTok, close < 0 ? n : close + 3, { cs: qi + 3, ce, q: q.repeat(3) });
    return close < 0 ? n : close + 3;
  };

  const scanTemplate = (qi: number): number => {
    let j = qi + 1;
    let partStart = j;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') {
        push('str', partStart === qi + 1 ? qi : partStart, j + 1, { cs: partStart, ce: j, q: '`' });
        return j + 1;
      }
      if (ch === '$' && text[j + 1] === '{') {
        if (j > partStart) push('str', partStart, j, { cs: partStart, ce: j, q: '`' });
        let depth = 1;
        let k = j + 2;
        while (k < n && depth > 0) {
          const c2 = text[k];
          if (c2 === '{') depth++;
          else if (c2 === '}') depth--;
          else if (c2 === '"' || c2 === "'") {
            const e = text.indexOf(c2, k + 1);
            k = e < 0 ? n : e;
          }
          k++;
        }
        push('op', j, k, { t: '${}' });
        j = k;
        partStart = j;
        continue;
      }
      j++;
    }
    push('str', qi, n, { cs: qi + 1, ce: n, q: '`' });
    return n;
  };

  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // comments
    let handled = false;
    for (const m of sp.line) {
      if (text.startsWith(m, i)) {
        if (sp.php && m === '#' && text[i + 1] === '[') continue;
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        if (text[e - 1] === '\r') e--;
        push('com', i, e);
        i = e;
        handled = true;
        break;
      }
    }
    if (handled) continue;
    for (const [o, cl] of sp.block) {
      if (text.startsWith(o, i)) {
        const e = text.indexOf(cl, i + o.length);
        const end = e < 0 ? n : e + cl.length;
        push('com', i, end);
        i = end;
        handled = true;
        break;
      }
    }
    if (handled) continue;

    // PHP heredoc / nowdoc
    if (sp.php && text.startsWith('<<<', i)) {
      const m = /^<<<\s*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(text.slice(i, i + 80));
      if (m) {
        const bodyStart = i + m[0].length;
        const re = new RegExp('^[ \\t]*' + m[2] + '\\b', 'm');
        const rest = text.slice(bodyStart);
        const mm = re.exec(rest);
        const bodyEnd = mm ? bodyStart + mm.index : n;
        push('str', i, bodyEnd, { cs: bodyStart, ce: bodyEnd, q: 'heredoc' });
        i = bodyEnd;
        continue;
      }
    }
    // PowerShell here-strings
    if (sp.ps && (text.startsWith('@"', i) || text.startsWith("@'", i)) && /[\r\n]/.test(text[i + 2] ?? '')) {
      const q = text[i + 1];
      const e = text.indexOf('\n' + q + '@', i + 2);
      const ce = e < 0 ? n : e;
      push('str', i, e < 0 ? n : e + 3, { cs: i + 2, ce, q: 'heredoc' });
      i = e < 0 ? n : e + 3;
      continue;
    }
    // C# verbatim / interpolated prefixes
    if (sp.cs && (c === '@' || c === '$') && /^[@$]{1,2}"/.test(text.slice(i, i + 3))) {
      let j = i;
      let verbatim = false;
      while (text[j] === '@' || text[j] === '$') {
        if (text[j] === '@') verbatim = true;
        j++;
      }
      i = scanQuoted(j, '"', verbatim ? 'dbl' : 'esc', i);
      continue;
    }
    // Python string prefixes
    if (sp.py && /[rRbBuUfF]/.test(c)) {
      const m = /^(?:[rR][bBfF]?|[bB][rR]?|[fF][rR]?|[uU])(?=['"])/.exec(text.slice(i, i + 3));
      if (m) {
        const qi = i + m[0].length;
        const q = text[qi];
        if (text.startsWith(q.repeat(3), qi)) i = scanTriple(qi, q, i);
        else i = scanQuoted(qi, q, /[rR]/.test(m[0]) ? 'raw' : 'esc', i);
        continue;
      }
    }
    // strings
    if (c === '"' || c === "'" || c === '`') {
      if ((sp.py || sp.java || sp.cs) && c !== '`' && text.startsWith(c.repeat(3), i) && (sp.py || c === '"')) {
        i = scanTriple(i, c, i);
        continue;
      }
      if (c === '`') {
        if (sp.tpl) i = scanTemplate(i);
        else if (sp.go) i = scanQuoted(i, '`', 'raw', i);
        else if (sp.sqlLike) {
          const e = text.indexOf('`', i + 1);
          const end = e < 0 ? n : e;
          push('qid', i, e < 0 ? n : e + 1, { cs: i + 1, ce: end });
          i = e < 0 ? n : e + 1;
        } else if (sp.ps) {
          i++; // escape char; ignore
        } else i++;
        continue;
      }
      if (sp.sqlLike) {
        if (c === '"') {
          const e = text.indexOf('"', i + 1);
          const end = e < 0 ? n : e;
          push('qid', i, e < 0 ? n : e + 1, { cs: i + 1, ce: end });
          i = e < 0 ? n : e + 1;
        } else i = scanQuoted(i, "'", /^[eE]$/.test(text[i - 1] ?? '') ? 'both' : 'dbl', i);
        continue;
      }
      if (sp.ps) {
        i = scanQuoted(i, c, 'dbl', i);
        continue;
      }
      i = scanQuoted(i, c, 'esc', i);
      continue;
    }
    // SQL bracket identifiers [name]
    if (sp.sqlLike && c === '[') {
      const m = /^\[([A-Za-z_][\w $#@.]*)\]/.exec(text.slice(i, i + 80));
      if (m) {
        push('qid', i, i + m[0].length, { cs: i + 1, ce: i + m[0].length - 1 });
        i += m[0].length;
        continue;
      }
    }
    // numbers
    if (c >= '0' && c <= '9') {
      const m = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,2}/.exec(text.slice(i, i + 40));
      const len = m ? m[0].length : 1;
      push('num', i, i + len);
      i += len;
      continue;
    }
    // variables
    if (sp.dollarVar && c === '$') {
      const m = /^\$(?:\{[^}\n]{1,80}\}|(?:\w+:)?\w+)/.exec(text.slice(i, i + 100));
      if (m) {
        push('var', i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    // identifiers
    if (/[A-Za-z_$À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$À-￿]/.test(text[j])) j++;
      if (sp.ps) while (j < n && text[j] === '-' && /[A-Za-z]/.test(text[j + 1] ?? '')) {
        j++;
        while (j < n && /\w/.test(text[j])) j++;
      }
      const word = text.slice(i, j);
      const isKw = (sp.ci ? kws.has(word.toLowerCase()) : kws.has(word));
      push(isKw ? 'kw' : 'id', i, j);
      i = j;
      continue;
    }
    // regex literal (JS)
    if (sp.regex && c === '/') {
      const prev = lastSig();
      const regexOk =
        !prev ||
        (prev.k === 'op' && !/^[)\]}]$/.test(prev.t) && prev.t !== '${}') ||
        (prev.k === 'kw' && /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prev.t));
      if (regexOk) {
        let j = i + 1;
        let inCls = false;
        let ok = false;
        while (j < n && text[j] !== '\n') {
          if (text[j] === '\\') {
            j += 2;
            continue;
          }
          if (text[j] === '[') inCls = true;
          else if (text[j] === ']') inCls = false;
          else if (text[j] === '/' && !inCls) {
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          j++;
          while (j < n && /[a-z]/.test(text[j])) j++;
          push('op', i, j, { t: '/re/' });
          i = j;
          continue;
        }
      }
    }
    // operators
    const om = OPS.exec(text.slice(i, i + 4));
    const len = om ? om[0].length : 1;
    push('op', i, i + len);
    i += len;
  }
  return toks;
}

// ---------------------------------------------------------------------------------------------
// shell (bash/sh/zsh) lexer: words, flags, assignments, heredocs
// ---------------------------------------------------------------------------------------------

const SH_KW = kw(`if then else elif fi for while until do done case esac in function select time export local declare readonly typeset unset set`);
const SH_CMD_START = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', 'time']);

function lexShell(text: string): Tok[] {
  const n = text.length;
  const toks: Tok[] = [];
  let i = 0;
  let cmdStart = true;
  const pendingHeredocs: { id: string; dash: boolean }[] = [];
  const push = (k: TK, s: number, e: number, extra?: Partial<Tok>) => toks.push({ k, s, e, t: text.slice(s, e), ...extra });

  const readWordParts = (start: number): number => {
    // reads one shell word, emitting str tokens for literal pieces, returns end index
    let j = start;
    let litStart = j;
    const flush = (end: number) => {
      if (end > litStart) push('str', litStart, end, { cs: litStart, ce: end, q: '', bare: true });
    };
    while (j < n) {
      const ch = text[j];
      if (/[\s;|&<>()]/.test(ch)) break;
      if (ch === "'") {
        flush(j);
        const e = text.indexOf("'", j + 1);
        const end = e < 0 ? n : e;
        push('str', j, e < 0 ? n : e + 1, { cs: j + 1, ce: end, q: "'" });
        j = e < 0 ? n : e + 1;
        litStart = j;
        continue;
      }
      if (ch === '"') {
        flush(j);
        let k = j + 1;
        while (k < n && text[k] !== '"') k += text[k] === '\\' ? 2 : 1;
        push('str', j, Math.min(k + 1, n), { cs: j + 1, ce: Math.min(k, n), q: '"' });
        j = Math.min(k + 1, n);
        litStart = j;
        continue;
      }
      if (ch === '$' && (text[j + 1] === '(' || text[j + 1] === '{')) {
        flush(j);
        const open = text[j + 1];
        const close = open === '(' ? ')' : '}';
        let depth = 1;
        let k = j + 2;
        while (k < n && depth > 0) {
          if (text[k] === open) depth++;
          else if (text[k] === close) depth--;
          k++;
        }
        push('op', j, k, { t: '$()' });
        j = k;
        litStart = j;
        continue;
      }
      if (ch === '$' && /[A-Za-z_]/.test(text[j + 1] ?? '')) {
        flush(j);
        let k = j + 1;
        while (k < n && /\w/.test(text[k])) k++;
        push('op', j, k, { t: '$var' });
        j = k;
        litStart = j;
        continue;
      }
      if (ch === '\\') {
        j += 2;
        continue;
      }
      j++;
    }
    flush(j);
    return j;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      i++;
      if (pendingHeredocs.length) {
        for (const h of pendingHeredocs) {
          const re = new RegExp('^' + (h.dash ? '\\t*' : '') + h.id + '[ \\t]*$', 'm');
          const m = re.exec(text.slice(i));
          const end = m ? i + m.index : n;
          push('str', i, end, { cs: i, ce: end, q: 'heredoc' });
          i = m ? end + m[0].length : n;
        }
        pendingHeredocs.length = 0;
      }
      cmdStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;|&(]/.test(text[i - 1]))) {
      let e = text.indexOf('\n', i);
      if (e < 0) e = n;
      push('com', i, e);
      i = e;
      continue;
    }
    const hm = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(text.slice(i, i + 60));
    if (hm && text[i + 2] !== '<') {
      pendingHeredocs.push({ id: hm[3], dash: hm[1] === '-' });
      push('op', i, i + hm[0].length);
      i += hm[0].length;
      continue;
    }
    if (/[;|&()<>{}]/.test(c)) {
      let j = i + 1;
      if ((c === '|' || c === '&' || c === '>' || c === '<') && text[j] === c) j++;
      push('op', i, j);
      if (c === ';' || c === '|' || c === '&' || c === '(' || c === '{') cmdStart = true;
      i = j;
      continue;
    }
    // a word
    const ws = i;
    const first = toks.length;
    // assignment NAME=value
    const am = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.exec(text.slice(i, i + 80));
    if (am) {
      push('id', i, i + am[0].length - (am[0].endsWith('+=') ? 2 : 1));
      push('op', i + am[0].length - (am[0].endsWith('+=') ? 2 : 1), i + am[0].length);
      i = readWordParts(i + am[0].length);
      continue;
    }
    const flagM = /^--?[A-Za-z][\w-]*/.exec(text.slice(i, i + 80));
    if (flagM && !cmdStart) {
      const afterFlag = i + flagM[0].length;
      if (text[afterFlag] === '=') {
        push('op', i, afterFlag + 1);
        i = readWordParts(afterFlag + 1);
        continue;
      }
      if (/^-[pP][^\s]/.test(text.slice(i, i + 3)) && !/^--/.test(text.slice(i, i + 2))) {
        // -pSECRET (mysql style) : flag char then attached value
        push('op', i, i + 2);
        i = readWordParts(i + 2);
        continue;
      }
      push('op', i, afterFlag);
      i = afterFlag;
      if (!/[\s;|&<>()]/.test(text[i] ?? ' ')) i = readWordParts(i);
      continue;
    }
    const end = readWordParts(ws);
    const word = text.slice(ws, end);
    if (end === ws) {
      i++;
      continue;
    }
    if (cmdStart) {
      // the first word is a command/keyword, not data
      for (let t = toks.length - 1; t >= first; t--) toks.splice(t, 1);
      push(SH_KW.has(word) ? 'kw' : 'id', ws, end);
      cmdStart = SH_CMD_START.has(word);
    }
    i = end;
  }
  return toks;
}

// ---------------------------------------------------------------------------------------------
// pairs & segments
// ---------------------------------------------------------------------------------------------

function strText(text: string, t: Tok): string {
  return text.slice(t.cs ?? t.s, t.ce ?? t.e);
}

function extractPairs(text: string, toks: Tok[], lang: Lang): Pair[] {
  const pairs: Pair[] = [];
  const sig = toks.filter((t) => t.k !== 'com');
  const isLit = (t?: Tok) => !!t && (t.k === 'str' || t.k === 'num');
  const mk = (keyTok: Tok | undefined, key: string, lit: Tok, kind: Pair['kind'], extra?: Partial<Pair>): Pair => ({
    key,
    keyStart: keyTok ? keyTok.cs ?? keyTok.s : lit.s,
    keyEnd: keyTok ? keyTok.ce ?? keyTok.e : lit.s,
    valStart: lit.k === 'str' ? lit.cs! : lit.s,
    valEnd: lit.k === 'str' ? lit.ce! : lit.e,
    quote: lit.q ?? '',
    numeric: lit.k === 'num',
    kind,
    ...extra,
  });

  // matching '(' for call detection
  const callStack: { idx: number; name: string; lits: Tok[] }[] = [];
  const callLits = new Map<number, { name: string; lits: Tok[] }>();

  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.k === 'op' && t.t === '(') {
      const prev = sig[i - 1];
      let name = '';
      if (prev && (prev.k === 'id' || prev.k === 'var')) name = prev.t;
      callStack.push({ idx: i, name, lits: [] });
    } else if (t.k === 'op' && t.t === ')') {
      const c = callStack.pop();
      if (c && c.name && c.lits.length) callLits.set(c.idx, { name: c.name, lits: c.lits });
    }
    if (isLit(t)) {
      const top = callStack[callStack.length - 1];
      const pv = sig[i - 1];
      if (top && pv && pv.k === 'op' && (pv.t === '(' || pv.t === ',')) top.lits.push(t);
    }
  }
  // call-argument pairs
  for (const [, c] of callLits) {
    c.lits.forEach((l, idx) => pairs.push(mk(undefined, c.name, l, 'call', { argIndex: idx, argCount: c.lits.length })));
    // define('DB_PASSWORD', 'x'), setProperty("password", "x"): first literal is the key
    if (c.lits.length === 2 && c.lits[0].k === 'str' && KV_CALLS.has(c.name.toLowerCase()) && /^[A-Za-z_][\w.-]*$/.test(strText(text, c.lits[0]))) {
      pairs.push(mk(c.lits[0], strText(text, c.lits[0]), c.lits[1], 'kv'));
    }
  }

  for (let i = 1; i < sig.length; i++) {
    const t = sig[i];
    if (!isLit(t)) continue;
    // negative numbers
    let p = i - 1;
    if (sig[p]?.k === 'op' && sig[p].t === '-' && t.k === 'num') p--;
    const op = sig[p];
    if (!op || op.k !== 'op' || !ASSIGN.has(op.t)) continue;
    const lhs = sig[p - 1];
    if (!lhs) continue;
    if (lhs.k === 'id' || lhs.k === 'var' || lhs.k === 'kw' || lhs.k === 'qid') {
      let keyTok = lhs;
      // `password: str = "x"` / `password string = "x"` (type annotations between name and '=')
      if (op.t === '=' && lhs.k === 'id') {
        if (sig[p - 2]?.k === 'op' && sig[p - 2].t === ':' && sig[p - 3]?.k === 'id') keyTok = sig[p - 3];
        else if (lang === 'go' && sig[p - 2]?.k === 'id' && sig[p - 3]?.k === 'kw') keyTok = sig[p - 2];
      }
      const key = keyTok.k === 'qid' ? strText(text, keyTok) : keyTok.t.replace(/^\$/, '');
      pairs.push(mk(keyTok, key, t, 'kv'));
    } else if (lhs.k === 'str') {
      pairs.push(mk(lhs, strText(text, lhs), t, 'kv'));
    } else if (lhs.k === 'op' && lhs.t === ']' && sig[p - 2]?.k === 'str' && sig[p - 3]?.t === '[') {
      pairs.push(mk(sig[p - 2], strText(text, sig[p - 2]), t, 'kv'));
    } else if (lhs.k === 'op' && lhs.t === ']' && sig[p - 2]?.k === 'id' && sig[p - 3]?.t === '[') {
      /* dictionary indexed by variable: unknown key */
    }
  }

  // SQL: INSERT INTO t (a,b) VALUES (x,y),(...)
  if (lang === 'sql') {
    for (let i = 0; i < sig.length; i++) {
      if (!(sig[i].k === 'kw' && sig[i].t.toLowerCase() === 'insert')) continue;
      let j = i + 1;
      while (j < sig.length && !(sig[j].k === 'op' && sig[j].t === '(') && j - i < 8) j++;
      if (sig[j]?.t !== '(') continue;
      const cols: string[] = [];
      j++;
      while (j < sig.length && sig[j].t !== ')') {
        if (sig[j].t !== ',' || sig[j].k !== 'op') cols.push(sig[j].k === 'qid' ? strText(text, sig[j]) : sig[j].t || strText(text, sig[j]));
        j++;
      }
      j++;
      if (!(sig[j]?.k === 'kw' && sig[j].t.toLowerCase() === 'values')) continue;
      j++;
      while (sig[j]?.t === '(') {
        j++;
        let col = 0;
        while (j < sig.length && sig[j].t !== ')') {
          const tk = sig[j];
          if (isLit(tk) && cols[col]) pairs.push(mk(undefined, cols[col], tk, 'sql'));
          if (tk.t === ',' && tk.k === 'op') col++;
          j++;
        }
        j++;
        if (sig[j]?.t === ',') j++;
      }
    }
  }
  return pairs;
}

export function segmentCode(text: string, lang: Lang): Part {
  const toks = lang === 'bash' ? lexShell(text) : lexGeneric(text, lang);
  const b = new SegBuilder(text.length);
  const sig = toks;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    switch (t.k) {
      case 'com':
        b.add(t.s, t.e, 'comment');
        break;
      case 'str': {
        let nx: Tok | undefined;
        for (let q = i + 1; q < sig.length; q++) {
          if (sig[q].k !== 'com') {
            nx = sig[q];
            break;
          }
        }
        const pv = sig[i - 1];
        const isKey =
          lang !== 'bash' &&
          lang !== 'sql' &&
          nx?.k === 'op' &&
          (nx.t === ':' || nx.t === '=>') &&
          pv?.k === 'op' &&
          (pv.t === '{' || pv.t === ',' || pv.t === '(');
        if (isKey) b.add(t.cs!, t.ce!, 'key');
        else b.add(t.cs!, t.ce!, 'string', { quote: t.q, vt: 'str', bare: t.bare });
        break;
      }
      case 'num':
        b.add(t.s, t.e, 'string', { vt: 'num' });
        break;
      case 'id':
      case 'var':
        b.add(t.s, t.e, 'identifier');
        break;
      case 'qid':
        b.add(t.cs!, t.ce!, 'identifier');
        break;
      default:
        break;
    }
  }
  return { segments: b.finish(), pairs: extractPairs(text, sig, lang), columns: [], errors: 0 };
}
