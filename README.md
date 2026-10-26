# AI Airlock

Mask sensitive data in text, code, config files and logs **before** you paste them into an AI chatbot, entirely offline. Paste the AI's reply back and the real values are put in again.

**Flow:** paste or drop files → detection → review highlights → *Copy masked* … later: paste the reply → *Restore* → *Copy restored*.

Open `dist/airlock.html` (build it with `npm run build`, or use the GitHub Pages site). It is one self-contained file and works from disk, a shared drive or Pages.

## What it detects
| Category | Examples |
|---|---|
| **Secrets** | Known formats: AWS/Azure/GCP/GitHub/GitLab/Slack/Stripe/npm/AI-provider keys (about 55 formats), JWTs, PEM/OpenSSH/PuTTY/PGP private keys, password hashes (bcrypt, argon2, crypt, PBKDF2…), connection strings and `user:pass@` URLs, Authorization headers, session cookies, secret URL parameters, credential files (`.npmrc`, `.netrc`, `.pgpass`, Docker config, Kubernetes Secrets…). By context: a literal next to a secret-like name (`password`, `token`, `api_key`, `Passwort`, `mot de passe`, `contraseña`, `hasło`, `heslo`…) in JSON, YAML, XML, .env, INI, properties, code (assignments, object literals, call arguments, SQL `IDENTIFIED BY`, PowerShell `ConvertTo-SecureString`, CLI flags) and prose. Unknown formats: entropy plus password shapes (`Summer2024!`) in Aggressive, boosted by cues in Balanced. |
| **Personal** | Emails; phone numbers (libphonenumber, region from the browser locale); person names (greetings, signatures, titles, mail headers, labels, `john.smith@…` → John Smith, name lists generated from faker locale data); organizations with legal suffixes (Ltd, Inc, GmbH, AG, S.A., B.V., s.r.o., a.s., Sp. z o.o. …); user names in paths (`/home/jsmith`, `C:\Users\jsmith`); dates of birth next to a birth cue; national IDs with checksums: US SSN, UK NI number, Czech/Slovak birth number, Polish PESEL. |
| **Financial** | IBAN (mod-97), payment cards (Luhn, brand and length), CVV and expiry next to a card. |
| **Network** | IPv4/IPv6 (private ranges and localhost toggleable), MAC addresses, hostnames under configurable internal suffixes and company domains. |
| **Custom** | Always-mask lists (clients, projects, products, employees; import from CSV/TXT, case-insensitive), your own regex rules with a live test box, and whole table columns classified by header and values (CSV and Markdown tables). |

Structure is never changed: keys, tags, identifiers, CSV headers, operators and Markdown syntax are protected (`getPassword()`, `PASSWORD_MIN_LENGTH` and `password_hash` are not secrets). Placeholders are valid where they land: `[PASSWORD_1]` in prose and strings, `PASSWORD_1` in unquoted YAML/env/URLs, numbers stay numbers, emails become `user1@example.com`, IPs become `192.0.2.x` / `2001:db8::n`, hosts become `srvN.example.net`, identifiers become `Client1Service`. Format-preserving fakes randomise letters and digits but keep every other character, so they stay valid in URLs and shell words; redacting a JSON/YAML number gives `0`. After masking the output is re-parsed and compared with the original; a replacement that would break structure gets a safer placeholder or is skipped and flagged for review. If that check runs out of time (3 s), the remaining replacements are kept and the guard reports FAILED: an unmasked secret is worse than a broken bracket. Masked JSON and YAML are also checked against the real parsers in development (same shape and value types, every placeholder style).

## What it cannot do (honest limits)
- It is rule-based. A secret with **no cue and no known format** (“log in with admin and hunter2”) is only caught by the Aggressive shape rules. Multi-word quoted passwords (4+ words) look like sentences and are skipped unless the key is `passphrase`/`seed`/`mnemonic`.
- **Names:** only with a cue, an email that contains the name, a name found elsewhere in the same text, or a custom list. Uncued names (“yesterday Fatima Hussain called”) are only found in Aggressive mode, and only if both parts are in the generated lists. Unknown first names after a greeting (“Hi Oluwaseun,”) are missed. Organizations need a legal suffix. Postal addresses are not covered.
- The metrics come from a corpus I wrote myself (38 fixtures, 291 labelled spans, 12 of them held out); real-world accuracy will be lower. Read the masked text before you paste it.
- Numeric placeholders (a PIN stored as a JSON number) are unique within an input; restore matches the bare digits, so an unrelated identical number in the AI's reply could be restored by mistake.
- Pasted text has no file name, so its type is recognised from the content: env, properties, INI/TOML, YAML, JSON, JSON Lines, XML/HTML, CSV, Markdown, logs, mails and diffs, and the ten code languages. On real files from `node_modules` read without their names: JSON 79/79, TypeScript 118/118, shell 10/10, HTML 6/6, Markdown 73/76, JavaScript 190/205 (the misses are minified bundles). A sniffed YAML/JSON/XML document that does not parse is treated as text. A wrong guess can still hide cue-less secrets; a file name or a code fence removes the guess.
- Chatbots may rewrite or drop placeholders. Restore accepts the usual changes (no brackets, backticks, other case, `-` or a space for `_`, markdown escapes such as `\[PASSWORD\_1\]`), and the report lists what did not come back and what the AI invented.
- Files: UTF-8, UTF-16 with BOM (Windows PowerShell output) and, when a file is not valid UTF-8, the Windows code page of the browser language; up to 25 MB. No Office/PDF input, no OCR, no encrypted mapping file yet.

