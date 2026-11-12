/**
 * Lists the TCP ports a process listens on, the way AC-04-08 asks: `lsof` on macOS and Linux,
 * `netstat` on Windows. On Linux `/proc` gives the same answer without `lsof`, so the check
 * also runs where `lsof` is not installed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function hasCommand(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

export const lsofAvailable = process.platform !== 'win32' && hasCommand('lsof');

/** Listening TCP ports of `pid` from `/proc` (Linux). */
export function procListeningPorts(pid: number): number[] {
  const inodes = new Set<string>();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (match?.[1] !== undefined) inodes.add(match[1]);
    } catch {
      // The descriptor closed while we read.
    }
  }
  const ports: number[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!fs.existsSync(table)) continue;
    for (const line of fs.readFileSync(table, 'utf8').split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st ... inode (field 9); st 0A is LISTEN.
      if (fields[3] !== '0A' || fields[9] === undefined || !inodes.has(fields[9])) continue;
      ports.push(Number.parseInt(fields[1]?.split(':')[1] ?? '0', 16));
    }
  }
  return ports;
}

/** Listening TCP ports of `pid` from `lsof -a -p <pid> -iTCP -sTCP:LISTEN`. */
export function lsofListeningPorts(pid: number): number[] {
  const result = spawnSync(
    'lsof',
    ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    {
      encoding: 'utf8',
    },
  );
  // lsof exits 1 when nothing matches.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed: ${result.stderr}`);
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => Number(line.slice(line.lastIndexOf(':') + 1)));
}

/** Listening TCP ports of `pid` from `netstat -ano -p TCP` (Windows). */
export function netstatListeningPorts(pid: number): number[] {
  const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`netstat failed: ${result.stderr}`);
  const ports: number[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'TCP' && fields[3] === 'LISTENING' && fields[4] === String(pid)) {
      ports.push(Number(fields[1]?.slice(fields[1].lastIndexOf(':') + 1)));
    }
  }
  return ports;
}

/** Every method available on this OS, by name. */
export function listeningPortsByTool(pid: number): Record<string, number[]> {
  if (process.platform === 'win32') return { netstat: netstatListeningPorts(pid) };
  const found: Record<string, number[]> = {};
  if (process.platform === 'linux') found['proc'] = procListeningPorts(pid);
  if (lsofAvailable) found['lsof'] = lsofListeningPorts(pid);
  return found;
}
