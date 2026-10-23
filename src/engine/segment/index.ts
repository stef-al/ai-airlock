import type { Doc, Format, Lang } from '../types';
import { segmentCode } from './code';
import { isTableSep, segmentCsv, sniffDelimiter } from './csv';
import { segmentJson } from './json';
import { segmentKv } from './kv';
import { segmentMarkdown } from './markdown';
import { proseSegments, type Part } from './part';
import { segmentXml } from './xml';
import { segmentYaml } from './yaml';
import { visit } from 'jsonc-parser';

export interface FormatInfo {
  format: Format;
  lang?: Lang;
}

const EXT: Record<string, FormatInfo> = {
  json: { format: 'json' }, jsonc: { format: 'json' }, json5: { format: 'json' }, har: { format: 'json' },
  yml: { format: 'yaml' }, yaml: { format: 'yaml' },
  xml: { format: 'xml' }, xsd: { format: 'xml' }, xaml: { format: 'xml' }, csproj: { format: 'xml' },
  config: { format: 'xml' }, plist: { format: 'xml' }, svg: { format: 'xml' }, html: { format: 'xml' }, htm: { format: 'xml' },
  csv: { format: 'csv' }, tsv: { format: 'csv' },
  md: { format: 'markdown' }, markdown: { format: 'markdown' },
  env: { format: 'env' },
  ini: { format: 'ini' }, cfg: { format: 'ini' }, conf: { format: 'ini' }, toml: { format: 'ini' },
  properties: { format: 'properties' },
  log: { format: 'log' }, out: { format: 'log' },
  txt: { format: 'prose' },
  js: { format: 'code', lang: 'js' }, mjs: { format: 'code', lang: 'js' }, cjs: { format: 'code', lang: 'js' },
  jsx: { format: 'code', lang: 'js' }, ts: { format: 'code', lang: 'ts' }, tsx: { format: 'code', lang: 'ts' },
  py: { format: 'code', lang: 'python' }, java: { format: 'code', lang: 'java' },
  cs: { format: 'code', lang: 'csharp' }, go: { format: 'code', lang: 'go' }, php: { format: 'code', lang: 'php' },
  sql: { format: 'code', lang: 'sql' },
  sh: { format: 'code', lang: 'bash' }, bash: { format: 'code', lang: 'bash' }, zsh: { format: 'code', lang: 'bash' },
  ps1: { format: 'code', lang: 'powershell' }, psm1: { format: 'code', lang: 'powershell' },
};

const FENCE_LANG: Record<string, FormatInfo> = {
  js: { format: 'code', lang: 'js' }, javascript: { format: 'code', lang: 'js' }, jsx: { format: 'code', lang: 'js' },
  node: { format: 'code', lang: 'js' }, ts: { format: 'code', lang: 'ts' }, typescript: { format: 'code', lang: 'ts' },
  tsx: { format: 'code', lang: 'ts' }, py: { format: 'code', lang: 'python' }, python: { format: 'code', lang: 'python' },
  java: { format: 'code', lang: 'java' }, cs: { format: 'code', lang: 'csharp' }, csharp: { format: 'code', lang: 'csharp' },
  go: { format: 'code', lang: 'go' }, golang: { format: 'code', lang: 'go' }, php: { format: 'code', lang: 'php' },
  sql: { format: 'code', lang: 'sql' }, mysql: { format: 'code', lang: 'sql' }, postgres: { format: 'code', lang: 'sql' },
  psql: { format: 'code', lang: 'sql' }, tsql: { format: 'code', lang: 'sql' },
  bash: { format: 'code', lang: 'bash' }, sh: { format: 'code', lang: 'bash' }, shell: { format: 'code', lang: 'bash' },
  zsh: { format: 'code', lang: 'bash' }, console: { format: 'code', lang: 'bash' }, 'shell-session': { format: 'code', lang: 'bash' },
  powershell: { format: 'code', lang: 'powershell' }, ps: { format: 'code', lang: 'powershell' },
  ps1: { format: 'code', lang: 'powershell' }, pwsh: { format: 'code', lang: 'powershell' },
  json: { format: 'json' }, jsonc: { format: 'json' }, json5: { format: 'json' },
  yaml: { format: 'yaml' }, yml: { format: 'yaml' },
  xml: { format: 'xml' }, html: { format: 'xml' }, svg: { format: 'xml' },
  csv: { format: 'csv' }, tsv: { format: 'csv' },
  ini: { format: 'ini' }, toml: { format: 'ini' }, conf: { format: 'ini' }, cfg: { format: 'ini' },
  properties: { format: 'properties' }, env: { format: 'env' }, dotenv: { format: 'env' },
  log: { format: 'log' }, text: { format: 'prose' }, plaintext: { format: 'prose' }, txt: { format: 'prose' },
};

