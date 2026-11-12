/**
 * Where electron-builder puts the packaged app, and what it is called. `cc-build start` runs
 * it, and Rebuild now hands it to the shell for the restart (04 §10 rule 2).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const APP_ID = 'app.commandcenter.desktop';
export const PRODUCT_NAME = 'Command Center';
export const EXECUTABLE_NAME = 'command-center';

/** The engine's compiled theme tokens at the packaged app's root (`cc-build` writes it). */
export const THEME_CSS = 'cc-theme.css';

/** The executable inside a macOS `.app` bundle: `Contents/MacOS/<name>`, or null. */
function bundleExecutable(bundle: string): string | null {
  const dir = join(bundle, 'Contents', 'MacOS');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).sort();
  const name =
    files.find((file) => file === EXECUTABLE_NAME || file === PRODUCT_NAME) ??
    (files.length === 1 ? files[0] : undefined);
  return name === undefined ? null : join(dir, name);
}

/**
 * The executable of the unpacked app electron-builder wrote into `outDir`, or null. On macOS
 * the bundle's name follows electron-builder's naming (`command-center.app` with
 * electron-builder 26), so any `.app` in the `mac*` directory is taken, and its executable is
 * read from `Contents/MacOS`.
 */
export function findPackagedApp(
  outDir: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!existsSync(outDir)) return null;
  const dirs = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const candidates: string[] = [];
  for (const dir of dirs) {
    if (platform === 'darwin' && /^mac(?:-[a-z0-9]+)?$/.test(dir)) {
      for (const bundle of readdirSync(join(outDir, dir)).filter((name) => name.endsWith('.app'))) {
        const executable = bundleExecutable(join(outDir, dir, bundle));
        if (executable !== null) candidates.push(executable);
      }
    } else if (platform === 'win32' && /^win(?:-[a-z0-9]+)?-unpacked$/.test(dir)) {
      candidates.push(join(outDir, dir, `${EXECUTABLE_NAME}.exe`));
    } else if (platform === 'linux' && /^linux(?:-[a-z0-9]+)?-unpacked$/.test(dir)) {
      candidates.push(join(outDir, dir, EXECUTABLE_NAME));
    }
  }
  return candidates.find((path) => existsSync(path)) ?? null;
}
