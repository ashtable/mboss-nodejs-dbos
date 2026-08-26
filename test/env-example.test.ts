import { readFileSync } from 'node:fs';

import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { readEnv } from '../src/env.js';

describe('.env.example', () => {
  it('parses the committed example against the schema', () => {
    const example = parse(
      readFileSync(new URL('../.env.example', import.meta.url)),
    );

    // The example is what a clean checkout copies
    // to `.env`, so a variable the schema requires
    // and the example does not set is a crash at
    // boot for whoever clones next. This is the
    // ratchet that makes the two move together.
    expect(() => readEnv(example)).not.toThrow();
  });
});
