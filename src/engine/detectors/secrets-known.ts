import { isPlaceholderValue, isReference, looksLikeCode, valueVerdict } from '../cues';
import type { Detector, Doc, Hit, RunCtx } from '../types';
import { charClasses, skipEmpty } from '../util';
import { analyzerFor, mkHit } from './helpers';

const ID = 'secrets.known';

interface Rule {
  id: string;
  type: string;
  re: RegExp;
  /** capture group that is the secret (default whole match) */
  group?: number;
  reason: string;
  conf: number;
  /** extra validation on the secret text */
  ok?: (secret: string, m: RegExpExecArray, text: string) => boolean;
  /** cheap lowercase substring prefilter; at least one must occur */
  pre?: string[];
}

const B = '(?<![A-Za-z0-9_-])';
const rx = (src: string, flags = 'g') => new RegExp(src, flags + 'd');

const notFake = (s: string) => !/(.)\1{9,}|EXAMPLE|(?:x{8,}|X{8,}|\*{4,})|<[^>]+>|YOUR[_-]|REPLACE/.test(s);
const mixed = (s: string) => charClasses(s) >= 3;

const RULES: Rule[] = [
  { id: 'aws-key-id', type: 'API_KEY', re: rx(`${B}(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA|AGPA|ANPA|ANVA|AIPA)[A-Z2-7]{16}(?![A-Za-z0-9])`), reason: 'AWS access key ID format', conf: 0.97, ok: notFake, pre: ['akia', 'asia', 'abia', 'acca', 'aida', 'aroa', 'agpa', 'anpa', 'anva', 'aipa'] },
  { id: 'azure-storage-key', type: 'SECRET', re: rx(`(?:AccountKey|SharedAccessKey)\\s*=\\s*([A-Za-z0-9+/]{40,}={0,2})`, 'gi'), group: 1, reason: 'Azure storage / Service Bus key in a connection string', conf: 0.97, pre: ['accountkey', 'sharedaccesskey'] },
  { id: 'azure-sas', type: 'TOKEN', re: rx(`SharedAccessSignature\\s*=\\s*([^;"'\\s]{20,})`, 'gi'), group: 1, reason: 'Azure shared access signature', conf: 0.95, pre: ['sharedaccesssignature'] },
  { id: 'azure-ad-secret', type: 'SECRET', re: rx(`${B}[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9])`), reason: 'Azure AD client secret format (…8Q~…)', conf: 0.95, pre: ['8q~'] },
  { id: 'gcp-api-key', type: 'API_KEY', re: rx(`${B}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`), reason: 'Google API key format (AIza…)', conf: 0.96, ok: notFake, pre: ['aiza'] },
  { id: 'gcp-oauth', type: 'TOKEN', re: rx(`${B}ya29\\.[0-9A-Za-z_-]{20,}`), reason: 'Google OAuth access token (ya29.…)', conf: 0.95, pre: ['ya29.'] },
  { id: 'gcp-client-secret', type: 'SECRET', re: rx(`${B}GOCSPX-[0-9A-Za-z_-]{20,}`), reason: 'Google OAuth client secret (GOCSPX-…)', conf: 0.96, pre: ['gocspx-'] },
  { id: 'gcp-refresh', type: 'TOKEN', re: rx(`${B}1//0[0-9A-Za-z_-]{40,}`), reason: 'Google OAuth refresh token', conf: 0.9, pre: ['1//0'] },
  { id: 'github-token', type: 'TOKEN', re: rx(`${B}gh[pousr]_[A-Za-z0-9]{36,255}`), reason: 'GitHub token format (gh?_…)', conf: 0.98, ok: notFake, pre: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'] },
  { id: 'github-pat', type: 'TOKEN', re: rx(`${B}github_pat_[A-Za-z0-9_]{22,255}`), reason: 'GitHub fine-grained token format', conf: 0.98, ok: notFake, pre: ['github_pat_'] },
  { id: 'gitlab-token', type: 'TOKEN', re: rx(`${B}gl(?:pat|dt|rt|ptt|cbt|ft|imt|agent|soat|oas)-[A-Za-z0-9_-]{20,}`), reason: 'GitLab token format (glpat-…)', conf: 0.97, ok: notFake, pre: ['glpat-', 'gldt-', 'glrt-', 'glptt-', 'glcbt-', 'glft-', 'glimt-', 'glagent-', 'glsoat-', 'gloas-'] },
  { id: 'slack-token', type: 'TOKEN', re: rx(`${B}xox[abprso]-[A-Za-z0-9-]{10,}`), reason: 'Slack token format (xox?-…)', conf: 0.97, ok: notFake, pre: ['xox'] },
  { id: 'slack-app-token', type: 'TOKEN', re: rx(`${B}xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+`), reason: 'Slack app-level token', conf: 0.97, pre: ['xapp-'] },
  { id: 'slack-webhook', type: 'SECRET', re: rx(`https://hooks\\.slack\\.com/(?:services|workflows)/[A-Za-z0-9/_-]{20,}`), reason: 'Slack webhook URL', conf: 0.96, pre: ['hooks.slack.com'] },
  { id: 'discord-webhook', type: 'SECRET', re: rx(`https://(?:discord|discordapp)\\.com/api/webhooks/\\d+/[A-Za-z0-9_-]{20,}`), reason: 'Discord webhook URL', conf: 0.96, pre: ['/api/webhooks/'] },
  { id: 'teams-webhook', type: 'SECRET', re: rx(`https://[a-z0-9.-]+\\.webhook\\.office\\.com/webhook[a-z0-9]*/[A-Za-z0-9@/_.-]{30,}`, 'gi'), reason: 'Microsoft Teams webhook URL', conf: 0.96, pre: ['.webhook.office.com'] },
  { id: 'stripe-key', type: 'API_KEY', re: rx(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`), reason: 'Stripe secret key format', conf: 0.97, ok: notFake, pre: ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'] },
  { id: 'stripe-webhook', type: 'SECRET', re: rx(`${B}whsec_[A-Za-z0-9]{24,}`), reason: 'Stripe webhook signing secret', conf: 0.95, pre: ['whsec_'] },
  { id: 'npm-token', type: 'TOKEN', re: rx(`${B}npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])`), reason: 'npm access token format', conf: 0.97, ok: notFake, pre: ['npm_'] },
  { id: 'anthropic-key', type: 'API_KEY', re: rx(`${B}sk-ant-[A-Za-z0-9_-]{2,12}-[A-Za-z0-9_-]{30,}`), reason: 'Anthropic API key format (sk-ant-…)', conf: 0.98, ok: notFake, pre: ['sk-ant-'] },
  { id: 'openai-proj-key', type: 'API_KEY', re: rx(`${B}sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{30,}`), reason: 'OpenAI API key format (sk-proj-…)', conf: 0.98, ok: notFake, pre: ['sk-proj-', 'sk-svcacct-', 'sk-admin-'] },
  { id: 'openai-key', type: 'API_KEY', re: rx(`${B}sk-(?!ant-|proj-|svcacct-|admin-|or-)[A-Za-z0-9]{32,64}(?![A-Za-z0-9])`), reason: 'API key format (sk-…) used by OpenAI-style providers', conf: 0.9, ok: (s) => notFake(s) && /\d/.test(s) && /[A-Za-z]/.test(s), pre: ['sk-'] },
  { id: 'openrouter-key', type: 'API_KEY', re: rx(`${B}sk-or-v1-[a-f0-9]{40,}`), reason: 'OpenRouter API key format', conf: 0.97, pre: ['sk-or-'] },
  { id: 'hf-token', type: 'TOKEN', re: rx(`${B}hf_[A-Za-z0-9]{30,}`), reason: 'Hugging Face token format (hf_…)', conf: 0.95, ok: notFake, pre: ['hf_'] },
  { id: 'groq-key', type: 'API_KEY', re: rx(`${B}gsk_[A-Za-z0-9]{40,}`), reason: 'Groq API key format', conf: 0.96, ok: notFake, pre: ['gsk_'] },
  { id: 'replicate-token', type: 'TOKEN', re: rx(`${B}r8_[A-Za-z0-9]{36,}`), reason: 'Replicate API token format', conf: 0.95, ok: notFake, pre: ['r8_'] },
  { id: 'xai-key', type: 'API_KEY', re: rx(`${B}xai-[A-Za-z0-9]{40,}`), reason: 'xAI API key format', conf: 0.96, ok: notFake, pre: ['xai-'] },
  { id: 'pplx-key', type: 'API_KEY', re: rx(`${B}pplx-[A-Za-z0-9]{40,}`), reason: 'Perplexity API key format', conf: 0.96, ok: notFake, pre: ['pplx-'] },
  { id: 'nvidia-key', type: 'API_KEY', re: rx(`${B}nvapi-[A-Za-z0-9_-]{50,}`), reason: 'NVIDIA API key format', conf: 0.96, pre: ['nvapi-'] },
  { id: 'sendgrid-key', type: 'API_KEY', re: rx(`${B}SG\\.[A-Za-z0-9_-]{16,32}\\.[A-Za-z0-9_-]{30,64}`), reason: 'SendGrid API key format', conf: 0.97, pre: ['sg.'] },
  { id: 'twilio-key', type: 'API_KEY', re: rx(`${B}SK[0-9a-f]{32}(?![A-Za-z0-9])`), reason: 'Twilio API key SID format', conf: 0.85, ok: notFake },
  { id: 'mailgun-key', type: 'API_KEY', re: rx(`${B}key-[0-9a-f]{32}(?![A-Za-z0-9])`), reason: 'Mailgun API key format', conf: 0.9, pre: ['key-'] },
  { id: 'mailchimp-key', type: 'API_KEY', re: rx(`${B}[0-9a-f]{32}-us\\d{1,2}(?![A-Za-z0-9])`), reason: 'Mailchimp API key format', conf: 0.93, pre: ['-us'] },
  { id: 'shopify-token', type: 'TOKEN', re: rx(`${B}shp(?:at|ca|pa|ss)_[a-f0-9]{32}`), reason: 'Shopify token format', conf: 0.97, pre: ['shpat_', 'shpca_', 'shppa_', 'shpss_'] },
  { id: 'do-token', type: 'TOKEN', re: rx(`${B}do[opr]_v1_[a-f0-9]{64}`), reason: 'DigitalOcean token format', conf: 0.97, pre: ['_v1_'] },
  { id: 'pypi-token', type: 'TOKEN', re: rx(`${B}pypi-[A-Za-z0-9_-]{50,}`), reason: 'PyPI upload token format', conf: 0.97, pre: ['pypi-'] },
  { id: 'docker-pat', type: 'TOKEN', re: rx(`${B}dckr_pat_[A-Za-z0-9_-]{20,}`), reason: 'Docker Hub token format', conf: 0.97, pre: ['dckr_pat_'] },
  { id: 'postman-key', type: 'API_KEY', re: rx(`${B}PMAK-[0-9a-f]{24}-[0-9a-f]{34}`), reason: 'Postman API key format', conf: 0.97, pre: ['pmak-'] },
  { id: 'vault-token', type: 'TOKEN', re: rx(`${B}hv[sbr]\\.[A-Za-z0-9_-]{24,}`), reason: 'HashiCorp Vault token format', conf: 0.95, pre: ['hvs.', 'hvb.', 'hvr.'] },
  { id: 'tfc-token', type: 'TOKEN', re: rx(`${B}[A-Za-z0-9]{14}\\.atlasv1\\.[A-Za-z0-9_-]{60,}`), reason: 'Terraform Cloud token format', conf: 0.97, pre: ['.atlasv1.'] },
  { id: 'atlassian-token', type: 'TOKEN', re: rx(`${B}ATATT3[A-Za-z0-9_\\-=]{50,}`), reason: 'Atlassian API token format', conf: 0.97, pre: ['atatt3'] },
  { id: 'sentry-token', type: 'TOKEN', re: rx(`${B}sntrys_[A-Za-z0-9+/=_-]{40,}`), reason: 'Sentry auth token format', conf: 0.96, pre: ['sntrys_'] },
  { id: 'grafana-token', type: 'TOKEN', re: rx(`${B}(?:glc_[A-Za-z0-9+/=]{30,}|glsa_[A-Za-z0-9]{32}_[a-f0-9]{8})`), reason: 'Grafana token format', conf: 0.96, pre: ['glc_', 'glsa_'] },
  { id: 'linear-key', type: 'API_KEY', re: rx(`${B}lin_api_[A-Za-z0-9]{40}`), reason: 'Linear API key format', conf: 0.96, pre: ['lin_api_'] },
  { id: 'databricks-token', type: 'TOKEN', re: rx(`${B}dapi[0-9a-f]{32}(?![A-Za-z0-9])`), reason: 'Databricks token format', conf: 0.93, pre: ['dapi'] },
  { id: 'notion-token', type: 'TOKEN', re: rx(`${B}(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{43})(?![A-Za-z0-9])`), reason: 'Notion integration token format', conf: 0.93, pre: ['ntn_', 'secret_'] },
  { id: 'square-token', type: 'TOKEN', re: rx(`${B}sq0(?:atp|csp)-[0-9A-Za-z_-]{22,43}`), reason: 'Square token format', conf: 0.96, pre: ['sq0'] },
  { id: 'firebase-server-key', type: 'API_KEY', re: rx(`${B}AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}`), reason: 'Firebase Cloud Messaging server key', conf: 0.96, pre: ['aaaa'] },
  { id: 'telegram-bot', type: 'TOKEN', re: rx(`(?<![A-Za-z0-9])\\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])`), reason: 'Telegram bot token format', conf: 0.9, ok: (s) => mixed(s.split(':')[1] ?? ''), pre: [':'] },
  { id: 'bcrypt', type: 'PASSWORD_HASH', re: rx(`(?<![\\w$])\\$2[abxy]?\\$\\d{2}\\$[./A-Za-z0-9]{53}(?![./A-Za-z0-9])`), reason: 'bcrypt password hash', conf: 0.97, pre: ['$2'] },
  { id: 'argon2', type: 'PASSWORD_HASH', re: rx(`(?<![\\w$])\\$argon2(?:id|i|d)\\$v=\\d+\\$m=\\d+,t=\\d+,p=\\d+\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+`), reason: 'argon2 password hash', conf: 0.97, pre: ['$argon2'] },
  { id: 'crypt-hash', type: 'PASSWORD_HASH', re: rx(`(?<![\\w$])\\$(?:1|5|6|y|apr1|P|H|sha1)\\$(?:rounds=\\d+\\$)?[./A-Za-z0-9,=-]{1,40}\\$[./A-Za-z0-9]{20,}`), reason: 'Unix crypt / phpass / yescrypt password hash', conf: 0.93, pre: ['$1$', '$5$', '$6$', '$y$', '$apr1$', '$p$', '$h$', '$sha1$'] },
  { id: 'pbkdf2-hash', type: 'PASSWORD_HASH', re: rx(`(?<![\\w$])pbkdf2_sha(?:1|256|512)\\$\\d+\\$[^$\\s]+\\$[A-Za-z0-9+/=]+`), reason: 'Django PBKDF2 password hash', conf: 0.96, pre: ['pbkdf2_sha'] },
  { id: 'ldap-hash', type: 'PASSWORD_HASH', re: rx(`\\{(?:SSHA|SHA|SSHA256|SSHA512|SHA256|SHA512|MD5|SMD5|CRYPT|ARGON2|PBKDF2[\\w-]*)\\}[A-Za-z0-9+/=$.-]{16,}`), reason: 'LDAP-style password hash', conf: 0.93, pre: ['{ssha', '{sha', '{md5', '{smd5', '{crypt', '{argon2', '{pbkdf2'] },
];

// ---------------------------------------------------------------------------------------------
// JWT, private keys, URI credentials, connection strings, headers, cookies, URL params, CLI, SQL
// ---------------------------------------------------------------------------------------------

function b64urlJson(s: string): unknown {
  try {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return JSON.parse(typeof atob === 'function' ? atob(t) : Buffer.from(t, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

const JWT_RE = rx(`${B}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*`);
const PEM_RE = rx(`-----BEGIN ((?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?)-----`);
const PUTTY_RE = rx(`PuTTY-User-Key-File-\\d: [\\s\\S]{0,12000}?Private-MAC: [0-9a-fA-F]+`);
const URI_CRED = rx(`\\b([a-z][a-z0-9+.-]{1,24}):\\/\\/([^\\s:@/?#"'<>\\\\]{0,64}):([^\\s/"'<>\\\\]{1,200})@`, 'gi');
const ADO = rx(`(?<![A-Za-z0-9_])(?:password|pwd)\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|\\{([^}\\n]*)\\}|([^;"'\\s]+))`, 'gi');
const ADO_SIBLING = /(?:server|data source|host|initial catalog|database|user id|uid|integrated security|provider|driver|trusted_connection|addr|address)\s*=/i;
const AUTH_HDR = rx(`\\bauthorization\\s*[:=]\\s*["']?\\s*(bearer|basic|token|digest|negotiate|ntlm|apikey|api-key)\\s+([A-Za-z0-9._~+/=-]{8,})`, 'gi');
const COOKIE_HDR = rx(`\\b(?:set-)?cookie\\s*[:=]\\s*["']?([^\\r\\n"']{3,2000})`, 'gi');
const SESS_NAME = /sess|^sid$|ssid|auth|token|jwt|remember|sso|login|csrf|xsrf|identity|secure/i;
const URL_PARAM = rx(`[?&]([A-Za-z0-9_.-]{2,40})=([^&#\\s"'<>\\\\]{6,512})`);
const NETRC = rx(`\\bmachine\\s+\\S+\\s+login\\s+\\S+\\s+password\\s+(\\S+)`, 'gi');
const PGPASS = rx(`^(?:[A-Za-z0-9_.-]*[A-Za-z][A-Za-z0-9_.-]*|\\*|\\d{1,3}(?:\\.\\d{1,3}){3}):(?:\\d{1,5}|\\*):(?:[^:\\s]+|\\*):[^:\\s]+:(\\S{3,})$`, 'gm');
const PS_SECURE = rx(`ConvertTo-SecureString\\s+(?:-String\\s+)?(?:"([^"\\n]*)"|'([^'\\n]*)')`, 'gi');
const SQL_PW: RegExp[] = [
  rx(`\\bIDENTIFIED\\s+(?:WITH\\s+\\w+\\s+)?BY\\s+(?:PASSWORD\\s+)?'((?:[^'\\n]|'')*)'`, 'gi'),
  rx(`\\b(?:WITH|SET)\\s+(?:ENCRYPTED\\s+)?PASSWORD\\s*=?\\s*'((?:[^'\\n]|'')*)'`, 'gi'),
  rx(`\\bPASSWORD\\s*\\(\\s*'((?:[^'\\n]|'')*)'\\s*\\)`, 'gi'),
  rx(`\\bPASSWORD\\s+'((?:[^'\\n]|'')*)'`, 'gi'),
  rx(`\\bENCRYPTION\\s+BY\\s+PASSWORD\\s*=\\s*'((?:[^'\\n]|'')*)'`, 'gi'),
];

interface Cli {
  re: RegExp;
  reason: string;
  group: number;
}
const CLI: Cli[] = [
  { re: rx(`\\b(?:mysql|mysqldump|mysqladmin|mysqlsh|mariadb|mariadb-dump|mysqlpump)\\b[^\\n|;&]*?\\s-p([^\\s'"-][^\\s'"]*)`, 'g'), reason: 'password attached to -p of a MySQL client', group: 1 },
  { re: rx(`\\bsshpass\\s+-p\\s*(?:'([^'\\n]+)'|"([^"\\n]+)"|([^\\s'"]+))`, 'g'), reason: 'password passed to sshpass -p', group: 0 },
  { re: rx(`\\bcurl\\b[^\\n|;&]*?\\s(?:-u|--user)(?:\\s+|=)(?:'|")?[^\\s:'"]+:([^\\s'"]+)`, 'g'), reason: 'password in curl -u user:password', group: 1 },
  { re: rx(`\\bdocker\\s+login\\b[^\\n|;&]*?\\s(?:-p|--password)(?:\\s+|=)(?:'|")?([^\\s'"]+)`, 'g'), reason: 'password passed to docker login', group: 1 },
  { re: rx(`-pass(?:in|out)?\\s+pass:([^\\s'"]+)`, 'g'), reason: 'openssl -pass pass:… argument', group: 1 },
  { re: rx(`\\bredis-cli\\b[^\\n|;&]*?\\s-a\\s+(?:'|")?([^\\s'"]+)`, 'g'), reason: 'password passed to redis-cli -a', group: 1 },
  { re: rx(`\\bsqlcmd\\b[^\\n|;&]*?\\s-P\\s*(?:'|")?([^\\s'"]+)`, 'g'), reason: 'password passed to sqlcmd -P', group: 1 },
  { re: rx(`\\bldap\\w*\\b[^\\n|;&]*?\\s-w\\s+(?:'|")?([^\\s'"]+)`, 'g'), reason: 'password passed to an LDAP client -w', group: 1 },
  { re: rx(`\\b(?:smbclient|mount\\.cifs)\\b[^\\n|;&]*?(?:-U\\s+|username=)[^\\s%,]+[%,](?:password=)?([^\\s'",]+)`, 'g'), reason: 'password in SMB credentials', group: 1 },
];

const SPECIAL_PARAMS = /^(?:sig|signature|sas|x-amz-signature|x-amz-security-token|x-goog-signature|code_verifier|apikey|api_key|api-key)$/i;

function cleanSecret(s: string): boolean {
  return s.length >= 3 && !isPlaceholderValue(s) && !isReference(s) && notFake(s) && !looksLikeCode(s, false);
}

function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) skipEmpty(re, text);
    yield m;
    if (++n > 20000) return;
  }
}

