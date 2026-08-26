import type {
  BounceScanInput,
  StartBounceScan,
} from '../../src/workflows/bounce-scan.js';

/**
 * Records the scans a sender asked for without
 * starting one.
 *
 * A sender's test is about what it handed over —
 * which addresses, against which operations. What
 * happens to that batch afterwards is
 * `bounceScan`'s own tests.
 */
export class FakeBounceScan {
  readonly scans: BounceScanInput[] = [];

  readonly start: StartBounceScan = async (input) => {
    this.scans.push(input);
  };
}
