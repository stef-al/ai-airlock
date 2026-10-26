import { describe, expect, it } from 'vitest';
import { buildDoc } from '../src/engine';
import { detectFormat } from '../src/engine/segment';

// Pasted text has no file name: these snippets must be recognised from their content alone.
const CASES: [string, string, string][] = [
  ['env with comments and refs', 'env', '# local overrides\nDB_HOST=localhost\nDB_PASSWORD=${VAULT_PW}\nAPI_SECRET=abc123\n'],
  ['env with export', 'env', 'export AWS_REGION=eu-west-1\nexport AWS_PROFILE=prod\nexport TOKEN="x y"\n'],
  ['properties', 'properties', 'server.port=8080\nspring.datasource.url=jdbc:postgresql://db:5432/x\nspring.mail.password=${MAIL_PASSWORD}\napp.password-reset-url=https://a.b/c\n'],
  ['yaml with comments', 'yaml', '# Production settings\n# Owner: platform team\nreplicas: 3\npassword: secret\nimage: app:1.2.3\n'],
  ['docker compose', 'yaml', 'version: "3.9"\nservices:\n  db:\n    image: postgres:15\n    environment:\n      - POSTGRES_PASSWORD=x\n      SMTP: ${SMTP_PASSWORD}\n    ports:\n      - "5432:5432"\n'],
  ['k8s multi doc', 'yaml', 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: a\ndata:\n  pw: eA==\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: b\n'],
  ['github actions', 'yaml', 'name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      TOKEN: ${{ secrets.TOKEN }}\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n'],
  ['yaml with block scalars', 'yaml', "token: 'a''b'\nkey: |\n  -----BEGIN KEY-----\n  b3BlbnNzaC1rZXk\n  -----END KEY-----\nnote: >\n  call me\n  later please\n"],
  ['yaml list of maps', 'yaml', '- name: db\n  password: a1\n- name: cache\n  password: b2\n'],
  ['json object', 'json', '{\n  "a": 1,\n  "b": {"c": "d"}\n}\n'],
  ['json fragment', 'json', '"user": "bob",\n"password": "x",\n"port": 5432\n'],
  ['json lines', 'json', '{"level":"info","msg":"a"}\n{"level":"warn","msg":"b"}\n'],
  ['xml', 'xml', '<?xml version="1.0"?>\n<config>\n  <add key="a" value="b"/>\n</config>\n'],
  ['csv with header', 'csv', 'name,email,phone\nBob,bob@x.io,123\nAnn,ann@y.io,456\n'],
  ['tsv', 'csv', 'id\tname\tcity\n1\tBob\tParis\n2\tAnn\tRome\n'],
  ['semicolon csv', 'csv', 'Kunde;Email;Betrag\nAcme;a@b.de;12,50\nGlobex;c@d.de;7,10\n'],
  ['ini', 'ini', '[database]\nhost = db\npassword = x\n\n[cache]\nttl = 30\n'],
  ['toml', 'ini', '[server]\nhost = "0.0.0.0"\nport = 8080\n\n[database]\npassword = "x"\n'],
  ['markdown headings and bullets', 'markdown', '# Setup\n\nInstall the tool:\n\n- run `npm ci`\n- copy `.env.example`\n\nSee [docs](https://example.com) for **details**.\n'],
  ['markdown table', 'markdown', 'Accounts below.\n\n| Service | Owner |\n|---|---|\n| CI | Lena |\n\nThanks.\n'],
  ['markdown fences', 'markdown', 'Here is my config:\n\n```yaml\na: 1\n```\n'],
  ['email', 'prose', 'From: Tom <tom@x.io>\nTo: Ann <ann@y.io>\nSubject: Re: invoice\nDate: Mon, 3 Jun 2024 10:00\n\nHi Ann,\nsee attached.\n'],
  ['chat log', 'prose', '[09:14] anna: can you check the box?\n[09:15] ben: sure, give me a minute\n[09:20] anna: thanks!\n'],
  ['java stack trace', 'prose', 'Exception in thread "main" java.lang.NullPointerException\n\tat com.acme.App.run(App.java:12)\n\tat com.acme.App.main(App.java:5)\n'],
  ['python traceback', 'prose', 'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nValueError: bad value\n'],
  ['app log', 'log', '2024-08-15 10:30:45 INFO started\n2024-08-15 10:30:46 WARN slow request\n2024-08-15 10:30:47 ERROR failed\n'],
  ['http request', 'log', 'POST /login HTTP/1.1\nHost: a.b\nAuthorization: Basic eA==\n\n{"a":1}\n'],
  ['git diff', 'prose', 'diff --git a/c.yml b/c.yml\nindex 1a2b3c4..5d6e7f8 100644\n--- a/c.yml\n+++ b/c.yml\n@@ -1,3 +1,3 @@\n db:\n-  password: old\n+  password: new\n'],
  ['sql', 'code/sql', "CREATE USER app IDENTIFIED BY 'x';\nGRANT SELECT ON db.* TO app;\nSELECT * FROM users WHERE id = 1;\n"],
  ['bash', 'code/bash', '#!/bin/bash\nset -e\nexport A=1\nif [ -f x ]; then\n  echo hi\nfi\n'],
  ['python', 'code/python', 'import os\n\ndef main():\n    print(os.getcwd())\n\nif __name__ == "__main__":\n    main()\n'],
  ['javascript', 'code/js', "const fs = require('fs');\nfunction read(p) {\n  return fs.readFileSync(p, 'utf8');\n}\nmodule.exports = { read };\n"],
  ['typescript', 'code/ts', 'interface User { name: string; age: number }\nexport function greet(u: User): string {\n  return `hi ${u.name}`;\n}\n'],
  ['java', 'code/java', 'package com.acme;\n\nimport java.util.List;\n\npublic class App {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}\n'],
  ['csharp', 'code/csharp', 'using System;\n\nnamespace Acme\n{\n    public class Program\n    {\n        public static void Main(string[] args)\n        {\n            Console.WriteLine("hi");\n        }\n    }\n}\n'],
  ['go', 'code/go', 'package main\n\nimport "fmt"\n\nvar cfg = Config{Host: "x"}\n\nfunc main() {\n\tfmt.Println("hi")\n}\n'],
  ['php', 'code/php', "<?php\n$db = new PDO($dsn, 'u', 'p');\necho $db->query('SELECT 1');\n"],
  ['powershell', 'code/powershell', '$ErrorActionPreference = "Stop"\n$cred = Get-Credential\nWrite-Host "Connecting"\nInvoke-Command -ComputerName srv -Credential $cred -ScriptBlock { Get-Service }\n'],
  ['dockerfile', 'code/bash', 'FROM node:20-alpine\nWORKDIR /app\nENV NODE_ENV=production\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n'],
  ['terraform', 'prose', 'resource "aws_db_instance" "main" {\n  engine   = "postgres"\n  password = var.db_password\n}\n'],
  ['plain prose', 'prose', 'Hi team,\n\nthe deploy went fine. The password for the admin account is in the vault; ping me if anything breaks.\n\nCheers'],
  ['chat message with a command', 'prose', 'Hi Tom,\nssh jdoe@build01.internal from 52.14.200.31, DOB: 14.03.1985\nRegards,\nMaria Lopez\n'],
];

describe('format sniffing without a file name', () => {
  for (const [name, want, text] of CASES) {
    it(name, () => {
      const d = detectFormat(text);
      expect(d.lang ? `${d.format}/${d.lang}` : d.format).toBe(want);
    });
  }
  it('falls back to prose when sniffed YAML does not parse', () => {
    const t = 'Subject: Re: invoice: overdue\nNote: call: me: now\n  - stray: [unclosed\n';
    expect(buildDoc(t).format).toBe('prose');
  });
});
