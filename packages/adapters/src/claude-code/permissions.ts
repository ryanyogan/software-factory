import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Resolve symlinks through the deepest existing ancestor, so a link inside the worktree can't point out. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(real(parent), basename(p));
  }
}

/**
 * Host answer for permission prompts in unattended runs (paired with `permissionMode: 'acceptEdits'`,
 * which already auto-accepts edits inside cwd). Allows any tool the worktree run needs but denies when
 * a path a file tool touches resolves (after symlinks) outside the allowed roots. Bash is contained by
 * the OS sandbox (`defaultSandbox` in ./index), not by this guard.
 */
export function createPathGuard(roots: string[]): CanUseTool {
  const allowed = roots.map((r) => real(resolve(r)));
  const base = allowed[0] ?? process.cwd();
  return async (toolName, input, { blockedPath }) => {
    const candidates = [input.file_path, input.notebook_path, input.path, blockedPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    for (const p of candidates) {
      const abs = real(isAbsolute(p) ? resolve(p) : resolve(base, p));
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
