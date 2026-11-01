import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/**
 * Self-check script for documentation assets:
 * 1. Link integrity: ensures all internal relative Markdown links point to existing files.
 * 2. Technical language: verifies writing guidelines from docs/writing-guide.md:
 *    - code fence balance (unclosed ``` blocks)
 *    - avoided packaging verbs (e.g. "进行检查") and vague conditions (e.g. "基本上", "适当")
 *    - mixed half-width punctuation after Chinese characters
 */

const rootDocs = [
  'AGENTS.md',
  'README.md',
  'prompts/README.md',
];

const docDirs = [
  'docs',
];

async function collectMarkdownFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectMarkdownFiles(full));
      } else if (entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
    return files;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const args = process.argv.slice(2);
let mdFiles = [];

if (args.length > 0) {
  mdFiles = args;
} else {
  const dirFiles = (await Promise.all(docDirs.map(collectMarkdownFiles))).flat();
  mdFiles = [...rootDocs, ...dirFiles].sort();
}

const linkErrors = [];
const languageErrors = [];
let totalLinksChecked = 0;

const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

// Packaging phrases and vague conditions defined in docs/writing-guide.md
const packagingPatterns = [
  { pattern: /进行(检查|处理|测试|分析|验证|修改|更新|评估|排查)/g, label: '包装动词 (直接使用动词，不写"进行...")' },
  { pattern: /基本上/g, label: '模糊条件词 (写明具体条件，不用"基本上")' },
  { pattern: /适当/g, label: '模糊条件词 (写明具体条件，不用"适当")' },
];

for (const file of mdFiles) {
  const content = await readFile(file, 'utf8');
  const lines = content.split('\n');

  // --- 1. Link Check ---
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const rawTarget = match[2].trim();
    // Skip external URLs, mailto and page-local anchors
    if (
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:') ||
      rawTarget.startsWith('#')
    ) {
      continue;
    }

    totalLinksChecked++;
    const [pathPart] = rawTarget.split('#');
    if (!pathPart) continue;

    const targetPath = resolve(dirname(file), pathPart);
    try {
      await stat(targetPath);
    } catch {
      // Find line number
      const offset = match.index;
      const lineNum = content.slice(0, offset).split('\n').length;
      linkErrors.push({
        file,
        line: lineNum,
        rawTarget,
        message: `Dead link: target does not exist (${pathPart})`,
      });
    }
  }

  // --- 2. Technical Language Check ---
  // Unclosed code fences
  const fences = content.match(/^```/gm) || [];
  if (fences.length % 2 !== 0) {
    languageErrors.push({
      file,
      line: lines.length,
      message: `Unclosed code block: odd number of code fences (${fences.length})`,
    });
  }

  // Skip archive, reviews, and writing-guide itself from prose rule enforcement
  const isHistoricOrMeta =
    file.includes('/archive/') ||
    file.includes('/reviews/') ||
    file.endsWith('writing-guide.md');

  if (!isHistoricOrMeta) {
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Strip inline code blocks before inspecting prose
      const prose = line.replace(/`[^`]+`/g, '');

      // Check mixed punctuation (Chinese character followed directly by half-width comma or period)
      if (/[\u4e00-\u9fa5],/.test(prose) || /[\u4e00-\u9fa5]\./.test(prose)) {
        languageErrors.push({
          file,
          line: i + 1,
          message: `混用半角标点: 中文正文应使用中文标点 (，。): "${line.trim()}"`,
        });
      }

      // Check packaging verbs and vague conditions
      for (const { pattern, label } of packagingPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(prose)) {
          languageErrors.push({
            file,
            line: i + 1,
            message: `${label}: "${line.trim()}"`,
          });
        }
      }
    }
  }
}

// Summary
let failed = false;

if (linkErrors.length > 0) {
  failed = true;
  console.error(`\n[Link Check] Found ${linkErrors.length} dead link(s):`);
  for (const err of linkErrors) {
    console.error(`  - ${err.file}:${err.line} -> ${err.rawTarget} (${err.message})`);
  }
} else {
  console.log(`[Link Check] Passed: verified ${totalLinksChecked} local link(s) across ${mdFiles.length} file(s).`);
}

if (languageErrors.length > 0) {
  failed = true;
  console.error(`\n[Technical Language Check] Found ${languageErrors.length} issue(s):`);
  for (const err of languageErrors) {
    console.error(`  - ${err.file}:${err.line}: ${err.message}`);
  }
} else {
  console.log(`[Technical Language Check] Passed: all active documents follow writing guidelines.`);
}

if (failed) {
  process.exitCode = 1;
}
