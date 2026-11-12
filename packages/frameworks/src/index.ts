/**
 * @cc/frameworks: recommend(), templates, packs, validators (pure, D4).
 *
 * The framework catalogue and decision tree of docs/design/01-onboarding-and-frameworks.md:
 * the built templates and packs (§5, compiled from templates/ and packs/ by pnpm cc:gen),
 * parameter bounds (§4, C-01-04), the invariant validators (validators/, C-01-03), the
 * recommender with the availability rule (§6, C-01-02) and forking (§9 level 5).
 */
export const PACKAGE_NAME = '@cc/frameworks';

export {
  builtPacks,
  builtTemplates,
  compareVersions,
  findPack,
  findTemplate,
  templateDir,
} from './catalogue.js';
export {
  FrameworkError,
  type FrameworkErrorCode,
  type FrameworkErrorData,
  type Result,
} from './errors.js';
export { forkTemplate, frameworkLabel, FORK_VERSION, type ForkOptions } from './fork.js';
export {
  changeInstance,
  checkInvariants,
  validateInstance,
  type InstanceChange,
  type InvariantViolation,
} from './instance.js';
export {
  checkParameters,
  defaultParameters,
  describeBounds,
  effectiveParameters,
  parameterDefault,
  withinBounds,
} from './parameters.js';
export { recommend, RECOMMENDER_VERSION, type RecommendOptions } from './recommend.js';
export type {
  ActionItemView,
  ActionReviewOutcome,
  AgendaSectionType,
  DecisionView,
  GoalView,
  InstanceState,
  InstanceView,
  IssueView,
  MeasureView,
  PrereadView,
  SeriesView,
} from './state.js';
export { checkPack, checkTemplate, parsePack, parseTemplate } from './template-check.js';
export {
  validators,
  type ValidatorContext,
  type ValidatorDefinition,
  type Violation,
} from '../validators/index.js';
