import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * `@mboss/core`'s barrel re-exports the
 * workflow-core modules, which depend on elkjs
 * and ts-morph. This worker needs only
 * signed-links and email — both dependency-free —
 * so importing the barrel would pull a
 * graph-layout engine and a TypeScript compiler
 * wrapper into this service's type graph for
 * nothing. The allow-list below names exactly
 * those two subpaths and blocks every other, the
 * barrel included. `test/lint-rules.test.ts`
 * proves the rule actually fires.
 */
const coreSubpathOnly =
  'Cloud repos import only the @mboss/core/signed-links ' +
  'and @mboss/core/email subpaths. The barrel would pull ' +
  'elkjs and ts-morph into the cloud type graph.';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      // Nested submodules lint in their own
      // repos.
      'mboss-zod/**',
      'mboss-core/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@mboss/core', message: coreSubpathOnly }],
          patterns: [
            {
              group: [
                '@mboss/core/*',
                '!@mboss/core/signed-links',
                '!@mboss/core/email',
              ],
              message: coreSubpathOnly,
            },
          ],
        },
      ],
    },
  },
  prettier, // last — turns off rules that fight Prettier
);
