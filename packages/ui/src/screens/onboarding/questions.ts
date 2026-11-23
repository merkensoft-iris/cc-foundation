/**
 * The 67 onboarding questions of docs/design/01-onboarding-and-frameworks.md §3.1 (owner
 * decision Q10 (c), 10 Nov 2026: all 67 stay), with the step that asks each. The wizard tags
 * every question's control with `q-<row>`, so a test can check that each step asks all of its
 * questions. "App only" rows are answered here and never in a profile.json (01 §3.2).
 */
import type { OnboardingStep } from '@cc/schemas';

export interface Question {
  readonly row: number;
  readonly step: OnboardingStep;
  readonly text: string;
  readonly appOnly?: true;
}

const q = (row: number, step: OnboardingStep, text: string, appOnly?: true): Question =>
  appOnly === undefined ? { row, step, text } : { row, step, text, appOnly };

export const QUESTIONS: readonly Question[] = [
  q(1, 'workspace', 'Workspace name'),
  q(2, 'workspace', 'Time zone'),
  q(3, 'workspace', 'Work week'),
  q(4, 'workspace', 'Working hours'),
  q(5, 'workspace', 'Protected blocks: times nothing may be booked into'),
  q(6, 'workspace', 'Is each block hard or soft?'),
  q(7, 'workspace', 'Weekly time budget for meetings and reviews'),
  q(8, 'workspace', 'Quiet hours'),
  q(9, 'workspace', 'Backup passphrase', true),
  q(10, 'workspace', 'Off-machine backup destination', true),
  q(11, 'workstreams', 'List everything you want to run here'),
  q(12, 'workstreams', 'Kind'),
  q(13, 'workstreams', 'Name'),
  q(14, 'workstreams', 'Parent'),
  q(15, 'workstreams', 'Whose outcome is it?'),
  q(16, 'workstreams', 'Your relationship to that person'),
  q(17, 'workstreams', 'Their consent'),
  q(18, 'workstreams', 'Time zone'),
  q(19, 'profiles', 'Headcount'),
  q(20, 'profiles', 'Leadership group size'),
  q(21, 'profiles', 'Teams under leads?'),
  q(22, 'profiles', 'Stage'),
  q(23, 'profiles', 'Business type'),
  q(24, 'profiles', 'Primary goal'),
  q(25, 'profiles', 'Goal shape'),
  q(26, 'profiles', 'Deadline'),
  q(27, 'profiles', 'Role type (job search only)'),
  q(28, 'profiles', 'Target roles (job search only)'),
  q(29, 'profiles', 'Existing framework'),
  q(30, 'profiles', 'Keep the existing framework?'),
  q(31, 'profiles', 'Weight preference'),
  q(32, 'profiles', 'Confidentiality'),
  q(33, 'profiles', 'Notes'),
  q(34, 'recommendation', 'Accept the recommendation, or pick one of the two alternatives?'),
  q(35, 'tailoring', 'Day, time and length of each required meeting'),
  q(36, 'tailoring', 'Merge same-cadence meetings of workstreams you run alone?'),
  q(37, 'tailoring', 'Scorecard lines'),
  q(38, 'tailoring', 'First priorities, WIG or goals for this quarter'),
  q(39, 'tailoring', 'How are decisions made?'),
  q(40, 'tailoring', 'Memo for one-way doors?'),
  q(41, 'tailoring', 'Who owns which area?'),
  q(42, 'tailoring', 'How strict is review?'),
  q(43, 'tailoring', 'When does an unfinished item escalate?'),
  q(44, 'tailoring', 'What may AI see for this workstream?'),
  q(45, 'tailoring', 'Which grounding files define the candidate?'),
  q(46, 'tailoring', 'Who is told when items close?'),
  q(47, 'rhythm', 'Adjust the times in the composed weekly grid'),
  q(48, 'rhythm', 'Keep the daily start and daily shutdown?'),
  q(49, 'rhythm', 'Confirm a meeting in a soft block or outside working hours'),
  q(50, 'rhythm', 'Over the time budget: which fix?'),
  q(51, 'rhythm', 'A required meeting has no slot: change a time or a block'),
  q(52, 'tools', 'Which tools do you use, by category?'),
  q(53, 'tools', 'Where does your team track tasks?'),
  q(54, 'tools', 'For which workstreams?'),
  q(55, 'tools', 'Account label (optional)'),
  q(56, 'tools', 'For each tool: a connector, manual, find with AI or later?'),
  q(57, 'tools', 'Calendars: which calendars?'),
  q(58, 'tools', 'Which workstreams sync where?'),
  q(59, 'tools', 'Is each calendar target the primary or a mirror?'),
  q(60, 'ai', 'Which AI provider?'),
  q(61, 'ai', 'A provider with no adapter: its name, for find with AI'),
  q(62, 'ai', 'Model'),
  q(63, 'ai', 'Per-task routing (optional)'),
  q(64, 'ai', 'Daily budget'),
  q(65, 'commit', 'Confirm the full preview of every record and every outward action'),
  q(66, 'commit', 'Approve the first calendar write batch', true),
  q(67, 'commit', 'Sign in to each service', true),
];

/** S1 to S9 with their titles (01 §3). */
export const STEPS: readonly { readonly id: OnboardingStep; readonly title: string }[] = [
  { id: 'workspace', title: 'S1 Workspace' },
  { id: 'workstreams', title: 'S2 Workstreams' },
  { id: 'profiles', title: 'S3 Profiles' },
  { id: 'recommendation', title: 'S4 Recommendation' },
  { id: 'tailoring', title: 'S5 Tailoring' },
  { id: 'rhythm', title: 'S6 Rhythm' },
  { id: 'tools', title: 'S7 Tools' },
  { id: 'ai', title: 'S8 AI' },
  { id: 'commit', title: 'S9 Review and commit' },
];

export function questionsOf(step: OnboardingStep): readonly Question[] {
  return QUESTIONS.filter((question) => question.step === step);
}

export function question(row: number): Question {
  const found = QUESTIONS.find((entry) => entry.row === row);
  if (found === undefined) throw new Error(`no question ${String(row)}`);
  return found;
}
