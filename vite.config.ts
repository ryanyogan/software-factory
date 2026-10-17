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
    overrides: [{ files: ['apps/web/**', 'packages/ui/**'], plugins: ['typescript', 'react'] }],
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    ignorePatterns: [
      '**/drizzle/**',
      '.handoff/**',
      '.claude/**',
      'pnpm-lock.yaml',
      'skills-lock.json',
    ],
  },
  staged: {
    '*.{js,ts,tsx}': 'vp check --fix',
  },
});
