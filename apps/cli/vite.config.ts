import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    // Workspace packages (@sf/*) and devDependencies are bundled, so dist/ runs with plain `node`.
    // Subcommands are dynamic imports → separate chunks, so cold start only loads citty.
    // The agent SDKs are real `dependencies` (native binaries, ~700 MB): never bundled, imported
    // lazily by the adapters only when `sf daemon` starts a session.
    dts: false,
    clean: true,
    deps: {
      onlyBundle: ['citty', 'zod'],
      neverBundle: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
    },
  },
  test: { include: ['src/**/*.test.ts'], testTimeout: 20_000 },
});
