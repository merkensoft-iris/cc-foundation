/**
 * @cc/test-kit: shared helpers for hermetic, worktree-safe tests (08 §8). Only test code
 * may import it (D7). The fake calendar services arrive with the packages that need them (09).
 * `createFakeClock` is the string clock of the pure packages; `FakeTimerClock` also runs
 * timers, for the core's schedulers (P1-04). The scenario seeder (`seedScenario`, `cc:seed`,
 * P1-15) seeds the reference scenario into a headless core and runs the rhythm jobs on its
 * fake clock.
 */
export { CANARY_PREFIX, makeCanary } from './canaries.js';
export { createFakeClock, type FakeClock } from './clock.js';
export { FakeTimerClock, settle } from './fake-timer-clock.js';
export { startFixtureServer, type FixtureServer } from './fixture-server.js';
export { blockNetwork, NetworkBlockedError } from './network.js';
export {
  createProfileDir,
  profileBaseDir,
  SOCKET_PATH_LIMIT,
  type ProfileDir,
} from './profile-dir.js';
export {
  readOnboardingProfile,
  readScenario,
  repositoryRoot,
  Scenario,
  SCENARIOS,
  seedScenario,
  type ScenarioFixture,
  type ScenarioName,
  type ScenarioStep,
  type SeedOptions,
} from './scenario/seed.js';
export { NIGHTLY_AT, RhythmJobs, type JobName, type JobRun } from './scenario/rhythm-jobs.js';
