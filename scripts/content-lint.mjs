#!/usr/bin/env node
/**
 * A guardrail against interface text that sounds like an AI describing the product.
 *
 * It flags a short list of phrases the product language standard prohibits — "Worth knowing", "It looks
 * like", "Something went wrong" and the rest. That is all it does. It cannot tell whether a sentence is
 * clear, whether it uses the approved term, or whether the action is obvious, and a passing run is not
 * evidence of any of those. `docs/PRODUCT_LANGUAGE_STANDARD.md` is the standard; this is a trip wire for
 * the handful of phrases that keep coming back.
 *
 * ## Why it reads strings rather than lines
 *
 * The first version matched whole lines and found thirty hits, every one of them in a code comment
 * explaining *why* something was written a certain way — including comments about avoiding the very
 * phrases it was flagging. A lint that fires on its own rationale gets switched off within a week. So
 * comments are stripped first, and only string literals and JSX text are searched.
 *
 * Scope is deliberately narrow: the web application and the shared strings it renders. Tests, docs,
 * scripts, logs and developer diagnostics are not interface text and are not scanned.
 *
 *   node scripts/content-lint.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NEWLINE = String.fromCharCode(10);
/*
 * The web application, the strings it shares with the server, and the server text that reaches a screen.
 *
 * The server was left out of the first version and kept the one sentence this whole standard quotes as
 * an example of what not to write: a refusal message is interface text wherever it is produced.
 */
const ROOTS = ['web/src', 'shared', 'server/src/services', 'server/src/routes'];
const EXTENSIONS = ['.ts', '.tsx'];
/** Not interface text: a test name, a fixture, or a file the user never sees the output of. */
const SKIP = /\.(test|spec)\.tsx?$|[\\/](tests?|__tests__)[\\/]/;

/**
 * The phrases, with what to write instead.
 *
 * Each one earned its place by appearing in the product. They are matched case-insensitively on word
 * boundaries so "worth knowing" and "Worth knowing" are the same finding, and "Greatest" is not "Great!".
 */
const BANNED = [
  ['oops', 'State the error.'],
  ['uh-oh', 'State the error.'],
  ['good news', 'State the result. "No blockers found."'],
  ["let's", 'Use an imperative. "Add a dataset."'],
  ['it looks like', 'State what was observed. "Analysis detected…"'],
  ['it seems', 'State what was observed.'],
  ['we think', 'State what was observed.'],
  ['we noticed', 'Name the actor. "Analysis found…"'],
  ['we found that', 'Name the actor. "Validation found…"'],
  ["here's what", 'Name the content. "Findings".'],
  ["you're all set", 'State the state. "Ready."'],
  ['things to consider', 'Name the content. "Warnings".'],
  ['worth knowing', 'Name the content. "Warnings".'],
  ['something went wrong', 'State the error, or show what the server returned.'],
  ['you may want to', 'Use an imperative. "Review the warnings."'],
  ['we recommend that you', 'Use an imperative.'],
  ['based on our analysis', 'Name the source. "Analysis found…"'],
  ['in order to', 'Use "to".'],
  ['successfully completed', 'Use the status. "Completed."'],
  ['get started', 'Name the action. "Add a dataset."'],
];

/**
 * Removes comments, then keeps only what a user could read.
 *
 * Not a parser, and does not need to be: it is looking for a fixed list of English phrases, and the worst
 * a rough tokenizer can do is miss one. Missing one is a cost this pays to avoid firing on prose that
 * explains the rule.
 */
function userFacingText(source) {
  // Strip block and line comments. Strings containing "//" survive because the quote state is tracked.
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }

  /*
   * What is left is code. Keep the parts a user can read: string literals, and the text between JSX
   * tags. Identifiers and keys are not interface text — a property called `getStarted` is not a phrase
   * anybody reads.
   */
  const pieces = [];
  for (const match of out.matchAll(
    /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g,
  )) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    /*
     * One line only.
     *
     * An apostrophe in JSX text — "the project's history" — is not a string delimiter, but nothing
     * short of a parser knows that, so quote pairing desynchronises and the next "string" swallows
     * whole blocks of code. Those spans always cross lines; interface strings written on one line do
     * not. Skipping them costs the occasional multi-line template literal and buys a lint that does
     * not cry wolf.
     */
    if (text.includes(NEWLINE)) continue;
    pieces.push({ text, index: match.index ?? 0 });
  }
  // JSX text: between a closing bracket and an opening one, with at least one letter and a space.
  for (const match of out.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    pieces.push({ text: match[1] ?? '', index: match.index ?? 0 });
  }
  return { pieces, stripped: out };
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (EXTENSIONS.some((e) => path.endsWith(e)) && !SKIP.test(path)) yield path;
  }
}

const findings = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    const { pieces, stripped } = userFacingText(source);
    for (const piece of pieces) {
      const haystack = piece.text.toLowerCase();
      for (const [phrase, advice] of BANNED) {
        if (!haystack.includes(phrase)) continue;
        findings.push({
          file: relative(process.cwd(), file).replace(/\\/g, '/'),
          line: lineOf(stripped, piece.index),
          phrase,
          advice,
          text: piece.text.trim().slice(0, 100),
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`No flagged phrases in ${ROOTS.join(', ')}.`);
  console.log('This is a guardrail, not proof of language quality. See docs/PRODUCT_LANGUAGE_STANDARD.md.');
  process.exit(0);
}

console.error(`${findings.length} flagged phrase(s) in interface text:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`);
  console.error(`    "${f.phrase}" in: ${f.text}`);
  console.error(`    ${f.advice}\n`);
}
console.error('See docs/PRODUCT_LANGUAGE_STANDARD.md.');
process.exit(1);
