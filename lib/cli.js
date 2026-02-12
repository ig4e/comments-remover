const fs = require('fs').promises;
const path = require('path');
const { Parser, SINGLE_LINE, MULTI_LINE } = require('./parser');

const defaultExtMap = {
  '.js': 'javascript', '.jsx': 'javascriptreact', '.ts': 'typescript', '.tsx': 'typescriptreact',
  '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.go': 'go',
  '.rs': 'rust', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin',
  '.sh': 'shellscript', '.bash': 'shellscript', '.css': 'css', '.scss': 'scss', '.html': 'html',
  '.xml': 'xml', '.sql': 'sql', '.lua': 'lua', '.rs': 'rust', '.rb': 'ruby', '.scala': 'scala',
  '.yaml': 'yaml', '.yml': 'yaml', '.json': 'jsonc', '.cob': 'cobol'
};

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return defaultExtMap[ext] || 'unknown';
}

async function collectFiles(startPath, recursive = true, includeExts) {
  const stat = await fs.stat(startPath);
  const results = [];
  if (stat.isFile()) {
    results.push(startPath);
    return results;
  }
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) await walk(full);
      } else if (ent.isFile()) {
        if (!includeExts || includeExts.has(path.extname(ent.name).toLowerCase())) {
          results.push(full);
        }
      }
    }
  }
  await walk(startPath);
  return results;
}

function makeDocument(text) {
  const lines = text.split(/\r?\n/);
  return {
    getText: () => text,
    lineCount: lines.length,
    lineAt: (n) => ({ text: lines[n], rangeIncludingLineBreak: { start: { line: n, character: 0 }, end: { line: n + 1, character: 0 } } }),
    positionAt: (offset) => {
      if (offset >= text.length) { const l = lines.length - 1; return { line: l, character: lines[l].length }; }
      let cum = 0;
      for (let i = 0; i < lines.length; ++i) {
        const ln = lines[i].length + 1; // include newline
        if (cum + ln > offset) return { line: i, character: offset - cum };
        cum += ln;
      }
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    },
    offsetAt: (pos) => {
      let off = 0;
      for (let i = 0; i < pos.line; ++i) off += lines[i].length + 1;
      return off + pos.character;
    },
  };
}

function makeEditor(document) {
  return { document, selections: [ { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length), isEmpty: false } ] };
}

function makeTextEdit(document) {
  const deletes = [];
  return {
    delete: (range) => {
      // range: { start: {line,character}, end: {line,character} } OR rangeIncludingLineBreak
      const start = range.start || range.range?.start || range.rangeIncludingLineBreak?.start;
      const end = range.end || range.range?.end || range.rangeIncludingLineBreak?.end;
      const s = document.offsetAt(start);
      const e = document.offsetAt(end);
      if (s < e) deletes.push([s, e]);
    },
    applyEdits: (text) => {
      if (deletes.length === 0) return text;
      // merge & apply in reverse order
      deletes.sort((a,b) => a[0] - b[0]);
      let out = '';
      let last = 0;
      for (const [s,e] of deletes) {
        if (s < last) continue; // overlapping
        out += text.slice(last, s);
        last = e;
      }
      out += text.slice(last);
      return out;
    },
    hasEdits: () => deletes.length > 0,
  };
}

async function processFile(filePath, options = {}) {
  const src = await fs.readFile(filePath, 'utf8');
  const languageId = detectLanguage(filePath);
  const commentsFlag = options.onlySingle ? SINGLE_LINE : options.onlyMulti ? MULTI_LINE : (SINGLE_LINE | MULTI_LINE);

  const doc = makeDocument(src);
  const editor = makeEditor(doc);
  const edit = makeTextEdit(doc);

  const parser = new Parser(languageId, commentsFlag, options.prefix, options.keepJSDocString !== false, options.keepCommentRegex || [], () => {});
  parser.setRemoveBlankLineCount(options.removeBlankLinesBefore || 0, options.removeBlankLinesAfter || 0);
  parser.setC99(!!options.c99);

  parser.removeComments(editor, edit);

  if (!edit.hasEdits()) return { changed: false };

  const out = edit.applyEdits(src);
  if (options.backup) {
    await fs.writeFile(filePath + '.bak', src, 'utf8');
  }
  await fs.writeFile(filePath, out, 'utf8');
  return { changed: true };
}

