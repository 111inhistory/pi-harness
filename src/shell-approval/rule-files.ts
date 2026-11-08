import { readFile, stat } from 'node:fs/promises';

/**
 * Loads shell rule files from the provided paths in order.
 * Reads exact UTF-8 contents without interpreting globs, directories, or inline rules.
 * Rejects directories and special files; symlinks to regular files are permitted.
 * Throws an English descriptive error naming the failing path on error.
 */
export async function loadShellRuleFiles(paths: readonly string[]): Promise<readonly string[]> {
  const contents: string[] = [];
  for (const filePath of paths) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read rule file '${filePath}': ${message}`);
    }
    if (!fileStat.isFile()) {
      const type = fileStat.isDirectory() ? 'directory' : 'special file';
      throw new Error(`Rule file '${filePath}' is a ${type}, not a regular file`);
    }
    try {
      contents.push(await readFile(filePath, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read rule file '${filePath}': ${message}`);
    }
  }
  return contents;
}
