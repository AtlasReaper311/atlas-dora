// Flat config, minimal on purpose: parse errors and real mistakes, not
// style debates. no-undef stays off because Worker globals (fetch,
// Response, caches) and Vitest globals would all need declaring for zero
// gain at this size.
export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
];
