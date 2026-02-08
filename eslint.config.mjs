import security from 'eslint-plugin-security';

export default [
  {
    files: ['server/**/*.js'],
    plugins: { security },
    rules: {
      ...security.configs.recommended.rules,
    },
  },
  {
    ignores: ['node_modules/**', 'client/**', 'dist/**'],
  },
];