export function infoFromFileName(name?: string): FormatInfo | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) return { format: 'env' };
  if (base === '.npmrc' || base === '.pypirc' || base === '.gitconfig' || base === '.s3cfg') return { format: 'ini' };
  if (base === '.netrc' || base === '.pgpass' || base === '.git-credentials' || base === 'credentials') return { format: 'prose' };
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return { format: 'code', lang: 'bash' };
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT[ext] ?? null;
}

const MONTH_LOG = /^\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[\d{4}-\d{2}|\[?\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}|\d{1,2}\/[A-Z][a-z]{2}\/\d{4})/;
const LEVEL = /\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|SEVERE)\b/;

/** Language signals: each distinct signal that occurs adds its weight once. */
const LANG_SIGNALS: [Lang, RegExp, number][] = [
  ['bash', /^#!.*\b(?:ba|z|da|k)?sh\b/m, 6],
  ['bash', /^\s*(?:sudo |apt(?:-get)? |yum |dnf |brew |docker |kubectl |helm |terraform |systemctl |chmod |chown |mkdir |rm -|cd |ls |echo |curl |wget |ssh |scp |git |npm |npx |pnpm |yarn |pip3? |mysql |psql |export \w+=)/m, 2],
  ['bash', /^\s*(?:if \[\[? |for \w+ in |while \[|case .* in\s*$|fi\s*$|done\s*$|esac\s*$)/m, 3],
  ['bash', /\$\(|\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\s&&\s|\s\|\|\s|\s2>&1/, 1],
  ['powershell', /\b(?:Write-Host|Write-Output|Write-Error|New-Object|Get-ChildItem|Get-Content|Set-Content|Set-ExecutionPolicy|Invoke-WebRequest|Invoke-Command|Invoke-RestMethod|ConvertTo-SecureString|Import-Module|Get-Item|Set-Item|Start-Process|Out-File|Remove-Item|Test-Path|Get-Process|Get-Service|Select-Object|Where-Object|ForEach-Object|Get-Secret|Get-Credential|New-PSSession)\b/, 4],
  ['powershell', /\$env:\w+|\$PSScriptRoot|\$ErrorActionPreference|-ErrorAction\b|^\s*param\s*\(|\[Parameter\(|\[string\]\$|\[securestring\]/im, 3],
  ['python', /^\s*(?:def \w+\(.*\)\s*(?:->\s*[\w[\], ]+)?:|class \w+(?:\(.*\))?:)\s*$/m, 4],
  ['python', /^\s*(?:import [\w.]+(?: as \w+)?|from [\w.]+ import [\w*, ]+)\s*$/m, 3],
  ['python', /^\s*(?:elif |if __name__ == |with open\(|try:\s*$|except(?: \w+)?(?: as \w+)?:\s*$)/m, 3],
  ['python', /\bself\.\w+|\bprint\(|\bNone\b|\bTrue\b|\bFalse\b/, 1],
  ['js', /^\s*(?:export\s+)?(?:const|let|var)\s+[\w${}[\], ]{1,120}=/m, 2],
  ['js', /\brequire\(['"]|\bmodule\.exports\b|\bexports\.\w+\s*=|\bconsole\.(?:log|error|warn|info)\(|\bdocument\.\w|\bwindow\.\w|\bprocess\.env\b/, 3],
  ['js', /=>\s*[{(]|\bfunction\s*\*?\s*\w*\s*\(|^\s*import\s*(?:[\w*{][^'"\n]*?\s*from\s*)?['"]|^\s*export\s*(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*)/m, 3],
  ['js', /\bawait\s+[\w.(]|===|!==|\bthis\.\w+|\bnew\s+(?:Promise|Map|Set|Error|Date)\b|\.then\(|\bundefined\b/, 1],
  ['js', /\bfetch\(|\baddEventListener\(|\bJSON\.(?:parse|stringify)\(|\bPromise\.\w+\(|\bsetTimeout\(|`[^`\n]{0,200}\$\{[^}\n]{1,80}\}[^`\n]{0,200}`/, 2],
  ['ts', /\binterface\s+\w+(?:<[^>{}\n]{0,200}>)?\s*(?:extends\s+[^{\n]{1,300})?\{|\btype\s+\w+(?:<[^=\n]{0,200}>)?\s*=[^=>]|\bas const\b|\bimplements\s+\w+|\b(?:public|private|protected|readonly)\s+\w+\??\s*:/, 3],
  ['ts', /\bimport\s+type\b|\bexport\s+(?:declare|type|interface|enum|abstract)\b|^\s*declare\s+(?:const|let|function|class|module|namespace|global|type)\b|\w\??:\s*(?:string|number|boolean|void|unknown|any|never|bigint|undefined)(?:\[\])?\s*[;,)=|]/m, 3],
  ['java', /^\s*package [\w.]+;\s*$/m, 4],
  ['java', /\bimport java\.|\bimport javax\.|\bimport org\.springframework|\bSystem\.out\.print|@Override|@Autowired|\bString\[\] args|\bpublic\s+(?:final\s+)?class\s+\w+(?:\s+extends|\s+implements|\s*\{)/, 3],
  ['csharp', /^\s*using System(?:\.[\w.]+)?;\s*$/m, 4],
  ['csharp', /\bnamespace\s+[\w.]+\s*(?:\{|;|$)|\bConsole\.Write(?:Line)?\(|\{\s*get;\s*(?:set;\s*)?\}|\bstring\[\] args|\basync Task\b|\[Http(?:Get|Post)|\bnew SqlConnection|\bvar\s+\w+\s*=\s*new\s+\w+/m, 3],
  ['go', /^package \w+\s*$/m, 4],
  ['go', /^func (?:\(\w+ \*?\w+\) )?\w+\(|\bfmt\.\w+\(|\b\w+\s*:=\s*|^import \($/m, 3],
  ['go', /^type \w+ (?:struct|interface) \{|`(?:json|yaml|xml|db|gorm|bson|mapstructure|toml|env):"[^"\n]*"/m, 4],
  ['php', /<\?php/, 6],
  ['php', /\$\w+\s*=\s*[^=]|->\w+\(|\barray\(|\becho\s+['"$]|\bfunction\s+\w+\s*\(\$/, 2],
  ['sql', /^\s*(?:SELECT\b[\s\S]{0,400}?\bFROM\b|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|USER|LOGIN|DATABASE|INDEX|VIEW|PROCEDURE)|ALTER\s+(?:USER|TABLE|LOGIN)|DROP\s+(?:TABLE|USER|DATABASE)|GRANT\s+\w+|REVOKE\s+\w+)/im, 5],
];

export function sniffLang(text: string): Lang | null {
  const t = text.slice(0, 20000);
  const score: Partial<Record<Lang, number>> = {};
  for (const [lang, re, w] of LANG_SIGNALS) if (re.test(t)) score[lang] = (score[lang] ?? 0) + w;
  let best: Lang | null = null;
  let bs = 0;
  for (const [l, v] of Object.entries(score) as [Lang, number][]) {
    if (v > bs) {
      bs = v;
      best = l;
    }
  }
  if ((best === 'js' || best === 'ts') && (score.ts ?? 0) >= 3) best = 'ts';
  return bs >= 3 ? best : null;
}

/** Lines shaped like code in most languages: statement ends, braces, comments, keywords, calls. */
const CODE_SHAPE = new RegExp(
  [
    String.raw`[;{}([,]\s*$|^\s*[}\])]`,
    String.raw`^\s*(?:\/\/|\/\*|\*\/|\*(?:\s|$)|#!)`,
    String.raw`=>|:=|\w\([^()]*\)\s*[;{:]?\s*$`,
    String.raw`^\s*(?:import|export|from|const|let|var|function|class|interface|type|enum|return|if|else|elif|for|foreach|while|do|switch|case|break|continue|try|catch|except|finally|throw|raise|def|async|await|public|private|protected|internal|static|package|using|namespace|func|defer|echo|fi|done|then|esac|local|param|yield|with|struct|declare|abstract|override|readonly|module|new|set|unset|sudo|cd|mkdir|rm|cp|mv|chmod|chown|apt-get|apt|yum|dnf|brew|pip3?|npm|npx|yarn|git|curl|wget|docker|kubectl|helm|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b`,
    String.raw`^\s*@[A-Za-z]\w*(?:\(|\s*$)`,
  ].join('|'),
);
/** prose sentences: words separated by single spaces and ending in a full stop */
const SENTENCE = /^\s*(?:[-*>]\s+)?[A-Z][a-z]+(?: [\w,'’()-]+){4,}[.!?:]\s*$/;

function codeShapeRatio(lines: string[]): number {
  let code = 0;
  let n = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    n++;
    if (CODE_SHAPE.test(l) && !SENTENCE.test(l)) code++;
  }
  return n ? code / n : 0;
}

const SHEBANG: [RegExp, Lang][] = [
  [/^#!.*\b(?:ba|z|da|k)?sh\b/, 'bash'],
  [/^#!.*\bpython/, 'python'],
  [/^#!.*\b(?:node|deno|bun)\b/, 'js'],
  [/^#!.*\bpwsh\b/, 'powershell'],
  [/^#!.*\bphp\b/, 'php'],
];

function jsonErrorRatio(text: string): number {
  let errs = 0;
  try {
    visit(text, { onError: () => void errs++ }, { allowTrailingComma: true });
  } catch {
    return 1; // e.g. absurd nesting depth
  }
  return errs / Math.max(1, text.length / 80);
}

const EMAIL_HDR = /^(?:From|To|Cc|Bcc|Subject|Date|Sent|Reply-To|Message-ID|Von|An|Betreff|Gesendet|Datum|De|À|Objet|Envoyé|Para|Asunto|Enviado|Oggetto|Inviato|Od|Do|Temat|Wysłano|Komu|Předmět|Odesláno|Kopie|CC):[ \t]/;
const DIFF_LINE = /^(?:diff --git |index [0-9a-f]{6,}\.\.[0-9a-f]{6,}|--- (?:a\/|\/dev\/null)|\+\+\+ (?:b\/|\/dev\/null)|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/;
const COMMENT_LINE = /^\s*(?:#|;|\/\/|!)/;
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=(?!=)/;
const YAML_KEY_LINE = /^\s*(?:-\s+)?(?:"[^"]*"|'[^']*'|[\w./-][\w./ -]{0,60}?)\s*:(?:\s|$)/;
const YAML_ITEM = /^\s*-\s+\S|^\s*-\s*$|^---\s*$|^\.\.\.\s*$/;
const SECTION_LINE = /^\s*\[[^\]\n]+\]\s*$/;
const CODE_LINE = /[;{,]\s*$|^\s*\}|=\s*(?:new\s+)?[\w.$]+\(|^\s*[\w.$]+\(.*\)\s*;?\s*$|\b(?:function|def|class|return|import|public|private|static|void)\b|=>|\bfor\s*\(|\bif\s*\(/;
const DOCKER_LINE = /^(?:FROM|RUN|ENV|COPY|ADD|WORKDIR|EXPOSE|CMD|ENTRYPOINT|ARG|USER|LABEL|VOLUME|HEALTHCHECK|SHELL|STOPSIGNAL|ONBUILD)\s/;

function markdownScore(lines: string[]): number {
  let headings = 0;
  let bullets = 0;
  let links = 0;
  let inline = 0;
  for (const l of lines) {
    if (/^#{1,6}\s+\S/.test(l)) headings++;
    if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(l) && !/^\s*-\s+[\w"'./-]+:(?:\s|$)/.test(l)) bullets++;
    links += (l.match(/\[[^\]\n]{1,200}\]\([^)\s]{1,500}\)/g) ?? []).length;
    if (/\*\*[^*\n]+\*\*|`[^`\n]+`|^>\s/.test(l)) inline++;
  }
  return Math.min(headings, 3) * 2 + Math.min(bullets, 3) + Math.min(links, 3) + Math.min(inline, 2);
}

function hasMarkdownTable(lines: string[]): boolean {
  for (let i = 0; i + 1 < lines.length; i++) if (lines[i].includes('|') && isTableSep(lines[i + 1])) return true;
  return false;
}

export function detectFormat(text: string, fileName?: string): FormatInfo {
  const byName = infoFromFileName(fileName);
  if (byName && byName.format !== 'prose') return byName;
  const sample = text.slice(0, 60000);
  const trimmed = sample.trimStart();
  const lines = sample.split('\n').map((l) => l.replace(/\r$/, ''));
  const nonEmpty = lines.filter((l) => l.trim());
  const count = (xs: string[], re: RegExp) => xs.filter((l) => re.test(l)).length;
  const head = nonEmpty.slice(0, 15);

  for (const [re, l] of SHEBANG) if (re.test(trimmed)) return { format: 'code', lang: l };
  if (/^[ \t]{0,3}(?:```|~~~)/m.test(sample)) return { format: 'markdown' };
  if (/^\s*(?:(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \S+ HTTP\/\d|HTTP\/\d(?:\.\d)? \d{3})/.test(sample)) return { format: 'log' };
  // patches and mails are text with embedded fragments: scan them as prose
  if (count(head, DIFF_LINE) >= 2) return { format: 'prose' };
  if (count(head, EMAIL_HDR) >= 2) return { format: 'prose' };

  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && text.trim().length > 1 && jsonErrorRatio(sample) < 0.5) {
    if (/^[[{]\s*(?:[\]}"\d[{-]|true|false|null)/.test(trimmed)) return { format: 'json' };
  }
  if (nonEmpty.length >= 2 && nonEmpty.every((l) => /^\s*[[{].*[\]}]\s*,?\s*$/.test(l))) return { format: 'json' };
  if (count(nonEmpty, /^\s*"[^"]+"\s*:\s*\S/) / Math.max(1, nonEmpty.length) > 0.6) return { format: 'json' };
  if (/^(?:<\?xml|<!DOCTYPE\s|<!--|<[A-Za-z][\w:.-]*[\s>/])/i.test(trimmed) && /<\/[A-Za-z][\w:.-]*>|\/>/.test(sample)) {
    if (/^(?:<\?xml|<!DOCTYPE\s|<html[\s>])/i.test(trimmed) || count(nonEmpty, /^\s*</) / nonEmpty.length > 0.5) return { format: 'xml' };
  }

  // configuration: judged on the lines that are not comments (config files are full of '# ...' notes)
  // nor the body of a YAML block scalar (key: | followed by more indented lines)
  const cfg: string[] = [];
  let blockIndent = -1;
  for (const l of nonEmpty) {
    const ind = l.length - l.trimStart().length;
    if (blockIndent >= 0 && ind > blockIndent) continue;
    blockIndent = /:\s*[|>][+-]?\d?\s*$/.test(l) ? ind : -1;
    if (!COMMENT_LINE.test(l)) cfg.push(l);
  }
  if (cfg.length >= 2) {
    const n = cfg.length;
    const env = count(cfg, ENV_LINE);
    const keys = count(cfg, YAML_KEY_LINE);
    const items = count(cfg, YAML_ITEM);
    const sections = count(cfg, SECTION_LINE);
    const code = count(cfg, CODE_LINE);
    const codeFrac = code / n;
    if (sections >= 1 && (env + keys + sections) / n >= 0.7 && codeFrac < 0.2) return { format: 'ini' };
    if (env / n >= 0.6 && codeFrac < 0.15 && sections === 0) {
      const upper = count(cfg, /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=/) / n;
      return { format: upper > 0.5 ? 'env' : 'properties' };
    }
    if ((keys + items) / n >= 0.6 && keys >= Math.max(1, 0.3 * n) && codeFrac < 0.15 && env < keys) return { format: 'yaml' };
  }

  // code: a recognised language and mostly code-shaped lines (comments with '# ' or ' * ' are not headings or bullets)
  let lang = sniffLang(sample);
  const shape = codeShapeRatio(lines.slice(0, 400));
  // unknown C-family code (statements ending in ; { }) is lexed like JavaScript
  if (!lang && shape >= 0.75 && nonEmpty.length >= 2 && count(nonEmpty, /[;{}]\s*(?:\/\/.*)?$/) / nonEmpty.length >= 0.6) lang = 'js';
  if (lang && shape >= 0.55) return { format: 'code', lang };
  const md = markdownScore(lines);
  if (md >= 4 || hasMarkdownTable(lines)) return { format: 'markdown' };
  const d = sniffDelimiter(sample);
  if (d && nonEmpty.length >= 3 && !(d === '|' && count(nonEmpty, /^\s*\|/) / nonEmpty.length > 0.5)) {
    const hdrOk = !/\s{2,}/.test(nonEmpty[0]) || d === '\t';
    if (hdrOk && !/[{};]$/m.test(sample.slice(0, 500)) && !(d === ';' && count(nonEmpty, /;\s*$/) / nonEmpty.length > 0.3)) return { format: 'csv' };
  }
  if (count(nonEmpty, DOCKER_LINE) >= 2 && /^(?:FROM|ARG)\s/m.test(sample)) return { format: 'code', lang: 'bash' };
  if (count(nonEmpty, MONTH_LOG) / Math.max(1, nonEmpty.length) > 0.3 || count(nonEmpty, LEVEL) / Math.max(1, nonEmpty.length) > 0.4) return { format: 'log' };
  // a chat message that merely mentions a command is prose, not a script
  const codeLike = count(nonEmpty, /[{};=$|&<>]|\s-{1,2}[A-Za-z]|^\s*(?:#|\/\/|--)|\w\(/) / Math.max(1, nonEmpty.length);
  if (lang && codeLike >= 0.4) return { format: 'code', lang };
  if (md >= 3) return { format: 'markdown' };
  return { format: 'prose' };
}

function resolveInfo(info: string): FormatInfo | null {
  const key = info.toLowerCase();
  return FENCE_LANG[key] ?? null;
}

/** Segment a code-fence body: by info string, otherwise by sniffing. */
function subSegment(code: string, info: string): Part | null {
  let fi = resolveInfo(info);
  if (!fi) {
    const d = detectFormat(code);
    fi = d.format === 'markdown' ? { format: 'prose' } : d;
  }
  return segmentBy(code, fi.format, fi.lang);
}

export function segmentBy(text: string, format: Format, lang?: Lang): Part {
  switch (format) {
    case 'json':
      return segmentJson(text);
    case 'yaml':
      return segmentYaml(text);
    case 'xml':
      return segmentXml(text);
    case 'csv':
      return segmentCsv(text);
    case 'env':
      return segmentKv(text, 'env');
    case 'ini':
      return segmentKv(text, 'ini');
    case 'properties':
      return segmentKv(text, 'properties');
    case 'markdown':
      return segmentMarkdown(text, subSegment);
    case 'code':
      return segmentCode(text, lang ?? 'js');
    default:
      return { segments: proseSegments(text.length), pairs: [], columns: [], errors: 0 };
  }
}

export interface BuildOptions {
  format?: Format | 'auto';
  lang?: Lang;
  fileName?: string;
}

export function buildDoc(text: string, opts: BuildOptions = {}): Doc {
  let format: Format;
  let lang: Lang | undefined = opts.lang;
  if (opts.format && opts.format !== 'auto') format = opts.format;
  else {
    const d = detectFormat(text, opts.fileName);
    format = d.format;
    lang = lang ?? d.lang;
  }
  let part: Part;
  try {
    part = segmentBy(text, format, lang);
    // a guessed structure that does not parse is better treated as text than as a broken document
    const sniffed = !opts.format || opts.format === 'auto';
    const named = !!infoFromFileName(opts.fileName) && infoFromFileName(opts.fileName)!.format !== 'prose';
    if (sniffed && !named && ((format === 'yaml' && part.errors > 0) || (format === 'json' && part.errors > 2) || (format === 'xml' && part.errors > 2))) {
      part = { segments: proseSegments(text.length), pairs: [], columns: [], errors: 0 };
      format = 'prose';
      lang = undefined;
    }
  } catch {
    part = { segments: proseSegments(text.length), pairs: [], columns: [], errors: 1 };
    format = 'prose';
  }
  return { text, format, lang, segments: part.segments, pairs: part.pairs, columns: part.columns, errors: part.errors };
}
