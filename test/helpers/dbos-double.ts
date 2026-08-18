/**
 * A stand-in for `@dbos-inc/dbos-sdk` that records
 * what the worker asked of DBOS and runs step
 * callbacks for real.
 *
 * The properties the hermetic suite asserts —
 * step order, step names, retry policies, what
 * happens inside a step rather than in a workflow
 * body — are properties of this repo's own code,
 * and none of them becomes truer with a system
 * database attached. What DBOS itself guarantees
 * is asserted against a real launch, under
 * `test/integration`.
 */

export type StepRecord = {
  name: string;
  config: Record<string, unknown>;
};

export type Call =
  | { kind: 'setConfig'; config: unknown }
  | { kind: 'registerWorkflow'; name: string }
  | { kind: 'launch' }
  | { kind: 'registerQueue'; name: string; options: unknown };

export const calls: Call[] = [];
export const steps: StepRecord[] = [];

let stepDepth = 0;

/** True while a step callback is on the stack. */
export function inStep(): boolean {
  return stepDepth > 0;
}

/** Clears the recordings. Call it in `beforeEach`. */
export function reset(): void {
  calls.length = 0;
  steps.length = 0;
  stepDepth = 0;
}

export const DBOS = {
  setConfig(config: unknown): void {
    calls.push({ kind: 'setConfig', config });
  },

  // Returns the function untouched, so a
  // registered workflow is callable as the plain
  // async function it is.
  registerWorkflow<Fn>(fn: Fn, config?: { name?: string }): Fn {
    calls.push({ kind: 'registerWorkflow', name: config?.name ?? '' });
    return fn;
  },

  async launch(): Promise<void> {
    calls.push({ kind: 'launch' });
  },

  async registerQueue(name: string, options?: unknown): Promise<void> {
    calls.push({ kind: 'registerQueue', name, options });
  },

  async runStep<Return>(
    fn: () => Promise<Return>,
    config: { name?: string } & Record<string, unknown>,
  ): Promise<Return> {
    steps.push({ name: config.name ?? '', config: { ...config } });
    stepDepth += 1;
    try {
      return await fn();
    } finally {
      stepDepth -= 1;
    }
  },

  async shutdown(): Promise<void> {},
};
