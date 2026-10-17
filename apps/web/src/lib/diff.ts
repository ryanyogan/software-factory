/** Minimal unified-diff parser for `diff.snapshot` patches (git diff with a/ b/ prefixes). */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** `a/foo` → `foo`; `/dev/null` → null. Handles git's quoted paths (`"a/with space"`). */
function stripPrefix(raw: string): string | null {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/x b/x`: the b-side is the best guess until ---/+++ or rename lines say more.
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = {
        path: m?.[2] ?? line.slice(11),
        oldPath: m?.[1] ?? null,
        status: 'modified',
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    const h = HUNK.exec(line);
    if (h) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }

    if (!hunk) {
      // Extended header lines.
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) file.status = 'added';
        else file.oldPath = p;
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) file.status = 'deleted';
        else file.path = p;
      }
      continue;
    }

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line });
    } else {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }

  for (const f of files) {
    if (f.status === 'deleted') f.path = f.oldPath ?? f.path;
    // Only renames keep a distinct old path.
    if (f.status !== 'renamed') f.oldPath = null;
  }
  return files;
}
