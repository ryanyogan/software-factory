import { isAbsolute, resolve, sep } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Host answer for permission prompts in unattended runs (paired with `permissionMode: 'acceptEdits'`,
 * which already auto-accepts edits inside cwd). Allows any tool the worktree run needs (Bash etc.)
 * but denies when a path the tool touches resolves outside the allowed roots.
 */
export function createPathGuard(roots: string[]): CanUseTool {
  const allowed = roots.map((r) => resolve(r));
  const base = allowed[0] ?? process.cwd();
  return async (toolName, input, { blockedPath }) => {
    const candidates = [input.file_path, input.notebook_path, input.path, blockedPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    for (const p of candidates) {
      const abs = isAbsolute(p) ? resolve(p) : resolve(base, p);
      if (!allowed.some((r) => inside(r, abs))) {
        return {
          behavior: 'deny',
          message: `${toolName}: ${p} is outside the task worktree; this run may only touch files under ${base}.`,
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
