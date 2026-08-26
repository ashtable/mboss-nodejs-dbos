import type {
  BounceScanInput,
  StartBounceScan,
} from '../../src/workflows/bounce-scan.js';
import { steps } from '../helpers/dbos-double.js';

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

  /**
   * The steps that had already run when each scan
   * was asked for.
   *
   * Enqueueing a workflow is not a step, so it
   * leaves no mark of its own in the recorded
   * order. Reading the step list afterwards only
   * says what the whole run did; taking it here
   * says where in that run the enqueue happened.
   */
  readonly stepsAtStart: string[][] = [];

  readonly start: StartBounceScan = async (input) => {
    this.scans.push(input);
    this.stepsAtStart.push(steps.map((step) => step.name));
  };
}
