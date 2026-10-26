import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** The name lists are generated from @faker-js/faker; make `npx vitest` work without the npm pre-hooks. */
export default function setup() {
  if (!existsSync('src/engine/data/names.generated.ts')) execSync('npx tsx scripts/gen-names.ts', { stdio: 'inherit' });
}
