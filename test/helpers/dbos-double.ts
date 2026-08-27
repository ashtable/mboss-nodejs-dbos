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
  | { kind: 'registerQueue'; name: string; options: unknown }
  | { kind: 'startWorkflow'; params: unknown; input: unknown };

export const calls: Call[] = [];
export const steps: StepRecord[] = [];

/**
 * Every durable sleep, in seconds. The schedule a
 * test runs against is shrunk by handing the
 * workflow smaller delays — the clock itself is
 * never mocked, so what is asserted is the number
 * the workflow asked to sleep for.
 */
export const sleeps: number[] = [];

let stepDepth = 0;
let currentWorkflowID: string | undefined;

/** True while a step callback is on the stack. */
export function inStep(): boolean {
  return stepDepth > 0;
}

/**
 * Stands the test inside a running workflow, for
 * code that derives an id from the one it is
 * running under.
 */
export function setWorkflowID(id: string | undefined): void {
  currentWorkflowID = id;
}

/** Clears the recordings. Call it in `beforeEach`. */
export function reset(): void {
  calls.length = 0;
  steps.length = 0;
  sleeps.length = 0;
  stepDepth = 0;
  currentWorkflowID = undefined;
}

/**
 * The real SDK refuses to start a workflow or
 * sleep durably from inside a step, so the double
 * refuses too — otherwise a workflow that only
 * fails in production passes here.
 */
function refuseInsideStep(what: string): void {
  if (inStep())
    throw new Error(`Invalid call to a 'workflow' function (${what})`);
}

export const DBOS = {
  get workflowID(): string | undefined {
    return currentWorkflowID;
  },

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

  /**
   * Records the enqueue and does not run the
   * target. A sender's test asserts what it asked
   * for; running the scan it starts would drag a
   * two-day workflow into a unit test of a send.
   */
  startWorkflow<Args extends unknown[], Return>(
    _target: (...args: Args) => Promise<Return>,
    params?: unknown,
  ): (...args: Args) => Promise<void> {
    refuseInsideStep('startWorkflow');
    return async (...args: Args) => {
      calls.push({ kind: 'startWorkflow', params, input: args[0] });
    };
  },

  async sleepSeconds(seconds: number): Promise<void> {
    refuseInsideStep('sleepSeconds');
    sleeps.push(seconds);
  },

  /**
   * The real SDK's retry loop with the backoff
   * sleeps left out: try the body, and on a
   * failure try again while the policy allows it
   * and attempts remain. Retries are off unless
   * the step asks for them, and `maxAttempts`
   * defaults to three, both as the SDK has it.
   *
   * A step that exhausts its attempts rethrows the
   * last error where the SDK wraps the run of them
   * in an error of its own. Nothing here turns on
   * which of the two comes back — only on whether
   * the call was made again at all.
   */
  async runStep<Return>(
    fn: () => Promise<Return>,
    config: { name?: string } & Record<string, unknown>,
  ): Promise<Return> {
    steps.push({ name: config.name ?? '', config: { ...config } });
    stepDepth += 1;
    try {
      const maxAttempts =
        config['retriesAllowed'] === true
          ? ((config['maxAttempts'] as number | undefined) ?? 3)
          : 1;
      const shouldRetry = config['shouldRetry'] as
        ((error: unknown) => boolean) | undefined;

      for (let attempt = 1; ; attempt += 1) {
        try {
          return await fn();
        } catch (error) {
          if (attempt >= maxAttempts) throw error;
          if (shouldRetry !== undefined && !shouldRetry(error)) throw error;
        }
      }
    } finally {
      stepDepth -= 1;
    }
  },

  async shutdown(): Promise<void> {},
};
