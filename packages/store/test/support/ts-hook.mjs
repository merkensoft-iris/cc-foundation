/**
 * Lets a child process `node` run this workspace's TypeScript sources directly, the way the
 * Vitest config does for the test process: `@cc/<name>` resolves to the package source and a
 * relative `./x.js` import falls back to `./x.ts`. Node strips the types itself.
 *
 * Only the AC-03-07 crash test uses this: it must kill a real process in the middle of a
 * real transaction, which cannot be done inside the test process.
 */
import { registerHooks } from 'node:module';

const root = new URL('../../../../', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    const internal = /^@cc\/([a-z-]+)$/.exec(specifier);
    if (internal !== null) {
      // A file:// URL, not a path: on Windows an absolute path is not a valid specifier.
      return next(new URL(`packages/${internal[1]}/src/index.ts`, root).href, context);
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Not a TypeScript source: fall through to the plain specifier below.
      }
    }
    return next(specifier, context);
  },
});
