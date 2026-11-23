/**
 * A line-based 3-way merge for `cc:ui-update` (08 §6, ADR 0008 decision 1): an ejected screen
 * (ours) is merged with the new upstream screen (theirs) against the upstream it was ejected
 * from (base). Pure and deterministic, so `cc:upgrade --check` can predict the merge without
 * writing anything, and no git or other tool is needed in the engine.
 *
 * A region of the base that only one side changed takes that side's lines. A region both sides
 * changed takes their lines when they changed it the same way, and is otherwise a conflict,
 * written with the markers git uses (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`, diff3
 * style). Changes that touch (one side's edit ends where the other's begins) conflict, as in git:
 * the merge never guesses an order.
 */

/** One run of lines the other text replaced: base lines `[baseStart, baseEnd)` by `[start, end)`. */
export interface Hunk {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly start: number;
  readonly end: number;
}

/** Splits text into lines, each keeping its line ending, so joining them gives the text back. */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/**
 * The hunks that turn `base` into `other`, from a longest common subsequence of lines. The
 * common prefix and suffix are matched first, so the table covers only the changed middle.
 */
export function diffLines(base: readonly string[], other: readonly string[]): Hunk[] {
  let head = 0;
  while (head < base.length && head < other.length && base[head] === other[head]) head += 1;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < other.length - head &&
    base[base.length - 1 - tail] === other[other.length - 1 - tail]
  ) {
    tail += 1;
  }
  const n = base.length - head - tail;
  const m = other.length - head - tail;
  // lcs[i * (m + 1) + j]: the LCS length of base[head + i ..] and other[head + j ..].
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * (m + 1) + j] =
        base[head + i] === other[head + j]
          ? (lcs[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j] ?? 0, lcs[i * (m + 1) + j + 1] ?? 0);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { baseStart: number; start: number } | undefined;
  const close = () => {
    if (open !== undefined) {
      hunks.push({
        baseStart: open.baseStart,
        baseEnd: head + i,
        start: open.start,
        end: head + j,
      });
      open = undefined;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[head + i] === other[head + j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    open ??= { baseStart: head + i, start: head + j };
    const down = i < n ? (lcs[(i + 1) * (m + 1) + j] ?? 0) : -1;
    const right = j < m ? (lcs[i * (m + 1) + j + 1] ?? 0) : -1;
    if (down >= right) i += 1;
    else j += 1;
  }
  close();
  return hunks;
}

/** How many lines `other` adds and removes against `base`. */
export function lineChanges(base: string, other: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of diffLines(splitLines(base), splitLines(other))) {
    added += hunk.end - hunk.start;
    removed += hunk.baseEnd - hunk.baseStart;
  }
  return { added, removed };
}

export interface MergeLabels {
  readonly ours: string;
  readonly base: string;
  readonly theirs: string;
}

export interface MergeResult {
  /** The merged text, with conflict markers where both sides changed a region differently. */
  readonly text: string;
  readonly conflicts: number;
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/** Lines for between conflict markers: the last one ends with a newline. */
function terminated(lines: readonly string[]): string[] {
  const last = lines.at(-1);
  return last === undefined || last.endsWith('\n')
    ? [...lines]
    : [...lines.slice(0, -1), `${last}\n`];
}

/** Merges `ours` and `theirs`, two edits of `base`. */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  labels: MergeLabels,
): MergeResult {
  const baseLines = splitLines(base);
  const sides = [
    { lines: splitLines(ours), side: 0 },
    { lines: splitLines(theirs), side: 1 },
  ] as const;
  const tagged = sides
    .flatMap(({ lines, side }) => diffLines(baseLines, lines).map((hunk) => ({ ...hunk, side })))
    .sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd || a.side - b.side);

  const out: string[] = [];
  let conflicts = 0;
  let at = 0; // the next base line not yet written
  let index = 0;
  while (index < tagged.length) {
    const first = tagged[index];
    if (first === undefined) break;
    // A region: hunks of either side that overlap or touch.
    const group = [first];
    let start = first.baseStart;
    let end = first.baseEnd;
    index += 1;
    for (
      let next = tagged[index];
      next !== undefined && next.baseStart <= end;
      next = tagged[index]
    ) {
      group.push(next);
      start = Math.min(start, next.baseStart);
      end = Math.max(end, next.baseEnd);
      index += 1;
    }
    out.push(...baseLines.slice(at, start));
    // Each side's lines for the base region [start, end): outside its own hunks a side matches
    // the base line for line, so the offsets at the region's edges are its first and last hunk's.
    const region = sides.map(({ lines, side }) => {
      const own = group.filter((hunk) => hunk.side === side);
      const firstOwn = own[0];
      const lastOwn = own.at(-1);
      if (firstOwn === undefined || lastOwn === undefined) return undefined;
      return lines.slice(
        start + (firstOwn.start - firstOwn.baseStart),
        end + (lastOwn.end - lastOwn.baseEnd),
      );
    });
    const [mine, upstream] = region;
    if (mine === undefined) out.push(...(upstream ?? []));
    else if (upstream === undefined || sameLines(mine, upstream)) out.push(...mine);
    else {
      conflicts += 1;
      out.push(
        `<<<<<<< ${labels.ours}\n`,
        ...terminated(mine),
        `||||||| ${labels.base}\n`,
        ...terminated(baseLines.slice(start, end)),
        '=======\n',
        ...terminated(upstream),
        `>>>>>>> ${labels.theirs}\n`,
      );
    }
    at = end;
  }
  out.push(...baseLines.slice(at));
  return { text: out.join(''), conflicts };
}

/** The 1-based line numbers of the conflict start markers left in `text`. */
export function conflictLines(text: string): number[] {
  const lines: number[] = [];
  splitLines(text).forEach((line, index) => {
    if (line.startsWith('<<<<<<< ')) lines.push(index + 1);
  });
  return lines;
}
