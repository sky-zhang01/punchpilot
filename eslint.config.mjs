import security from 'eslint-plugin-security';

const highConfidenceRules = [
  'detect-bidi-characters',
  'detect-buffer-noassert',
  'detect-child-process',
  'detect-disable-mustache-escape',
  'detect-eval-with-expression',
  'detect-new-buffer',
  'detect-no-csrf-before-method-override',
  'detect-non-literal-require',
  'detect-possible-timing-attacks',
  'detect-pseudoRandomBytes',
];

export default [
  {
    files: ['server/**/*.js'],
    linterOptions: {
      noInlineConfig: true,
    },
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
      ...Object.fromEntries(
        highConfidenceRules.map((rule) => [`security/${rule}`, 'error']),
      ),
    },
  },
  {
    ignores: ['node_modules/**', 'client/**', 'dist/**'],
  },
];