function groupRange(m: RegExpExecArray, g: number): [number, number] | null {
  const ind = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] }).indices;
  const r = ind?.[g];
  return r ? [r[0], r[1]] : null;
}

function firstGroup(m: RegExpExecArray): [number, number, string] | null {
  for (let g = 1; g < m.length; g++) if (m[g] !== undefined) {
    const r = groupRange(m, g);
    if (r) return [r[0], r[1], m[g]];
  }
  return null;
}

function awsSecretNear(text: string, keyEnd: number, out: Hit[], idStart: number) {
  const lo = Math.max(0, idStart - 260);
  const win = text.slice(lo, keyEnd + 260);
  const re = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(win))) {
    if (!mixed(m[0]) || !/[a-z]/.test(m[0]) || !/[A-Z]/.test(m[0]) || !notFake(m[0])) continue;
    const s = lo + m.index;
    out.push(mkHit(ID, 'SECRET', s, s + 40, 0.88, '40-character secret next to an AWS access key ID', 3, 'aws-secret'));
  }
}

export const secretsKnown: Detector = {
  id: ID,
  label: 'Secrets in known formats (keys, tokens, hashes, connection strings)',
  category: 'secret',
  types: ['API_KEY', 'TOKEN', 'SECRET', 'JWT', 'PRIVATE_KEY', 'PASSWORD_HASH', 'PASSWORD', 'COOKIE'],
  defaultScopes: ['prose', 'comment', 'string', 'config'],
  detect(doc: Doc, _cfg, ctx: RunCtx): Hit[] {
    const text = doc.text;
    const lower = text.toLowerCase();
    const out: Hit[] = [];
    const pre = (list?: string[]) => !list || list.some((p) => lower.includes(p));

    for (const r of RULES) {
      if (!pre(r.pre)) continue;
      ctx.check();
      for (const m of matches(r.re, text)) {
        const rg = r.group ? groupRange(m, r.group) : null;
        const s = rg ? rg[0] : m.index;
        const e = rg ? rg[1] : m.index + m[0].length;
        const sec = text.slice(s, e);
        if (r.ok && !r.ok(sec, m, text)) continue;
        out.push(mkHit(ID, r.type, s, e, r.conf, r.reason, 3, r.id));
        if (r.id === 'aws-key-id') awsSecretNear(text, e, out, s);
      }
    }

    if (lower.includes('eyj')) {
      for (const m of matches(JWT_RE, text)) {
        const head = b64urlJson(m[0].split('.')[0]) as Record<string, unknown> | null;
        if (!head || typeof head !== 'object' || !('alg' in head || 'typ' in head || 'kid' in head)) continue;
        out.push(mkHit(ID, 'JWT', m.index, m.index + m[0].length, 0.97, 'JSON Web Token (header.payload.signature)', 3, 'jwt'));
      }
    }

    if (lower.includes('-----begin')) {
      for (const m of matches(PEM_RE, text)) {
        const label = m[1];
        const bodyStart = m.index + m[0].length;
        const endMark = `-----END ${label}-----`;
        const endIdx = text.indexOf(endMark, bodyStart);
        if (endIdx >= 0 && endIdx - bodyStart <= 20000) {
          out.push(mkHit(ID, 'PRIVATE_KEY', m.index, endIdx + endMark.length, 0.99, `${label} block`, 3, 'pem'));
        } else {
          const body = /^[A-Za-z0-9+/=\s\\:,.-]{0,20000}/.exec(text.slice(bodyStart))![0].replace(/\s+$/, '');
          out.push(mkHit(ID, 'PRIVATE_KEY', m.index, bodyStart + body.length, 0.85, `${label} block (end marker missing)`, 3, 'pem-trunc'));
        }
      }
    }
    if (lower.includes('putty-user-key-file')) {
      for (const m of matches(PUTTY_RE, text)) out.push(mkHit(ID, 'PRIVATE_KEY', m.index, m.index + m[0].length, 0.98, 'PuTTY private key file', 3, 'putty'));
    }

    // credentials inside URIs: scheme://user:password@host
    if (text.includes('://')) {
      for (const m of matches(URI_CRED, text)) {
        const r = groupRange(m, 3)!;
        const pw = m[3];
        const v = valueVerdict(decodeSafe(pw), { strength: 'strong', type: 'PASSWORD', quoted: false });
        if (!v.ok) continue;
        // documentation hosts (RFC 2606): https://abc:xyz@example.com is an illustration
        const host = /^@([^/:?#\s"'<>]*)/.exec(text.slice(r[1], r[1] + 260))?.[1].toLowerCase() ?? '';
        if (/(?:^|\.)example\.(?:com|net|org)$|\.(?:example|test|invalid)$/.test(host)) continue;
        const scheme = m[1].toLowerCase();
        out.push(mkHit(ID, 'PASSWORD', r[0], r[1], 0.96, /^https?$/.test(scheme) ? 'password in a basic-auth URL' : `password in a ${scheme}:// connection URI`, 3, 'uri-cred'));
      }
    }

    // ADO.NET / ODBC style connection strings
    if (lower.includes('password') || lower.includes('pwd')) {
      for (const m of matches(ADO, text)) {
        const g = firstGroup(m);
        if (!g) continue;
        const [s, e, val] = g;
        if (!val.trim() || !cleanSecret(val)) continue;
        const win = text.slice(Math.max(0, m.index - 300), m.index + m[0].length + 300);
        if (!ADO_SIBLING.test(win)) continue;
        out.push(mkHit(ID, 'PASSWORD', s, e, 0.95, 'Password= in a connection string', 3, 'conn-string'));
      }
    }

    if (lower.includes('authorization')) {
      for (const m of matches(AUTH_HDR, text)) {
        const r = groupRange(m, 2)!;
        const scheme = m[1].toLowerCase();
        if (!cleanSecret(m[2])) continue;
        out.push(mkHit(ID, scheme === 'basic' ? 'PASSWORD' : 'TOKEN', r[0], r[1], 0.95, `Authorization header (${m[1]} credential)`, 3, 'auth-header'));
      }
    }

    if (lower.includes('cookie')) {
      for (const m of matches(COOKIE_HDR, text)) {
        const base = groupRange(m, 1)![0];
        let off = 0;
        for (const part of m[1].split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) {
            const name = part.slice(0, eq).trim();
            const vs = base + off + eq + 1;
            const val = part.slice(eq + 1).trim();
            if (SESS_NAME.test(name) && val.length >= 8 && cleanSecret(val) && !/^(?:path|domain|expires|max-age|samesite|secure|httponly)$/i.test(name))
              out.push(mkHit(ID, 'COOKIE', vs, vs + val.length, 0.9, `session cookie '${name}'`, 3, 'cookie'));
          }
          off += part.length + 1;
        }
      }
    }

    if (text.includes('?') || text.includes('&')) {
      const an = analyzerFor(ctx.settings);
      for (const m of matches(URL_PARAM, text)) {
        const name = m[1];
        const r = groupRange(m, 2)!;
        const val = m[2];
        if (!cleanSecret(val)) continue;
        const ki = an.analyze(name);
        const special = SPECIAL_PARAMS.test(name);
        const keyLike = /^key$/i.test(name) && val.length >= 20 && mixed(val);
        if ((ki && !ki.negated && ki.strength !== 'weak') || special || keyLike) {
          if (/^[a-z]{2,10}$/i.test(val)) continue;
          out.push(mkHit(ID, ki?.type ?? 'SECRET', r[0], r[1], 0.9, `secret URL parameter '${name}'`, 3, 'url-param'));
        }
      }
    }

    if (lower.includes('machine ')) {
      for (const m of matches(NETRC, text)) {
        const r = groupRange(m, 1)!;
        if (cleanSecret(m[1])) out.push(mkHit(ID, 'PASSWORD', r[0], r[1], 0.95, 'password in a .netrc entry', 3, 'netrc'));
      }
    }
    if (text.includes(':')) {
      for (const m of matches(PGPASS, text)) {
        const r = groupRange(m, 1)!;
        out.push(mkHit(ID, 'PASSWORD', r[0], r[1], 0.85, 'password field of a .pgpass line (host:port:db:user:password)', 3, 'pgpass'));
      }
    }

    if (lower.includes('convertto-securestring')) {
      for (const m of matches(PS_SECURE, text)) {
        const g = firstGroup(m);
        if (g && g[2] && cleanSecret(g[2])) out.push(mkHit(ID, 'PASSWORD', g[0], g[1], 0.93, 'plain text passed to ConvertTo-SecureString', 3, 'ps-securestring'));
      }
    }

    if (lower.includes('password') || lower.includes('identified')) {
      for (const re of SQL_PW) {
        for (const m of matches(re, text)) {
          const r = groupRange(m, 1)!;
          if (m[1] && cleanSecret(m[1])) out.push(mkHit(ID, 'PASSWORD', r[0], r[1], 0.93, 'password literal in an SQL statement', 3, 'sql-password'));
        }
      }
    }

    for (const c of CLI) {
      ctx.check();
      for (const m of matches(c.re, text)) {
        const g = c.group ? groupRange(m, c.group) : firstGroup(m);
        const fg = g ? ([g[0], g[1]] as [number, number]) : firstGroup(m)?.slice(0, 2);
        if (!fg) continue;
        const [s, e] = fg as [number, number];
        const sec = text.slice(s, e);
        if (sec && cleanSecret(sec) && !sec.startsWith('-')) out.push(mkHit(ID, 'PASSWORD', s, e, 0.9, c.reason, 3, 'cli'));
      }
    }
    return out;
  },
};

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
