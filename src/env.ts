import { z } from 'zod';

/**
 * A URL the worker concatenates paths onto. A
 * trailing slash would double up in
 * `${SITE_URL}/u/${token}`, producing a link that
 * looks right in the source and is wrong in the
 * inbox.
 */
const baseUrlSchema = z
  .string()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * The five values the worker cannot run without,
 * plus four with defaults. `MAIL_FROM` and
 * `SITE_URL` default to production because that
 * is the only place they are ever different from
 * the literal in the design.
 */
const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    DBOS_SYSTEM_DATABASE_URL: z.string().min(1).optional(),
    API_BASE_URL: baseUrlSchema,
    INTERNAL_API_TOKEN: z.string().min(1),
    LINK_KEYS: z.string().min(1),
    SENDGRID_API_KEY: z.string().min(1),
    SENDGRID_BASE_URL: baseUrlSchema.default('https://api.sendgrid.com'),
    MAIL_FROM: z.string().min(1).default('hello@mboss.dev'),
    SITE_URL: baseUrlSchema.default('https://mboss.dev'),
  })
  // DBOS keeps to its own schema in whichever
  // database it is pointed at, so the system
  // tables live beside the application's by
  // default. Deriving that rather than requiring
  // a second variable means the two cannot drift
  // apart by hand, and naming it explicitly still
  // moves DBOS somewhere else.
  .transform((env) => ({
    ...env,
    DBOS_SYSTEM_DATABASE_URL: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
  }));

export type Env = z.infer<typeof EnvSchema>;

/**
 * Throws with every missing or malformed variable
 * named at once. A worker that boots without its
 * key ring or its SendGrid key can do nothing but
 * fail one workflow at a time, so this failure
 * has to be loud and total rather than
 * per-variable and lazy.
 */
export function readEnv(source: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`invalid environment: ${problems}`);
}
