import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    ignorePatterns: [
      '**/dist/**',
      '**/.wrangler/**',
      '.claude/**',
      '.agents/**',
      '**/drizzle/**',
      '**/worker-configuration.d.ts',
      '**/routeTree.gen.ts',
    ],
    plugins: ['typescript', 'vitest'],
    options: { typeAware: true, typeCheck: true },
    overrides: [
      { files: ['apps/web/**', 'packages/ui/**'], plugins: ['typescript', 'react'] },
      // Workers RPC stubs return `Rpc.Result<T>` (a Promise intersection) that the type-aware
      // linter misreads as non-thenable; tsc accepts these awaits.
      { files: ['apps/api/**', 'apps/web/**'], rules: { 'typescript/await-thenable': 'off' } },
    ],
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    ignorePatterns: [
      '**/drizzle/**',
      '.handoff/**',
      '**/worker-configuration.d.ts',
      '**/.wrangler/**',
      '.claude/**',
      'pnpm-lock.yaml',
      'skills-lock.json',
      '**/routeTree.gen.ts',
    ],
  },
  staged: {
    '*.{js,ts,tsx}': 'vp check --fix',
  },
});
