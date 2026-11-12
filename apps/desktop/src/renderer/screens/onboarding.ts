/**
 * Onboarding (09 P1-12; 01 §3): the wizard S1 to S9 with all 67 questions of 01 §3.1. Each
 * step can be skipped and resumed: "Save and continue" saves the answers so far and marks the
 * step answered (`onboarding.save`), "Skip for now" moves on. S4 and S5 read the recommender
 * (`onboarding.recommend`), S6 and S9 the full preview (`onboarding.preview`); S9's Confirm
 * commits (`onboarding.apply`), which writes every record in one transaction (C-01-01). The
 * app opens here on first start, until onboarding is committed (01 §1 item 7, AC-08-11).
 *
 * Before P3, answers are typed here or imported with `cc-axi onboarding apply --file`
 * (01 §3.2); answering from documents comes with the AI layer.
 */
import type { OnboardingStep } from '@cc/schemas';

import type { AppRoute } from '../app/routes.js';
import { errorText, type Screen, type Ui } from '../app/screen.js';
import { button, chip, page } from '../ui/parts.js';
import { h, type VNode } from '../ui/vnode.js';
import { profilesStep, workspaceStep, workstreamsStep } from './onboarding/basics.js';
import { aiStep, commitStep, rhythmStep, toolsStep } from './onboarding/finish.js';
import { acceptChoices, recommendationStep, tailoringStep } from './onboarding/frameworks.js';
import {
  emptyForms,
  emptyProfile,
  hostTimeZone,
  nextStep,
  saveStep,
  type RecommendResult,
  type StatusResult,
  type WizardState,
  type Work,
  type Preview,
} from './onboarding/model.js';
import { STEPS } from './onboarding/questions.js';

const ORDER: readonly OnboardingStep[] = STEPS.map((step) => step.id);
const NEEDS_RECOMMENDATION: readonly OnboardingStep[] = ['recommendation', 'tailoring', 'rhythm'];
const NEEDS_PREVIEW: readonly OnboardingStep[] = ['rhythm', 'commit'];

function newWork(): Work {
  return {
    loaded: false,
    profile: emptyProfile(hostTimeZone()),
    calendarMapping: { providers: [], routes: [] },
    forms: emptyForms(),
    choices: {},
  };
}

function stepView(state: WizardState, ui: Ui, confirm: () => void): VNode {
  switch (state.step) {
    case 'workspace':
      return workspaceStep(state, ui);
    case 'workstreams':
      return workstreamsStep(state, ui);
    case 'profiles':
      return profilesStep(state, ui);
    case 'recommendation':
      return recommendationStep(state, ui);
    case 'tailoring':
      return tailoringStep(state, ui);
    case 'rhythm':
      return rhythmStep(state, ui);
    case 'tools':
      return toolsStep(state, ui);
    case 'ai':
      return aiStep(state, ui);
    case 'commit':
      return commitStep(state, ui, confirm);
  }
}

function stepNav(state: WizardState, ui: Ui): VNode {
  const done = new Set(state.work.profile.completedSteps);
  return h(
    'ol',
    { class: 'steps', 'aria-label': 'Onboarding steps', test: 'onboarding-steps' },
    STEPS.map((step) =>
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: step.id === state.step ? 'step current' : 'step',
            test: `step-${step.id}-tab`,
            ...(step.id === state.step ? { 'aria-current': 'step' } : {}),
            onClick: () => ui.go({ screen: 'onboarding', step: step.id }),
          },
          step.title,
          done.has(step.id) ? [' ', chip('answered', 'good')] : null,
        ),
      ),
    ),
  );
}

async function confirmCommit(ui: Ui, state: WizardState): Promise<void> {
  const work = state.work;
  try {
    await ui.call('onboarding.save', {
      profile: work.profile,
      ...(work.calendarMapping.routes.length === 0
        ? {}
        : { calendarMapping: work.calendarMapping }),
    });
    await ui.call('onboarding.apply', {});
  } catch (error) {
    ui.flash(errorText(error), 'error');
    await ui.reload();
    return;
  }
  work.loaded = false;
  ui.go({ screen: 'home' });
  ui.flash(
    'Your workspace is set up. Calendar writes and sign-ins wait for their own approval.',
    'ok',
  );
}

export const onboardingScreen: Screen<WizardState> = {
  async load(ui, route: AppRoute) {
    const status = await ui.call<StatusResult>('onboarding.status', {});
    const work = ui.keep('onboarding', newWork);
    if (!work.loaded) {
      if (status.profile !== undefined) {
        work.profile = structuredClone(status.profile);
        work.calendarMapping = structuredClone(
          status.calendarMapping ?? { providers: [], routes: [] },
        );
      }
      work.loaded = true;
    }
    const asked = route.screen === 'onboarding' ? route.step : undefined;
    const step: OnboardingStep = asked ?? status.nextStep ?? 'workspace';
    let recommend: RecommendResult | undefined;
    let preview: Preview | undefined;
    let problem: string | undefined;
    if (NEEDS_RECOMMENDATION.includes(step) && work.profile.workstreams.length > 0) {
      try {
        recommend = await ui.call<RecommendResult>('onboarding.recommend', {
          profile: work.profile,
        });
      } catch (error) {
        problem = errorText(error);
      }
    }
    if (NEEDS_PREVIEW.includes(step)) {
      try {
        const result = await ui.call<{ preview: Preview }>('onboarding.preview', {
          profile: work.profile,
          ...(work.calendarMapping.routes.length === 0
            ? {}
            : { calendarMapping: work.calendarMapping }),
        });
        preview = result.preview;
      } catch (error) {
        problem = errorText(error);
      }
    }
    if (work.profile.workstreams.length === 0 && NEEDS_RECOMMENDATION.includes(step)) {
      problem = 'Add a workstream at S2 first.';
    }
    return {
      step,
      status,
      work,
      ...(recommend === undefined ? {} : { recommend }),
      ...(preview === undefined ? {} : { preview }),
      ...(problem === undefined ? {} : { problem }),
    };
  },

  view(state, ui) {
    if (state.status.state === 'committed') {
      return page(
        'Onboarding',
        h(
          'p',
          { test: 'onboarding-committed' },
          `Onboarding was committed at ${state.status.committedAt ?? ''}. Re-running a step, with a diff and a migration plan, comes in a later release.`,
        ),
        button('Open Home', () => ui.go({ screen: 'home' }), { primary: true }),
      );
    }
    const step = state.step;
    const title = STEPS.find((entry) => entry.id === step)?.title ?? step;
    const next = nextStep(step, ORDER);
    const confirm = () => void confirmCommit(ui, state);
    const save = () => {
      if (step === 'recommendation') acceptChoices(state, new Date(ui.now()).toISOString());
      void saveStep(ui, state.work, step, next);
    };
    return page(
      'Set up Command Center',
      h(
        'p',
        { class: 'muted' },
        'About twenty minutes. Every step can be skipped and finished later; nothing outside Command Center changes until you confirm at the end.',
      ),
      stepNav(state, ui),
      h('h2', null, title),
      stepView(state, ui, confirm),
      step === 'commit'
        ? null
        : h(
            'div',
            { class: 'actions', test: 'step-actions' },
            button('Save and continue', save, { test: 'onboarding-save', primary: true }),
            button('Skip for now', () => ui.go({ screen: 'onboarding', step: next }), {
              test: 'onboarding-skip',
            }),
          ),
    );
  },
};
