const SINGLE_LINE = 1;
const MULTI_LINE = 2;
const encodingMarker = '-*-';

function getProperty(obj, prop, deflt) { return obj && Object.prototype.hasOwnProperty.call(obj, prop) ? obj[prop] : deflt; }
function isString(obj) { return typeof obj === 'string'; }

/** @param {string} text */
function regexpEscape(text) {
  return text.replace(/[[\]*|(){}\\.?^$+]/g, m => `\\${m}`);
}

/** Returns [from, to) @param {Number} from @param {Number} to */
function range(from, to) {
  return [...Array(to - from).keys()].map(k => k + from);
}

class Parser {
  constructor(languageID, comments, prefix, keepJSDocString, keepCommentRegex, extractStringsCB) {
    this.commentDelimiters = [];
    this.stringDelimiters = [];
    this.singleLineComments = (comments & SINGLE_LINE) !== 0;
    this.multiLineComments = (comments & MULTI_LINE) !== 0;
    this.prefix = prefix;
    this.supportedLanguage = true;
    this.commentLineRE = undefined;
    this.indentComments = false;
    this.commentIndent = undefined;
    this.indentCommentContinuationLine = false;
    this.previousLineCommentLine = false;
    this.keepCommentLine = false;
    this.nestedBlockComment = false;
    this.blockCommentLevel = undefined;
    this.selectionSplit = undefined;
    this.keepJSDocString = keepJSDocString;
    this.keepCommentRegex = keepCommentRegex || [];
    this.extractStringsCB = extractStringsCB || (() => {});
    /** @type RegExpExecArray */
    this.blockCommentEndResult = undefined;
    this.languageId = languageID;
    this.setDelimiter(languageID);
    this.removeEmptyNBefore = 0;
    this.removeEmptyNAfter  = 0;
    this.c99 = false;
  }
  /** @param {string} text @returns string */
  getIndent(text) {
    return text.replace(/(^[ \t]*).*/, '$1');
  }
  /** @param {string} text @returns bool */
  isCommentLine(text) {
    if (this.commentLineRE === undefined) { return false; }
    if (text.length === 0) { return false; }
    this.indentCommentContinuationLine = false;
    if (this.indentComments && this.previousLineCommentLine) {
      let lineIndent = this.getIndent(text);
      if (lineIndent.startsWith(this.commentIndent) && (lineIndent.length > this.commentIndent.length)) {
        this.indentCommentContinuationLine = true;
        return true;
      }
    }
    this.commentLineRE.lastIndex = 0; // in case the `g` flag was defined
    let result = this.commentLineRE.test(text);
    if (result) {
      this.commentIndent = this.getIndent(text);
    }
    return result;
  }
  /** @param {string} text @param {RegExp} reEnd */
  findBlockCommentEnd(text, reEnd) {
    let result;
    while ((result = reEnd.exec(text)) !== null) {
      if (this.nestedBlockComment && result[1]) {
        this.blockCommentLevel++;
        continue;
      }
      if (result[2] !== undefined) { // can match an empty string
        this.blockCommentLevel--;
        if (this.blockCommentLevel === 0) {
          this.nestedBlockComment = false;
          this.blockCommentEndResult = result;
          return true;
        }
      }
    }
    return false;
  }
  /** @param {Object} document @param {Array} selections */
  *splitSelections(document, selections) {
    let sectionBreaks = [];
    if (this.selectionSplit !== undefined) {
      sectionBreaks = [ {'offset': 0, 'languageId': this.selectionSplit.defaultLanguageId} ];
      let text = document.getText();
      let offset = 0;
      while (true) {
        // is there a section break ahead
        let section = this.selectionSplit.sections.reduce((acc, config) => {
          let startRE = new RegExp(config.start, 'g');
          startRE.lastIndex = offset;
          let result = startRE.exec(text);
          if (result === null) { return acc; }
          if (acc.offset === undefined || result.index < acc.offset) {
            return {'offset': result.index, result, config, startRE};
          }
          return acc;
        }, {'offset': undefined, result: undefined, config: undefined, startRE: undefined});
        if (section.offset === undefined) { break; }
        let languageId = section.config.languageId.replace(/\$\{(\d+):\?([^:]+):([^}]+)\}/g, (m, p1, p2, p3) => {
          return (section.result[Number(p1)] !== undefined) ? p2 : p3;
        });
        offset = section.startRE.lastIndex;
        section.startRE.lastIndex = 0;
        languageId = section.result[0].replace(section.startRE, languageId);
        if (section.offset > sectionBreaks[sectionBreaks.length-1].offset) {
          sectionBreaks.push( {'offset': section.offset, languageId} );
        } else {
          sectionBreaks[sectionBreaks.length-1].languageId = languageId;
        }
        let stopRE = new RegExp(section.config.stop, 'g');
        stopRE.lastIndex = offset;
        let result = stopRE.exec(text);
        if (result !== null) {
          sectionBreaks.push( {'offset': result.index, 'languageId': this.selectionSplit.defaultLanguageId} );
          offset = stopRE.lastIndex;
        }
      }
      if (sectionBreaks[sectionBreaks.length-1].offset !== text.length) {
        sectionBreaks.push( {'offset': text.length, 'languageId': undefined} );
      }
    }
    for (const selection of selections) {
      if (selection.isEmpty) { continue; }
      if (this.selectionSplit === undefined) {
        yield [selection, this.languageId];
        continue;
      }
      const seclectionStartOffset = document.offsetAt(selection.start);
      const seclectionEndOffset = document.offsetAt(selection.end);
      for (let sectionNr = 1; sectionNr < sectionBreaks.length; ++sectionNr) {
        const languageId = sectionBreaks[sectionNr-1].languageId;
        const sectionStartOffset = sectionBreaks[sectionNr-1].offset;
        const sectionEndOffset = sectionBreaks[sectionNr].offset;
        if (sectionEndOffset <= seclectionStartOffset || seclectionEndOffset <= sectionStartOffset) {
          continue; // no overlap
        }
        yield [
          { start: document.positionAt(Math.max(seclectionStartOffset, sectionStartOffset)),
            end: document.positionAt(Math.min(seclectionEndOffset, sectionEndOffset)),
            isEmpty: false
          },
          languageId
        ];
      }
    }
  }
  /** @param {string} text */
  isEncodingLine(text) {
    text = text.trim();
    return text.startsWith(encodingMarker) && text.endsWith(encodingMarker);
  }
  /** @param {Number} removeEmptyNBefore @param {Number} removeEmptyNAfter */
  setRemoveBlankLineCount(removeEmptyNBefore, removeEmptyNAfter) {
    this.removeEmptyNBefore = removeEmptyNBefore;
    this.removeEmptyNAfter  = removeEmptyNAfter;
  }
  /** @param {boolean} enable */
  setC99(enable) {
    this.c99 = enable;
  }
  /** @param {Object} editor  @param {Object} edit */
  removeComments(editor, edit) {
    if (!editor) { return; }
    let selections = Array.from(editor.selections);
    if (selections.length === 1 && selections[0].isEmpty) {
      selections = [{ start: { line: 0, character: 0 }, end: editor.document.positionAt(editor.document.getText().length), isEmpty: false }];
    }
    let insideComment = false;
    let insideCommentLanguageID = undefined;
    let removeRanges = [];
    let reEnd = new RegExp("_");
    let rangeStart = { line: 0, character: 0 }; // placeholder
    let rangeCommentTextStart = { line: 0, character: 0 };
    let document = editor.document;
    for (const [selection, languageId] of this.splitSelections(document, selections)) {
      if (insideComment) {
        if (languageId !== insideCommentLanguageID) {
          continue;
        }
      } else {
        insideCommentLanguageID = undefined;
        removeRanges = [];
        reEnd = new RegExp("_");
        rangeStart = undefined;
        rangeCommentTextStart = undefined;
      }
      if (selection.isEmpty) { continue; }
      this.setDelimiter(languageId);
      let startLine = selection.start.line;
      let endLine   = selection.end.line;
      let insideString = false;
      let charIdxOpenDelim = -1;
      this.previousLineCommentLine = false;
      this.commentIndent = undefined;
      this.keepCommentLine = false;
      loopLine:
      for (var lineNr = startLine; lineNr <= endLine; ++lineNr) {
        let line = document.lineAt(lineNr);
        let text = line.text;
        if (lineNr === 0 && text.startsWith('#!')) {
          continue loopLine;
        }
        let charStartIdx = 0;
        if (lineNr === endLine) {
          text = text.substring(0, selection.end.character);
          if (text === '') { continue loopLine; }
        }
        if (lineNr === startLine) {
          charStartIdx = selection.start.character;
        }
        if (insideString || insideComment) {
          reEnd.lastIndex = 0;
          if (insideString) {
            let result = reEnd.exec(text);
            if (result === null) {
              continue loopLine;
            }
            this.extractStringsCB(rangeStart, { line: lineNr, character: reEnd.lastIndex });
          } else {
            if (!this.findBlockCommentEnd(text, reEnd)) {
              continue loopLine;
            }
            if (this.multiLineComments && !this.keepComment(document, { start: rangeCommentTextStart, end: { line: lineNr, character: this.blockCommentEndResult.index } }, charIdxOpenDelim)) {
              removeRanges.push({ start: rangeStart, end: { line: rangeStart.line, character: document.lineAt(rangeStart.line).text.length } });
              if (rangeStart.line+1 !== lineNr) {
                removeRanges.push({ start: { line: rangeStart.line+1, character: 0 }, end: { line: lineNr, character: 0 } });
              }
              removeRanges.push({ start: { line: lineNr, character: 0 }, end: { line: lineNr, character: reEnd.lastIndex } });
            }
          }
          rangeStart = undefined;
          rangeCommentTextStart = undefined;
          charIdxOpenDelim = -1;
          insideComment = false;
          insideCommentLanguageID = undefined;
          insideString = false;
          charStartIdx = reEnd.lastIndex;
        } else {
          if (this.isCommentLine(text)) {
            if (!this.indentCommentContinuationLine) {
              this.keepCommentLine = this.keepComment(document, { start: { line: lineNr, character: this.commentLineRE.lastIndex }, end: { line: lineNr, character: text.length } }, 0);
            }
            if (this.singleLineComments && !this.keepCommentLine) {
              removeRanges.push({ start: { line: lineNr, character: charStartIdx }, end: { line: lineNr, character: text.length } });
            }
            this.previousLineCommentLine = true;
            continue loopLine;
          }
        }
        this.previousLineCommentLine = false;
        this.commentIndent = undefined;
        this.keepCommentLine = false;
        loopChar:
        for (let charIdx = charStartIdx; charIdx < text.length; ++charIdx) {
          for (const strDelim of this.stringDelimiters) {
            if (text.startsWith(strDelim[0], charIdx)) {
              if (strDelim[0] === "/**" && text.startsWith("/***", charIdx)) {
                break; // this is not a JSDOC to keep but a comment
              }
              rangeStart = { line: lineNr, character: charIdx };
              if (strDelim[1] === '\\n') {
                this.extractStringsCB(rangeStart, { line: lineNr, character: text.length });
                continue loopLine;
              }
              charIdx += strDelim[0].length;
              reEnd = new RegExp(`(\\\\.|.)*?${regexpEscape(strDelim[1] ? strDelim[1] : strDelim[0])}`, 'y');
              reEnd.lastIndex = charIdx;
              let result = reEnd.exec(text);
              if (result) {
                this.extractStringsCB(rangeStart, { line: lineNr, character: reEnd.lastIndex });
                charIdx = reEnd.lastIndex-1;
                continue loopChar;
              }
              insideString = true;
              continue loopLine;
            }
          }
          for (const commDelim of this.commentDelimiters) {
            if (text.startsWith(commDelim[0], charIdx)) {
              charIdxOpenDelim = charIdx;
              rangeCommentTextStart = { line: lineNr, character: charIdx + commDelim[0].length };
              let pos = charIdx;
              while ((pos > 0) && (text.charAt(pos-1) <= ' ')) {
                pos--;
              }
              rangeStart = { line: lineNr, character: pos };
              charIdx += commDelim[0].length;
              if (commDelim[1] === undefined && commDelim[3] === undefined) {
                if (this.singleLineComments && !this.keepComment(document, { start: rangeCommentTextStart, end: { line: lineNr, character: text.length } }, charIdxOpenDelim)) {
                  removeRanges.push({ start: rangeStart, end: { line: lineNr, character: text.length } });
                }
                continue loopLine;
              }
              let [openDelim, closeDelim] = [commDelim[0], commDelim[1]];
              if (commDelim[2]) {
                this.nestedBlockComment = true;
                [openDelim, closeDelim] = [commDelim[1], commDelim[2]];
              }
              if (commDelim[3]) {
                [openDelim, closeDelim] = [commDelim[0], commDelim[3]];
                reEnd = new RegExp(`(${regexpEscape(openDelim)})|(${closeDelim})`, 'g');
              } else {
                reEnd = new RegExp(`(${regexpEscape(openDelim)})|(${regexpEscape(closeDelim)})`, 'g');
              }
              reEnd.lastIndex = charIdx;
              this.blockCommentLevel = 1;
              if (this.findBlockCommentEnd(text, reEnd)) {
                if (this.singleLineComments && !this.keepComment(document, { start: rangeCommentTextStart, end: { line: lineNr, character: this.blockCommentEndResult.index } }, charIdxOpenDelim)) {
                  removeRanges.push({ start: rangeStart, end: { line: lineNr, character: reEnd.lastIndex } });
                }
                charIdx = reEnd.lastIndex-1;
                continue loopChar;
              }
              insideComment = true;
              insideCommentLanguageID = languageId;
              continue loopLine;
            }
          }
        }
      }
      if (insideComment) { continue; }
      const emptyLineTestRE = new RegExp('^\\s*$');
      let linesMultilineBlockDeleted = new Set();
      let linesDeletePending = new Map();
      const deleteEmptyLines = (lineNrs, startLine, lastLine) => {
        for (const lineNrDel of lineNrs) {
          if (lineNrDel < startLine || lineNrDel > lastLine || linesDeletePending.has(lineNrDel)) { break; }
          let line = document.lineAt(lineNrDel);
          if (!emptyLineTestRE.test(line.text)) { break; }
          linesDeletePending.set(lineNrDel, line.rangeIncludingLineBreak);
        }
      }
      while (removeRanges.length > 0) {
        let rangesThisLine = [ removeRanges.shift() ];
        let lineNr = rangesThisLine[0].start.line;
        while ((removeRanges.length > 0) && (removeRanges[0].start.line === lineNr)) {
          rangesThisLine.push(removeRanges.shift());
        }
        if (rangesThisLine[0].end.line !== lineNr) {
          edit.delete(rangesThisLine[0]);
          range(rangesThisLine[0].start.line, rangesThisLine[0].end.line).forEach(v => linesMultilineBlockDeleted.add(v));
          continue;
        }
        let line = document.lineAt(lineNr);
        if (emptyLineTestRE.test(rangesThisLine.reduceRight((t, range) => t.substring(0, range.start.character) + t.substring(range.end.character), line.text))) {
          edit.delete(line.rangeIncludingLineBreak);
          let lastLine = endLine;
          if (selection.end.character === 0) { lastLine -= 1; }
          deleteEmptyLines(range(lineNr-this.removeEmptyNBefore, lineNr).reverse(), startLine, lastLine);
          deleteEmptyLines(range(lineNr+1, lineNr+this.removeEmptyNAfter+1), startLine, lastLine);
          continue;
        }
        rangesThisLine.forEach(r => { edit.delete(r); });
      }
      linesMultilineBlockDeleted.forEach(k => linesDeletePending.delete(k));
      for (const r of linesDeletePending.values()) {
        edit.delete(r);
      }
    }
  }

  setDelimiter(languageID) {
    this.supportedLanguage = true;
    this.commentDelimiters = [];
    this.stringDelimiters = [];

    languageID = languageID.toLowerCase();
    switch (languageID) {

      case "unknown":
        break;

      case "python":
      case "toml":
        this.stringDelimiters.push(["'''"]);
      case "lmps":
        this.stringDelimiters.push(['"""']);
      case "yaml":
        this.stringDelimiters.push(["'"]);
      case "uiua":
      case "r":
        this.stringDelimiters.push(['"']);
        this.commentDelimiters.push(["#"]);
        if (languageID === 'lmps') {
          this.commentDelimiters = [];
          this.commentDelimiters.push(["#", undefined, undefined, '(?<!&)$']);
        }
        break;

      case "javascriptreact":
      case "typescriptreact":
        this.commentDelimiters.push(["{/*", "*/}"]);
      case "javascript":
      case "typescript":
        if (this.keepJSDocString) {
          this.stringDelimiters.push(["/**", "*/"]);  // JSDOC
        }
        this.stringDelimiters.push(["`"]);
      case "dart":
      case "haxe":
        this.stringDelimiters.push(["'"]);
      case "cpp":
      case "csharp":
      case "objective-c":
      case "objective-cpp":
      case "go":
        if (languageID === 'go') {
          this.stringDelimiters.push(["`"]);
        }
      case "java":
      case "kotlin":
      case "scala":
      case "shaderlab":
      case "solidity":
      case "swift":
      case "verilog":
      case "systemverilog":
      case "jsonc":
        this.commentDelimiters.push(["/*", "*/"]);
        this.commentDelimiters.push(["//"]);
        this.stringDelimiters.push(['"']);
        break;

      case "c":
        this.commentDelimiters.push(["/*", "*/"]);
        if (this.c99) {
          this.commentDelimiters.push(["//"]);
        }
        this.stringDelimiters.push(['"']);
        break;

      case "shellscript":  // bash
        this.commentLineRE = new RegExp("^[ \\t]*#", "g");
        break;

      case "rust":
        this.commentDelimiters.push(["/*", "/*", "*/"]);
        this.commentDelimiters.push(["//"]);
        this.stringDelimiters.push(['"']);
        break;

      case "racket":
        this.commentDelimiters.push(["#|", "#|", "|#"]);
        this.commentDelimiters.push(["#!"]);
        this.commentDelimiters.push([";"]);
        this.stringDelimiters.push(['"']);
        break;

      case "scheme":
        this.commentDelimiters.push(["#|", "#|", "|#"]);
        this.commentDelimiters.push(["#!", "!#"]);
        this.commentDelimiters.push([";"]);
        this.stringDelimiters.push(['"']);
        break;

      case "elixir":
        this.stringDelimiters.push(['@moduledoc """', '"""']);
        this.stringDelimiters.push(['@doc """', '"""']);
        this.stringDelimiters.push(['"']);
        this.commentDelimiters.push(["#"]);
        break;

      case "graphql":
        this.stringDelimiters.push(['"""']);
        this.stringDelimiters.push(['"']);
        this.commentDelimiters.push(["#"]);
        break;

      case "julia":
        this.commentDelimiters.push(["#=", "=#"]);
        this.commentDelimiters.push(["#"]);
        this.stringDelimiters.push(['"']);
      break;

      case "clojure":
        this.stringDelimiters.push(["'"]);
      case "lisp":
        this.stringDelimiters.push(['"']);
        this.commentDelimiters.push([";"]);
        break;

      case "erlang":
        this.commentDelimiters.push(["%"]);
        this.stringDelimiters.push(['"']);
        break;

      case "latex":
        this.commentLineRE = new RegExp("^%", "g");
        break;

      case "dockerfile":
        this.commentLineRE = new RegExp("^#(?!\\s*(syntax|escape)\\s*=)", 'ig');
        break;

      case "groovy":
        this.stringDelimiters.push(['"""']);
        this.stringDelimiters.push(["'''"]);
        this.commentDelimiters.push(["/*", "*/"]);
      case "al":
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        this.commentDelimiters.push(["//"]);
        break;

      case "lua":
        this.commentDelimiters.push(["--[[", "]]"]);
        this.commentDelimiters.push(["--"]);
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        break;

      case "vhdl":
        this.commentDelimiters.push(["/*", "*/"]);
      case "ada":
      case "haskell":
        this.stringDelimiters.push(['"']);
        this.commentDelimiters.push(["--"]);
        break;

      case "sql":
        this.stringDelimiters.push(['"']);
      case "plsql":
      case "spark":
        this.stringDelimiters.push(["'"]);
        this.commentDelimiters.push(["--"]);
        this.commentDelimiters.push(["/*", "*/"]);
        break;

      case "fsharp":
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["(*", "*)"]);
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(['"""']);
        break;

      case "pascal":
      case "objectpascal":
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["(*", "*)"]);
        this.commentDelimiters.push(["{", "}"]);
        this.stringDelimiters.push(["'"]);
      break;

      case "makefile":
      case "ini":
      case "properties":  // *.conf
        this.commentLineRE = new RegExp("^\\s*#", "g");
        break;

      case "coffeescript":
        this.commentDelimiters.push(["###", "###"]);
        this.commentDelimiters.push(["#"]);
        this.stringDelimiters.push(['"']);
        break;

      case "cfml":
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["/*", "*/"]);
        break;

      case "less":
      case "scss":
      case "stylus":
        this.commentDelimiters.push(["//"]);
      case "css":
      case "tailwindcss":
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        this.commentDelimiters.push(["/*", "*/"]);
        break;

      case "sass":
        this.commentLineRE = new RegExp("^(//|/\\*)", "g");
        this.indentComments = true;
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["/*", "*/"]);
        break;

      case "svelte":
      case "html":
        this.selectionSplit = {
          'defaultLanguageId': 'html',
          'sections': [
            {
              'start': '<style[^>/]*>',
              'stop': '</style>',
              'languageId': 'css'
            },
            {
              'start': '<script[^>]*>',
              'stop': '</script>',
              'languageId': 'javascript'
            }
          ]
        };
        if (languageID === 'svelte') {
          this.selectionSplit.sections.unshift({
            'start': '<script[^>]* lang="ts"[^>]*>',
            'stop': '</script>',
            'languageId': 'typescript'
          });
        }
      case "xml":
        this.commentDelimiters.push(["<!--", "-->"]);
        break;

      case "terraform":
        this.commentDelimiters.push(["#"]);
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["/*", "*/"]);
        break;

      case "acucobol":
      case "opencobol":
      case "bitlang-cobol":
      case "cobol":
        this.commentLineRE = new RegExp("^......[*/]", "g");
        break;

      case "powershell":
        this.commentDelimiters.push(["<#", "#>"]);
        this.commentDelimiters.push(["#"]);
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        break;

      case "perl":
        this.stringDelimiters.push(["'"]);
      case "ruby":
        this.commentDelimiters.push(["#"]);
        this.commentDelimiters.push(["=begin", "=cut"]);
        this.stringDelimiters.push(['"']);
        break;

      case "perl6": // Raku, Rakudo - https://raku.org/
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        this.stringDelimiters.push(["｢", "｣"]);  // https://www.evanmiller.org/a-review-of-perl-6.html
        this.stringDelimiters.push(["“", "”"]);
        this.commentDelimiters.push(["#`(", "(", ")"]);
        this.commentDelimiters.push(["#`{", "{", "}"]);
        this.commentDelimiters.push(["#`[", "[", "]"]);
        this.commentDelimiters.push(["#`<", "<", ">"]);
        this.commentDelimiters.push(["#"]);
        this.commentDelimiters.push(["=begin", "=cut"]);
        break;

      case "blade":
        this.commentDelimiters.push(["{{--", "--}}"]);
        this.commentDelimiters.push(["/*", "*/"]);
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["#"]);
        this.stringDelimiters.push(["'"]);
        break;

      case "php":
        this.selectionSplit = {
          'defaultLanguageId': 'unknown',
          'sections': [
            {
              'start': '<\\?php',
              'stop': '\\?>',
              'languageId': 'php'
            }
          ]
        };
        this.commentDelimiters.push(["/*", "*/"]);
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["#"]);
        this.stringDelimiters.push(["'"]);
        break;

      case "vb":
        this.commentDelimiters.push(["'"]);
        this.stringDelimiters.push(['"']);
        break;

      case "zig":
        this.commentDelimiters.push(["//"]);
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        this.stringDelimiters.push(['\\\\', '\\n']);
        break;

      case "jade":
      case "pug":
        this.commentLineRE = new RegExp("^[ \\t]*(//|//-)$", "g");
        this.indentComments = true;
        this.commentDelimiters.push(["//"]);
        this.commentDelimiters.push(["//-"]);
        this.stringDelimiters.push(['"']);
        this.stringDelimiters.push(["'"]);
        break;

      case "vue":
        this.selectionSplit = {
          'defaultLanguageId': 'html',
          'sections': [
            {
              'start': '<template( lang="([^\"]+)")?>',
              'stop': '</template>',
              'languageId': '${2:?$2:html}'
            },
            {
              'start': '<script[^>]*>',
              'stop': '</script>',
              'languageId': 'javascript'
            },
            {
              'start': '<style( lang="([^\"]+)")?>',
              'stop': '</style>',
              'languageId': '${2:?$2:css}'
            }
          ]
        };
        break;

      default:
        this.supportedLanguage = false;
        break;
    }
    return this.supportedLanguage;
  }

  /** keepComment expects plain positions and a document object that supports getText and lineAt */
  keepComment(document, range, charIdxOpenDelim) {
    let text = '';
    if (range.start.line === range.end.line) {
      text += document.lineAt(range.start.line).text.substring(range.start.character, range.end.character);
    } else {
      text += document.lineAt(range.start.line).text.substring(range.start.character);
      for (let lineNr = range.start.line+1; lineNr < range.end.line; ++lineNr) {
        text += '\t';
        text += document.lineAt(lineNr).text;
      }
      text += '\t';
      text += document.lineAt(range.end.line).text.substring(0, range.end.character);
    }
    if (this.prefix) { // keep comment if it NOT starts with the prefix
      return !text.startsWith(this.prefix);
    }
    if (charIdxOpenDelim === 0 && this.isEncodingLine(text)) {
      return true;
    }
    for (const keepRegex of this.keepCommentRegex) {
      let regex = getProperty(keepRegex, 'regex');
      if (!isString(regex) || regex.length === 0) { continue; }
      if (new RegExp(regex, getProperty(keepRegex, 'flags')).test(text)) {
        return true;
      }
    }
    return false;
  }
}

module.exports = { Parser, SINGLE_LINE, MULTI_LINE };
