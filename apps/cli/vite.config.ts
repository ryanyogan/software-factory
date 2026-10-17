import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    // Every dependency is a devDependency, so it is bundled: dist/ runs with plain `node`.
    // Subcommands are dynamic imports → separate chunks, so cold start only loads citty.
    dts: false,
    clean: true,
    deps: { onlyBundle: ['citty', 'zod'] },
  },
  test: { include: ['src/**/*.test.ts'] },
});
