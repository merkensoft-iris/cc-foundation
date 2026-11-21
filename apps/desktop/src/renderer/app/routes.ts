/**
 * The screens of 09 P1-11 and where a `commandcenter://` deep link opens (04 §4.3 rule 3).
 * Phase 1 has no Confirmations screen (owner decision Q3, 10 Nov 2026): a confirmation link
 * opens its inline prompt, on Home until the item, meeting or onboarding step that raised it
 * carries it.
 */
import type { AppRoute, Route, ScreenName } from '@cc/ui-sdk/v1';

export type { AppRoute, ItemsTab, ScreenName, SettingsSection } from '@cc/ui-sdk/v1';

/** The default UI's navigation, in its order. */
export const NAV: readonly { readonly screen: ScreenName; readonly label: string }[] = [
  { screen: 'home', label: 'Home' },
  { screen: 'items', label: 'Items' },
  { screen: 'decisions', label: 'Decisions' },
  { screen: 'issues', label: 'Issues and risks' },
  { screen: 'meetings', label: 'Meetings' },
  { screen: 'scorecard', label: 'Scorecard' },
  { screen: 'settings', label: 'Settings' },
];

/** The screen a deep link opens. Main has parsed and checked the link first. */
export function routeOfLink(route: Route): AppRoute {
  switch (route.kind) {
    case 'home':
      return { screen: 'home' };
    case 'items':
      return { screen: 'items', ref: route.target };
    case 'meeting':
      return { screen: 'meetings', ref: route.target };
    case 'confirmations':
      return { screen: 'home', confirmation: route.target };
    case 'requests':
      return { screen: 'home', request: route.target };
  }
}
