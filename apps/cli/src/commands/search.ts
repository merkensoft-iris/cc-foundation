/**
 * `cc-axi search "<text>" [--types ...] [--limit <n>]` (07 §4.2): full-text search.
 */
import { listValue, positiveInt, single } from '../args.js';
import { usageError } from '../errors.js';
import { countLine, shellArg, table } from '../render.js';
import { DEFAULT_LIMIT, SEARCH_TYPES } from '../spec.js';
import type { Handler, SearchResult } from './common.js';

/** Hit types that have a `view` command in this build. */
const VIEWABLE = new Set(['items', 'decisions', 'issues']);

export const search: Handler = async (parsed, session) => {
  const text = (parsed.positionals[0] ?? '').trim();
  if (text === '') throw usageError('missing search text', ['Run `cc-axi search "<text>"`']);
  const types = listValue(parsed, '--types', SEARCH_TYPES);
  const limit = positiveInt(parsed, '--limit') ?? DEFAULT_LIMIT;
  const api = await session.api();
  const result = await api.call<SearchResult>('search.query', {
    text,
    ...(types === undefined ? {} : { types }),
    limit,
  });
  const noun = `results for "${text}"${types === undefined ? '' : ` in ${types.join(', ')}`}`;
  if (result.hits.length === 0) return { hits: `0 ${noun}` };
  const help = [...new Set(result.hits.map((hit) => hit.type))]
    .filter((type) => VIEWABLE.has(type))
    .map((type) => `Run \`cc-axi ${type} view <ref>\` for details`);
  if (result.total > result.hits.length) {
    const typesFlag = single(parsed, '--types');
    help.push(
      `Run \`cc-axi search ${shellArg(text)}${typesFlag === undefined ? '' : ` --types ${typesFlag}`} --limit ${result.total}\` for all ${result.total}`,
    );
  }
  const output = {
    hits: table(result.hits, ['type', 'ref', 'title']),
    count: countLine(result.hits.length, result.total, noun),
  };
  return help.length > 0 ? { ...output, help } : output;
};
