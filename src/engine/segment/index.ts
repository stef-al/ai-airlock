import type { Doc, Format, Lang } from '../types';
import { segmentCode } from './code';
import { segmentCsv, sniffDelimiter } from './csv';
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

export function sniffLang(text: string): Lang | null {
  const score: Record<string, number> = {};
  const add = (l: string, n = 1) => (score[l] = (score[l] ?? 0) + n);
  const t = text.slice(0, 20000);
  if (/^#!.*\b(?:ba|z)?sh\b/.test(t)) add('bash', 5);
  if (/<\?php/.test(t)) add('php', 6);
  if (/^\s*(?:def |class \w+.*:|import \w+|from \w+ import|elif |if __name__)/m.test(t) && !/[;{]\s*$/m.test(t)) add('python', 4);
  if (/\bself\.\w+/.test(t)) add('python', 1);
  if (/\b(?:const|let|var)\s+\w+\s*=|=>|\brequire\(|\bmodule\.exports|\bconsole\.log|\bfunction\s*\w*\(|^\s*import .* from ['"]/m.test(t)) add('js', 3);
  if (/\binterface\s+\w+\s*\{|:\s*(?:string|number|boolean)\b/.test(t)) add('ts', 2);
  if (/\bpublic\s+(?:static\s+)?(?:class|void|final)|\bSystem\.out|\bimport java\.|@Override|\bprivate\s+(?:static\s+)?final\b/.test(t)) add('java', 4);
  if (/\busing System|\bnamespace\s+[\w.]+|\bConsole\.Write|\bvar\s+\w+\s*=\s*new\b|\bpublic\s+(?:async\s+)?(?:Task|string|void|int)\b|\bnew SqlConnection/.test(t)) add('csharp', 4);
  if (/^package \w+|^func \w*\(|\bfmt\.Print|:= /m.test(t)) add('go', 3);
  if (/\$\w+\s*=\s*['"$]|\becho\s+\$|->\w+\(|\barray\(/.test(t)) add('php', 1);
  if (/^\s*(?:SELECT\b[\s\S]*?\bFROM\b|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+(?:TABLE|USER|LOGIN|DATABASE)|ALTER\s+(?:USER|TABLE|LOGIN)|DELETE\s+FROM|GRANT\b)/im.test(t)) add('sql', 5);
  if (/\b(?:Write-Host|Write-Output|New-Object|Get-ChildItem|Get-Content|Set-Content|Set-ExecutionPolicy|Invoke-WebRequest|Invoke-Command|Invoke-RestMethod|ConvertTo-SecureString|Import-Module|Get-Item|Set-Item|Start-Process|Out-File|Remove-Item|Test-Path|Get-Process|Get-Service|Select-Object|Where-Object|ForEach-Object|Get-Secret|Connect-\w+|New-PSSession)\b|\$env:\w+/.test(t)) add('powershell', 5);
  if (/^\s*(?:export \w+=|sudo |curl |wget |echo |apt(?:-get)? |docker |kubectl |mysql |psql |ssh |\$ )/m.test(t) || /\$\(|\bfi$/m.test(t)) add('bash', 3);
  let best: string | null = null;
  let bs = 0;
  for (const [l, s] of Object.entries(score)) if (s > bs) {
    bs = s;
    best = l;
  }
  if (best === 'js' && (score.ts ?? 0) >= 2) best = 'ts';
  return bs >= 3 ? (best as Lang) : null;
}

function jsonErrorRatio(text: string): number {
  let errs = 0;
  try {
    visit(text, { onError: () => void errs++ }, { allowTrailingComma: true });
  } catch {
    return 1; // e.g. absurd nesting depth
  }
  return errs / Math.max(1, text.length / 80);
}

export function detectFormat(text: string, fileName?: string): FormatInfo {
  const byName = infoFromFileName(fileName);
  if (byName && byName.format !== 'prose') return byName;
  const sample = text.slice(0, 60000);
  const trimmed = sample.trimStart();
  const lines = sample.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const frac = (re: RegExp) => (nonEmpty.length ? nonEmpty.filter((l) => re.test(l)).length / nonEmpty.length : 0);

  if (/^```|^~~~/m.test(sample)) return { format: 'markdown' };
  if (/^\s*(?:(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \S+ HTTP\/\d|HTTP\/\d(?:\.\d)? \d{3})/.test(sample)) return { format: 'log' };
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && text.trim().length > 1 && jsonErrorRatio(sample) < 0.5) {
    if (/^[\[{]\s*(?:[\]}"\d\[{-]|true|false|null)/.test(trimmed)) return { format: 'json' };
  }
  if (frac(/^\s*"[^"]+"\s*:\s*\S/) > 0.6) return { format: 'json' };
  if (/^\s*<\?xml|^\s*<[A-Za-z][\w:.-]*[\s>/]/.test(trimmed) && /<\/[A-Za-z][\w:.-]*>|\/>/.test(sample) && frac(/^\s*</) > 0.5) return { format: 'xml' };
  if (nonEmpty.length >= 3 && frac(/^\s*\|.*\|\s*$/) > 0.6 && lines.some((l) => /^\s*\|?\s*:?-{2,}/.test(l))) return { format: 'markdown' };
  if (nonEmpty.length >= 2 && frac(/^\s{0,3}(?:#{1,6}\s|[-*]\s+\S)/) > 0.4 && !/[;{]\s*$/m.test(sample)) return { format: 'markdown' };
  const d = sniffDelimiter(sample);
  if (d && nonEmpty.length >= 3 && !(d === '|' && frac(/^\s*\|/) > 0.5)) {
    const hdrOk = !/\s{2,}/.test(nonEmpty[0]) || d === '\t';
    if (hdrOk && !/[{};]$/m.test(sample.slice(0, 500)) && !(d === ';' && frac(/;\s*$/) > 0.3)) return { format: 'csv' };
  }
  const envRe = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*=/;
  const cfgLines = nonEmpty.filter((l) => !/^\s*[#;]/.test(l));
  const envFrac = cfgLines.length ? cfgLines.filter((l) => envRe.test(l)).length / cfgLines.length : 0;
  const hasSection = lines.some((l) => /^\s*\[[^\]\n]+\]\s*$/.test(l));
  if (hasSection && envFrac > 0.4 && !/[;{]\s*$/m.test(sample.slice(0, 400))) return { format: 'ini' };
  const yamlFrac = cfgLines.length ? cfgLines.filter((l) => /^\s*(?:-\s+)?[\w."'/-][^:]*:(?:\s|$)|^\s*-\s+\S/.test(l)).length / cfgLines.length : 0;
  const codeSignals = /[;{}]\s*$/m.test(sample) || /\b(?:function|def|class|import|return)\b/.test(sample);
  if (/^---\s*$/m.test(sample.slice(0, 200)) && yamlFrac > 0.5) return { format: 'yaml' };
  if (yamlFrac > 0.7 && cfgLines.length >= 2 && !codeSignals && envFrac < 0.5) return { format: 'yaml' };
  if (envFrac > 0.7 && cfgLines.length >= 2 && !codeSignals) {
    const upper = cfgLines.filter((l) => /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*=/.test(l)).length / cfgLines.length;
    return { format: upper > 0.5 ? 'env' : 'properties' };
  }
  if (frac(MONTH_LOG) > 0.3 || frac(LEVEL) > 0.4) return { format: 'log' };
  const lang = sniffLang(sample);
  // a chat message that merely mentions a command is prose, not a script
  const codeLike = nonEmpty.filter((l) => /[{};=$|&<>]|\s-{1,2}[A-Za-z]|^\s*(?:#|\/\/|--)|\w\(/.test(l)).length / Math.max(1, nonEmpty.length);
  if (lang && codeLike >= 0.4) return { format: 'code', lang };
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
  } catch {
    part = { segments: proseSegments(text.length), pairs: [], columns: [], errors: 1 };
    format = 'prose';
  }
  return { text, format, lang, segments: part.segments, pairs: part.pairs, columns: part.columns, errors: part.errors };
}
