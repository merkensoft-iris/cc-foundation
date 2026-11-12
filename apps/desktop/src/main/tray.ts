/**
 * The tray (04 §1 rule 1, 04 §3 main row): CC keeps running when its windows are closed, so
 * rhythms, syncs and checks keep working, and the tray is how the user gets back in or
 * quits. Developer mode gets its own icon and a tooltip naming the reason (ADR 0004
 * decision 7).
 */
import { trayTooltip, type StartMode } from './start-mode.js';

export interface TrayMenuItem {
  readonly label?: string;
  readonly type?: 'separator' | 'normal';
  readonly enabled?: boolean;
  readonly click?: () => void;
}

export interface TrayActions {
  readonly open: () => void;
  readonly quit: () => void;
  /** Present while Rebuild now is offered (04 §10 rule 2): the offer stays after Later. */
  readonly rebuild?: () => void;
}

export function trayMenu(mode: StartMode | undefined, actions: TrayActions): TrayMenuItem[] {
  const items: TrayMenuItem[] = [{ label: 'Open Command Center', click: actions.open }];
  if (mode?.kind === 'developer') {
    items.push({
      label: `Developer mode: ${mode.reasons[0] ?? 'cannot verify tree'}`,
      enabled: false,
    });
  }
  if (actions.rebuild !== undefined) {
    items.push({
      label: 'Rebuild now (this app is older than its checkout)',
      click: actions.rebuild,
    });
  }
  items.push({ type: 'separator' }, { label: 'Quit Command Center', click: actions.quit });
  return items;
}

export function trayState(mode: StartMode | undefined, actions: TrayActions) {
  return {
    tooltip: trayTooltip(mode),
    icon: mode?.kind === 'developer' ? ('developer' as const) : ('normal' as const),
    menu: trayMenu(mode, actions),
  };
}
