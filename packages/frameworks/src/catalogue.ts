/**
 * The built catalogue: the templates and packs of this release, compiled from
 * packages/frameworks/templates/ and packs/ into generated/catalogue.ts by `pnpm cc:gen`.
 * v1 builds personal-os, 4dx and eos-lite; eos, okr and scaling-up ship in P7 (01 §1 item 5).
 */
import type { FrameworkId, FrameworkTemplate, Pack } from '@cc/schemas';

import { PACKS, TEMPLATES } from './generated/catalogue.js';

export const builtTemplates: readonly FrameworkTemplate[] = TEMPLATES;
export const builtPacks: readonly Pack[] = PACKS;

/** The latest version of a template, or the exact version asked for. */
export function findTemplate(
  id: FrameworkId,
  version?: string,
  templates: readonly FrameworkTemplate[] = builtTemplates,
): FrameworkTemplate | undefined {
  const matches = templates.filter(
    (template) => template.id === id && (version === undefined || template.version === version),
  );
  return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function findPack(
  id: string,
  version?: string,
  packs: readonly Pack[] = builtPacks,
): Pack | undefined {
  const matches = packs.filter(
    (pack) => pack.id === id && (version === undefined || pack.version === version),
  );
  return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
}

/** Compares two semantic versions MAJOR.MINOR.PATCH. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The directory of a template's files under templates/: its ID, with a `custom:` template in
 * custom/<name> (a colon is not a valid file name character on Windows).
 */
export function templateDir(id: FrameworkId): string {
  return id.startsWith('custom:') ? `custom/${id.slice('custom:'.length)}` : id;
}
