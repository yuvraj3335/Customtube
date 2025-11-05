import globals from 'globals';

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-fallthrough': 'error',
  'no-shadow-restricted-names': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implied-eval': 'error',
  'no-eval': 'error',
  'no-new-func': 'error',
};

export default [
  { ignores: ['node_modules/**', 'data/**', '.cache/**', 'test-results/**'] },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules,
  },
  {
    // page.evaluate() callbacks run in the browser
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser },
    rules,
  },
];
