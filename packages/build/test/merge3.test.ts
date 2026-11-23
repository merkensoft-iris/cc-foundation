/**
 * The 3-way merge of `cc:ui-update` (08 §6, ADR 0008 decision 1): an ejected screen (ours) and
 * the new upstream screen (theirs) against the upstream it was ejected from (base).
 */
import { describe, expect, it } from 'vitest';

import { diffLines, lineChanges, merge3, splitLines } from '../src/merge3.js';

const labels = { ours: 'ui/screens/home.ts (yours)', base: '@cc/ui 1.0.0', theirs: '@cc/ui 1.1.0' };
const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

describe('merge3 (cc:ui-update)', () => {
  it('splits lines keeping their endings, and diffs them by a longest common subsequence', () => {
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(diffLines(['a\n', 'b\n', 'c\n'], ['a\n', 'x\n', 'c\n', 'd\n'])).toEqual([
      { baseStart: 1, baseEnd: 2, start: 1, end: 2 },
      { baseStart: 3, baseEnd: 3, start: 3, end: 4 },
    ]);
    expect(lineChanges(text('a', 'b', 'c'), text('a', 'x', 'c', 'd'))).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it('takes the changes of each side where only one side changed', () => {
    const base = text('one', 'two', 'three', 'four', 'five');
    const ours = text('one', 'TWO', 'three', 'four', 'five');
    const theirs = text('one', 'two', 'three', 'four', 'five', 'six');
    expect(merge3(base, ours, theirs, labels)).toEqual({
      text: text('one', 'TWO', 'three', 'four', 'five', 'six'),
      conflicts: 0,
    });
    // One side unchanged: the merge is the other side.
    expect(merge3(base, base, theirs, labels).text).toBe(theirs);
    expect(merge3(base, ours, base, labels).text).toBe(ours);
  });

  it('takes a change both sides made the same way once', () => {
    const base = text("import { h } from '@cc/ui/v1';", 'view', 'end');
    const both = text("import { h } from '@cc/ui/v2';", 'render', 'end');
    expect(merge3(base, both, both, labels)).toEqual({ text: both, conflicts: 0 });
  });

  it('marks a region both sides changed differently, with the base between, as git does', () => {
    const base = text('a', 'title: Today', 'c');
    const ours = text('a', 'title: This week', 'c');
    const theirs = text('a', 'title: Now', 'c');
    const merged = merge3(base, ours, theirs, labels);
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(
      text(
        'a',
        '<<<<<<< ui/screens/home.ts (yours)',
        'title: This week',
        '||||||| @cc/ui 1.0.0',
        'title: Today',
        '=======',
        'title: Now',
        '>>>>>>> @cc/ui 1.1.0',
        'c',
      ),
    );
  });

  it('treats changes that touch as a conflict rather than guess their order', () => {
    const base = text('a', 'b', 'c');
    const merged = merge3(base, text('a', 'B', 'c'), text('a', 'b', 'inserted', 'c'), labels);
    expect(merged.conflicts).toBe(1);
  });

  it('keeps a last line without a newline, and ends marked lines with one', () => {
    const merged = merge3('a\nb', 'a\nours', 'a\ntheirs', labels);
    expect(merged.text).toBe(
      'a\n<<<<<<< ui/screens/home.ts (yours)\nours\n||||||| @cc/ui 1.0.0\nb\n=======\ntheirs\n>>>>>>> @cc/ui 1.1.0\n',
    );
    expect(merge3('a\nb', 'z\nb', 'a\nb', labels).text).toBe('z\nb');
  });

  it('merges deletions on one side with edits elsewhere on the other', () => {
    const base = text('1', '2', '3', '4', '5', '6');
    const ours = text('1', '3', '4', '5', '6');
    const theirs = text('1', '2', '3', '4', '5', 'six');
    expect(merge3(base, ours, theirs, labels)).toEqual({
      text: text('1', '3', '4', '5', 'six'),
      conflicts: 0,
    });
  });
});
