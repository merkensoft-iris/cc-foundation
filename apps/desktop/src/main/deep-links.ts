/**
 * `commandcenter://` deep links (04 §3, 04 §4.3 rule 3, 02 §9.2 rule 2). A link arrives from
 * the OS (macOS `open-url`; Windows and Linux in the argv of a second instance) or from a
 * notification click, is parsed here, and only a parsed `Route` reaches the renderer. Links
 * are untrusted input: anything that is not exactly one of the forms below is dropped.
 *
 * - `commandcenter://` opens the app (Home)
 * - `commandcenter://items/<ref>`, `commandcenter://confirmations/<id>`,
 *   `commandcenter://requests/<id>` (04 §4.3 rule 3)
 * - `commandcenter://meeting/<instanceId>` (02 §9.2 rule 2)
 */
export const DEEP_LINK_PROTOCOL = 'commandcenter';
export const DEEP_LINK_SCHEME = `${DEEP_LINK_PROTOCOL}://`;

/** The targets a link may name; the same forms `@cc/core` puts into its links. */
export const ROUTE_KINDS = ['items', 'confirmations', 'requests', 'meeting'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export type Route =
  { readonly kind: 'home' } | { readonly kind: RouteKind; readonly target: string };

/** A HumanRef (`A-0142`) or an ID (`cfm_7q2`, `ins_01J…`). */
const LINK_TARGET = /^(?:[A-Z]-[0-9]{4,}|[a-z]+_[A-Za-z0-9_]+)$/;
const MAX_LINK_LENGTH = 256;

/** Parses a deep link, or returns `undefined` for anything that is not one. */
export function parseDeepLink(link: string): Route | undefined {
  if (link.length > MAX_LINK_LENGTH || !link.startsWith(DEEP_LINK_SCHEME)) return undefined;
  const rest = link.slice(DEEP_LINK_SCHEME.length);
  if (rest === '' || rest === '/') return { kind: 'home' };
  const match = /^([a-z]+)\/([^/?#]+)\/?$/.exec(rest);
  if (match === null) return undefined;
  const [, kind = '', target = ''] = match;
  if (!(ROUTE_KINDS as readonly string[]).includes(kind) || !LINK_TARGET.test(target)) {
    return undefined;
  }
  return { kind: kind as RouteKind, target };
}

/** The deep link of a route (the inverse of `parseDeepLink`). */
export function linkOf(route: Route): string {
  return route.kind === 'home'
    ? DEEP_LINK_SCHEME
    : `${DEEP_LINK_SCHEME}${route.kind}/${route.target}`;
}

/** The first argument that is a deep link, as Windows and Linux pass it in argv. */
export function deepLinkInArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}:`));
}