async function processPath(targetPath, opts = {}) {
  const files = await collectFiles(targetPath, opts.recursive !== false, opts.includeExts ? new Set(opts.includeExts) : null);
  let changed = 0;
  for (const f of files) {
    try {
      const res = await processFile(f, opts);
      if (res.changed) {
        changed++;
        console.log(`Updated: ${f}`);
      }
    } catch (err) {
      console.error(`Failed: ${f}: ${err.message}`);
    }
  }
  return { total: files.length, changed };
}

function printHelp() {
  console.log('Usage: remove-comments <path> [options]\n');
  console.log('Options:');
  console.log('  --recursive / -r       Recursively process directories (default)');
  console.log('  --ext .js,.ts          Only process files with these extensions');
  console.log('  --single               Remove only single-line comments');
  console.log('  --multi                Remove only block/multi-line comments');
  console.log('  --backup               Save .bak copy before overwriting');
  console.log('  --dry-run              Show which files would change but do not write');
  console.log('  --prefix <str>         Keep comments that start with <str>');
  console.log('  --help                 Show help');
}

const readline = require('readline');

async function interactivePrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q, def) => new Promise(resolve => {
    const prompt = def ? `${q} (${def}): ` : `${q}: `;
    rl.question(prompt, ans => resolve(ans === '' ? def : ans));
  });

  try {
    const target = await question('Path to file or directory to process', '.');
    const extLine = await question('Include extensions (comma-separated, empty = all)', '');
    const recursiveAns = await question('Recurse into subdirectories? (y/N)', 'y');
    const backupAns = await question('Create .bak backups before overwrite? (y/N)', 'n');
    const dryRunAns = await question('Dry run (show changes but do not write)? (y/N)', 'n');
    const only = await question('Remove only (single/multi/none)', 'none');
    const prefix = await question('Keep comments that start with prefix (leave empty for none)', '');

    const opts = {
      recursive: /^y/i.test(recursiveAns),
      backup: /^y/i.test(backupAns),
      dryRun: /^y/i.test(dryRunAns),
      onlySingle: only === 'single',
      onlyMulti: only === 'multi',
      includeExts: extLine ? extLine.split(',').map(s => s.trim().toLowerCase()) : null,
      prefix: prefix || undefined
    };

    rl.close();
    const targetPath = path.resolve(process.cwd(), target || '.');
    const stats = await fs.stat(targetPath);
    if (stats.isFile()) {
      if (opts.dryRun) {
        const res = await processFile(targetPath, opts);
        console.log(res.changed ? 'Would change' : 'No change');
        return 0;
      }
      const res = await processFile(targetPath, opts);
      console.log(res.changed ? 'File updated' : 'No change');
      return 0;
    }
    const res = await processPath(targetPath, opts);
    console.log(`Processed ${res.total} files — updated ${res.changed}`);
    return 0;
  } catch (err) {
    rl.close();
    throw err;
  }
}

async function runFromArgs(argv) {
  if (!argv || argv.length === 0) {
    return interactivePrompt();
  }
  const args = argv.slice();
  const target = args.shift();
  const opts = {};
  for (let i = 0; i < args.length; ++i) {
    const a = args[i];
    if (a === '-r' || a === '--recursive') opts.recursive = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--backup') opts.backup = true;
    else if (a === '--single') opts.onlySingle = true;
    else if (a === '--multi') opts.onlyMulti = true;
    else if (a === '--help') { printHelp(); return 0; }
    else if (a === '--prefix') { opts.prefix = args[++i]; }
    else if (a === '--ext') { opts.includeExts = args[++i].split(',').map(s => s.trim().toLowerCase()); }
    else console.warn('Unknown option:', a);
  }

  const targetPath = path.resolve(process.cwd(), target);
  const stats = await fs.stat(targetPath);
  if (stats.isFile()) {
    if (opts.dryRun) {
      const res = await processFile(targetPath, opts);
      console.log(res.changed ? 'Would change' : 'No change');
      return 0;
    }
    const res = await processFile(targetPath, opts);
    console.log(res.changed ? 'File updated' : 'No change');
    return 0;
  }
  const res = await processPath(targetPath, opts);
  console.log(`Processed ${res.total} files — updated ${res.changed}`);
  return 0;
}

module.exports = { processFile, processPath, runFromArgs };
