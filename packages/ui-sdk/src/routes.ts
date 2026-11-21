/**
 * The app's routes (ADR 0008 decision 1): the screens of 09 P1-11 and what each can be opened
 * on. A `commandcenter://` deep link (`Route`) opens one of them (04 §4.3 rule 3); a UI that
 * replaces a screen keeps its route, so links and other screens still reach it.
 */
import type { OnboardingStep } from '@cc/schemas';

export type AppRoute =
  | { readonly screen: 'home'; readonly confirmation?: string; readonly request?: string }
  | { readonly screen: 'items'; readonly tab?: ItemsTab; readonly ref?: string }
  | { readonly screen: 'decisions'; readonly ref?: string }
  | { readonly screen: 'issues' }
  | { readonly screen: 'meetings'; readonly ref?: string; readonly from?: string }
  | { readonly screen: 'scorecard'; readonly tab?: 'measures' | 'goals'; readonly ref?: string }
  | { readonly screen: 'settings'; readonly tab?: SettingsSection }
  /** Onboarding (01 §3): not in the navigation; the app opens it until it is committed. */
  | { readonly screen: 'onboarding'; readonly step?: OnboardingStep };

export type ItemsTab = 'list' | 'review' | 'drafts';

/**
 * The Settings pages (09 P1-11): the Overview, then one page per section. The section names
 * are the ones core error help sends the user to ("Settings → Agent access", "→ Backups").
 */
export type SettingsSection = 'overview' | 'backups' | 'agents' | 'notifications' | 'ai';

export type ScreenName = AppRoute['screen'];

export type { OnboardingStep };
