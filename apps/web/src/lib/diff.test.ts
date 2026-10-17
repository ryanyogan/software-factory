import { describe, expect, it } from 'vite-plus/test';
import { parseUnifiedDiff } from './diff';

const PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import x from 'x';
-const a = 1;
+const a = 2;
+const b = 3;
 
 export { a };
@@ -10,2 +11,2 @@ function f() {
-  return 1;
+  return 2;
 }
\\ No newline at end of file
diff --git a/new.md b/new.md
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
index ce01362..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.txt b/b.txt
similarity index 90%
rename from a.txt
rename to b.txt
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..1234567
Binary files /dev/null and b/logo.png differ
`;

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(PATCH);

  it('splits files with status and +/- stats', () => {
    expect(
      files.map((f) => [f.path, f.status, f.additions, f.deletions, f.oldPath, f.binary]),
    ).toEqual([
      ['src/app.ts', 'modified', 3, 2, null, false],
      ['new.md', 'added', 1, 0, null, false],
      ['old.txt', 'deleted', 0, 1, null, false],
      ['b.txt', 'renamed', 0, 0, 'a.txt', false],
      ['logo.png', 'added', 0, 0, null, true],
    ]);
  });

  it('numbers old/new lines per hunk', () => {
    const [h1, h2] = files[0]!.hunks;
    expect(h1!.header).toBe('@@ -1,4 +1,5 @@');
    expect(h1!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['add', undefined, 2],
      ['add', undefined, 3],
      ['ctx', 3, 4],
      ['ctx', 4, 5],
    ]);
    expect(h2!.lines.map((l) => l.kind)).toEqual(['del', 'add', 'ctx', 'meta']);
    expect(h2!.lines[0]).toMatchObject({ oldNo: 10, text: '  return 1;' });
  });

  it('handles empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
