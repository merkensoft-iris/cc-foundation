/**
 * Where `cc-axi` looks for the app: `<userData>`, Electron's `app.getPath('userData')` for the
 * app name "Command Center" (04 §9), unless `CC_PROFILE_DIR` names a profile started with
 * `--profile-dir`. The endpoint record and tokens under it are read by `@cc/core/client`.
 */
import os from 'node:os';
import path from 'node:path';

export function defaultUserData(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Command Center');
  if (platform === 'win32') {
    return path.join(env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), 'Command Center');
  }
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(home, '.config'), 'Command Center');
}