## Privacy design
- No backend, no external APIs, CDNs, web fonts, analytics or telemetry. Every dependency is bundled.
- A strict Content-Security-Policy (`default-src 'none'`, `connect-src 'none'`, script and style allowed by hash, workers from `blob:` only) makes the browser refuse any request to another origin. `npm run build` fails if the file contains an external URL, a network primitive or a weaker policy, and `npm run smoke` proves in Chromium that `fetch` is blocked.
- Detection runs in an inline Web Worker. Original values and the mapping live in memory only; the tab warns before closing while a mapping exists and *Forget everything* wipes it. Only settings, profiles and always-mask lists are stored (localStorage, unencrypted). Stored settings and imported profiles are checked field by field, so a damaged file cannot break detection.

## Configuration
The review panel works with the mouse and the keyboard (Tab to a highlight, Enter for details). Settings → global sensitivity (Strict: validated/known formats only; Balanced: adds context rules; Aggressive: adds entropy and heuristics), on/off, sensitivity, scopes (prose, comment, string, config, identifier, key) and placeholder style (token, format-preserving fake, irreversible █████) per category and per detector; cue-word and qualifier lists; allowlist (terms and regexes); lists and regex rules; IP/host/ID-pack options. Profiles (built-in presets *Source code*, *Config and logs*, *Business text / email*, plus your own) export and import as JSON so a security team can share one standard profile.

## Develop
```
npm ci
npm test          # unit tests + corpus (structure guard + byte-identical round trip on every fixture)
npm run metrics   # precision / recall per category, detector and type  (-- --details --set=dev|holdout --strict --sniff)
npm run build     # typecheck + dist/airlock.html + offline/CSP checks
npm run smoke     # opens dist/airlock.html from file:// in Chromium (needs the build)
```
The name lists are generated from `@faker-js/faker` (MIT) by `scripts/gen-names.ts` (run by the npm `pre*` hooks). `.github/workflows/pages.yml` builds and publishes the file to GitHub Pages (`docs/deploy.yml` is a copy in case workflow files cannot be pushed). See `CLAUDE.md` for the architecture.

### Add a detector
1. Create `src/engine/detectors/<name>.ts` exporting a `Detector` (`id`, `category`, `types`, `defaultScopes`, `detect(doc, cfg, ctx) → Hit[]`; linear time, no catastrophic regexes). Use `doc.segments`/`doc.pairs` for structure, `mkHit` for hits, `SENS_RANK[cfg.sensitivity]` to gate rules by sensitivity.
2. Add it to `BASE_DETECTORS` in `src/engine/index.ts` and to `DETECTOR_META` in `src/engine/meta.ts` (a test keeps them in sync). New placeholder types go in `CAT_OF_TYPE` (`detectors/helpers.ts`) and `KNOWN_TYPES` (`restore.ts`).
3. Add labelled fixtures (`tests/corpus/*.fixture`, `⟦TYPE:text⟧` marks expected spans; use `{{macro}}` generators from `tests/tokens.ts` for anything token-shaped) and run `npm run metrics -- --details`.

### Add an ID pack
Create `src/engine/detectors/ids/<country>.ts` (or add to `packs.ts`) exporting an `IdPack` (`id`, `type`, a global `re`, optional `cue`, and `validate(match, cue)` returning a confidence or `null`), append it to `ID_PACKS` in `ids/index.ts`, and add `{ id, label }` to `ID_PACK_META` in `meta.ts` (and the id to `ID_PACK_IDS` in `settings.ts`). Add the placeholder type to `CAT_OF_TYPE` and `KNOWN_TYPES`. Users can switch each pack off in Settings.

## Roadmap (Phase 2)
Office/PDF input with masked export in the same format; on-device name/organization recognition model; postal addresses; encrypted mapping file (passphrase) to restore later; locked team policy profiles; a browser extension that checks text pasted into AI chat sites.
