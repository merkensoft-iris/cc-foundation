/**
 * S1 to S3 of the onboarding wizard (01 §3, §3.1 rows 1 to 33): the workspace with its backup
 * answers, the workstreams, and each workstream's profile.
 *
 * The backup passphrase is typed in the app shell's own window and the destination folder is
 * chosen in the system's folder picker (04 §9.1 rules 3 and 5): neither passes through this
 * screen, which says "Type the password in the window" while main asks.
 */
import type { WorkstreamAnswers } from '@cc/schemas';

import type { Ui } from '../../app/screen.js';
import { errorText, IN_WINDOW, inWindow, waitingInWindow } from '../../app/screen.js';
import {
  button,
  checkbox,
  chip,
  field,
  inWindowNote,
  section,
  select,
  table,
} from '../../ui/parts.js';
import { h, type VNode } from '../../ui/vnode.js';
import {
  ask,
  newWorkstream,
  numberOf,
  readWeeklyRule,
  slugOf,
  weeklyRule,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type WizardState,
  type Work,
} from './model.js';

type Range = { start: string; end: string };

function ranges(ui: Ui, list: Range[], form: Range, test: string, empty: string): VNode {
  return h(
    'div',
    { class: 'ranges', test },
    list.length === 0 ? h('p', { class: 'empty' }, empty) : null,
    list.map((range, index) =>
      h(
        'div',
        { class: 'row', test: `${test}-${String(index)}` },
        field('From', range.start, (value) => (range.start = value), { type: 'time' }),
        field('To', range.end, (value) => (range.end = value), { type: 'time' }),
        button('Remove', () => {
          list.splice(index, 1);
          ui.render();
        }),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      field('From', form.start, (value) => (form.start = value), {
        type: 'time',
        test: `${test}-new-start`,
      }),
      field('To', form.end, (value) => (form.end = value), {
        type: 'time',
        test: `${test}-new-end`,
      }),
      button(
        'Add',
        () => {
          if (!/^\d{2}:\d{2}$/.test(form.start) || !/^\d{2}:\d{2}$/.test(form.end)) {
            ui.flash('A range is two times, HH:MM.', 'error');
            return;
          }
          list.push({ start: form.start, end: form.end });
          ui.render();
        },
        { test: `${test}-add` },
      ),
    ),
  );
}

function protectedBlocks(ui: Ui, work: Work): VNode {
  const ws = work.profile.workspace;
  const form = work.forms.block;
  return h(
    'div',
    null,
    table(
      ['Block', 'Days', 'From', 'Minutes', '6. Hard or soft?', ''],
      ws.protectedBlocks.map((block, index) => {
        const { days, time } = readWeeklyRule(block.rrule);
        return h(
          'tr',
          { test: `block-${block.id}` },
          h('td', null, block.label),
          h('td', null, days.map((day) => WEEKDAY_NAMES[day]).join(' ')),
          h('td', null, time),
          h('td', null, String(block.durationMinutes)),
          h(
            'td',
            null,
            ask(
              6,
              select(
                'Policy',
                block.policy,
                [
                  { value: 'hard', label: 'Hard: never schedule' },
                  { value: 'soft', label: 'Soft: ask me first' },
                ],
                (value) => {
                  block.policy = value as 'hard' | 'soft';
                },
                `block-policy-${block.id}`,
              ),
            ),
          ),
          h(
            'td',
            null,
            button('Remove', () => {
              ws.protectedBlocks.splice(index, 1);
              ui.render();
            }),
          ),
        );
      }),
      'No protected blocks yet.',
    ),
    h(
      'div',
      { class: 'form', test: 'add-block' },
      field('Label', form.label, (value) => (form.label = value), {
        test: 'block-label',
        placeholder: 'Deep work',
      }),
      h(
        'div',
        { class: 'days' },
        WEEKDAYS.map((day) =>
          checkbox(
            WEEKDAY_NAMES[day],
            form.days.includes(day),
            (checked) => {
              form.days = checked ? [...form.days, day] : form.days.filter((d) => d !== day);
            },
            `block-day-${day}`,
          ),
        ),
      ),
      field('From', form.start, (value) => (form.start = value), {
        type: 'time',
        test: 'block-start',
      }),
      field('Minutes', form.minutes, (value) => (form.minutes = value), {
        type: 'number',
        test: 'block-minutes',
      }),
      ask(
        6,
        select(
          'Hard or soft',
          form.policy,
          [
            { value: 'hard', label: 'Hard: never schedule' },
            { value: 'soft', label: 'Soft: ask me first' },
          ],
          (value) => (form.policy = value as 'hard' | 'soft'),
          'block-policy',
        ),
      ),
      button(
        'Add block',
        () => {
          const minutes = numberOf(form.minutes, 0);
          if (form.label.trim() === '' || form.days.length === 0 || minutes < 1) {
            ui.flash('A block needs a label, at least one day and a length in minutes.', 'error');
            return;
          }
          const days = WEEKDAYS.filter((day) => form.days.includes(day));
          ws.protectedBlocks.push({
            id: `pb_${slugOf(form.label).replace(/-/g, '_') || String(ws.protectedBlocks.length + 1)}`,
            label: form.label.trim(),
            rrule: weeklyRule(days, form.start),
            timeZone: ws.timeZone,
            durationMinutes: minutes,
            policy: form.policy,
          });
          form.label = '';
          ui.render();
        },
        { test: 'block-add' },
      ),
    ),
  );
}

function backupAnswers(ui: Ui, state: WizardState): VNode[] {
  const work = state.work;
  const form = work.forms.backup;
  const backup = state.status.profile?.workspace.backup;
  const saveFirst = async (): Promise<boolean> => {
    try {
      await ui.call('onboarding.save', { profile: work.profile });
      return true;
    } catch (error) {
      ui.flash(errorText(error), 'error');
      return false;
    }
  };
  /** Runs a call main answers from its own window; flashes `done` or the error, then reloads. */
  const inShellWindow = (key: string, run: () => Promise<unknown>, done: string) =>
    void (async () => {
      if (!(await saveFirst())) return;
      try {
        await inWindow(ui, key, run);
        ui.flash(done, 'ok');
      } catch (error) {
        ui.flash(errorText(error), 'error');
      }
      await ui.reload();
    })();
  return [
    ask(
      9,
      h(
        'p',
        { class: 'muted' },
        'Backups are encrypted with this passphrase. Command Center cannot recover a lost one: keep it somewhere safe. You type it in Command Center’s own window; it goes to the system keychain, never into the workspace.',
      ),
      backup?.passphraseSet === true ? chip('passphrase set', 'good') : chip('not set'),
      waitingInWindow(ui, 'onboarding-passphrase')
        ? inWindowNote(IN_WINDOW.secret, 'backup-passphrase-in-window')
        : button(
            backup?.passphraseSet === true ? 'Change passphrase…' : 'Set passphrase…',
            () =>
              inShellWindow(
                'onboarding-passphrase',
                () => ui.call('backups.passphrase', {}),
                'Backup passphrase set.',
              ),
            { test: 'backup-passphrase-set' },
          ),
    ),
    ask(
      10,
      h(
        'p',
        { class: 'muted' },
        'Encrypted archives are copied here: a folder such as the Google Drive or Dropbox synced folder, chosen in your system’s folder picker. Google Drive and S3 arrive with their connectors. You may skip this; Command Center reminds you in the weekly review.',
      ),
      backup?.destination === undefined
        ? chip('no destination')
        : chip(`${backup.destination.label}`, 'good'),
      field('Label', form.label, (value) => (form.label = value), {
        test: 'backup-label',
        placeholder: 'Synced folder',
      }),
      h(
        'div',
        { class: 'actions' },
        waitingInWindow(ui, 'onboarding-destination')
          ? inWindowNote(IN_WINDOW.folder, 'backup-destination-in-window')
          : button(
              'Choose folder…',
              () => {
                const label = form.label.trim();
                if (label === '') {
                  ui.flash('A destination needs a label, such as Synced folder.', 'error');
                  return;
                }
                inShellWindow(
                  'onboarding-destination',
                  () => ui.call('backups.destination', { destination: { kind: 'folder', label } }),
                  `Backups will be copied to ${label}.`,
                );
              },
              { test: 'backup-destination-set' },
            ),
        backup?.destination === undefined
          ? null
          : button(
              'Clear',
              () =>
                void (async () => {
                  try {
                    await ui.call('backups.destination', { destination: null });
                  } catch (error) {
                    ui.flash(errorText(error), 'error');
                  }
                  await ui.reload();
                })(),
            ),
      ),
    ),
  ];
}

/** S1 `workspace` (rows 1 to 10). */
export function workspaceStep(state: WizardState, ui: Ui): VNode {
  const work = state.work;
  const ws = work.profile.workspace;
  return h(
    'div',
    { test: 'step-workspace' },
    section(
      'Your workspace',
      ask(
        1,
        field('Workspace name', ws.displayName, (value) => (ws.displayName = value), {
          test: 'workspace-name',
        }),
      ),
      ask(
        2,
        field('Time zone', ws.timeZone, (value) => (ws.timeZone = value.trim()), {
          test: 'workspace-zone',
          placeholder: 'Asia/Kolkata',
        }),
      ),
      ask(
        3,
        h(
          'div',
          { class: 'days' },
          WEEKDAYS.map((day) =>
            checkbox(
              WEEKDAY_NAMES[day],
              ws.workweek.includes(day),
              (checked) => {
                ws.workweek = WEEKDAYS.filter((d) =>
                  d === day ? checked : ws.workweek.includes(d),
                );
              },
              `workweek-${day}`,
            ),
          ),
        ),
      ),
      ask(4, ranges(ui, ws.workingHours, work.forms.hours, 'hours', 'No working hours yet.')),
      ask(5, protectedBlocks(ui, work)),
      ask(
        7,
        field(
          'Minutes a week',
          String(ws.weeklyManagementMinutes),
          (value) => (ws.weeklyManagementMinutes = Math.max(0, Math.round(numberOf(value, 0)))),
          { type: 'number', test: 'workspace-budget' },
        ),
      ),
      ask(8, ranges(ui, ws.quietHours, work.forms.quiet, 'quiet', 'No quiet hours.')),
    ),
    section('Backups', ...backupAnswers(ui, state)),
  );
}

const KINDS: readonly { value: WorkstreamAnswers['kind']; label: string }[] = [
  { value: 'company', label: 'Company' },
  { value: 'business_unit', label: 'Business unit' },
  { value: 'client_engagement', label: 'Client engagement' },
  { value: 'project', label: 'Project' },
  { value: 'personal', label: 'Personal goal area' },
  { value: 'job_search', label: 'A goal you run for someone else, e.g. their job search' },
  { value: 'other', label: 'Other' },
];

/** S2 `workstreams` (rows 11 to 18). */
export function workstreamsStep(state: WizardState, ui: Ui): VNode {
  const work = state.work;
  const list = work.profile.workstreams;
  const form = work.forms.stream;
  const hasParent = form.kind === 'client_engagement' || form.kind === 'project';
  const other = form.principal === 'other';
  return h(
    'div',
    { test: 'step-workstreams' },
    ask(
      11,
      table(
        ['Key', 'Kind', 'Name', 'Parent', 'Whose outcome', 'Time zone', ''],
        list.map((w, index) =>
          h(
            'tr',
            { test: `workstream-${w.key}` },
            h('td', null, w.key),
            h('td', null, w.kind.replace('_', ' ')),
            h('td', null, w.name),
            h('td', null, w.parentKey ?? ''),
            h(
              'td',
              null,
              w.principal.kind === 'self'
                ? 'yours'
                : `${w.principal.displayName} (${w.principal.relationship})`,
            ),
            h('td', null, w.timeZone ?? ''),
            h(
              'td',
              null,
              button('Remove', () => {
                list.splice(index, 1);
                work.profile.tailoring = work.profile.tailoring?.filter(
                  (t) => t.workstreamKey !== w.key,
                );
                ui.render();
              }),
            ),
          ),
        ),
        'Nothing yet. Add each company, business unit, client engagement, personal goal area, or goal you run for someone else.',
      ),
    ),
    section(
      'Add a workstream',
      h(
        'div',
        { class: 'form', test: 'add-workstream' },
        ask(
          12,
          select(
            'Kind',
            form.kind,
            KINDS,
            (value) => {
              form.kind = value as WorkstreamAnswers['kind'];
              ui.render();
            },
            'stream-kind',
          ),
        ),
        ask(
          13,
          field('Name', form.name, (value) => (form.name = value), { test: 'stream-name' }),
          field('Key (lower-case, for the CLI)', form.key, (value) => (form.key = value), {
            test: 'stream-key',
            placeholder: 'from the name',
          }),
        ),
        ask(
          14,
          hasParent
            ? select(
                'Parent',
                form.parentKey,
                [
                  { value: '', label: 'None' },
                  ...list.map((w) => ({ value: w.key, label: w.name })),
                ],
                (value) => (form.parentKey = value),
                'stream-parent',
              )
            : h('p', { class: 'muted' }, 'Only a client engagement or a project has a parent.'),
        ),
        ask(
          15,
          select(
            'Whose outcome is it?',
            form.principal,
            [
              { value: 'self', label: 'Mine' },
              { value: 'other', label: 'Another person’s' },
            ],
            (value) => {
              form.principal = value as 'self' | 'other';
              ui.render();
            },
            'stream-principal',
          ),
          other
            ? field('Their name', form.displayName, (value) => (form.displayName = value), {
                test: 'stream-person',
              })
            : null,
        ),
        ask(
          16,
          other
            ? field(
                'Your relationship to them',
                form.relationship,
                (value) => (form.relationship = value),
                {
                  test: 'stream-relationship',
                },
              )
            : h('p', { class: 'muted' }, 'Asked when the outcome is another person’s.'),
        ),
        ask(
          17,
          other
            ? field(
                'Their consent: what they agreed to, and how',
                form.consentNote,
                (value) => (form.consentNote = value),
                {
                  test: 'stream-consent',
                  multiline: true,
                },
              )
            : h('p', { class: 'muted' }, 'Asked when the outcome is another person’s.'),
        ),
        ask(
          18,
          field(
            'Time zone (empty: the workspace’s)',
            form.timeZone,
            (value) => (form.timeZone = value.trim()),
            {
              test: 'stream-zone',
            },
          ),
          other
            ? field(
                'Their time zone',
                form.principalTimeZone,
                (value) => (form.principalTimeZone = value.trim()),
                {
                  test: 'stream-person-zone',
                },
              )
            : null,
        ),
        button(
          'Add workstream',
          () => {
            const key = slugOf(form.key.trim() === '' ? form.name : form.key);
            if (form.name.trim() === '' || key === '') {
              ui.flash('A workstream needs a name.', 'error');
              return;
            }
            if (list.some((w) => w.key === key)) {
              ui.flash(`There is a workstream ${key} already.`, 'error');
              return;
            }
            if (
              other &&
              (form.displayName.trim() === '' ||
                form.relationship.trim() === '' ||
                form.consentNote.trim() === '')
            ) {
              ui.flash(
                'For another person’s outcome, give their name, your relationship and their consent.',
                'error',
              );
              return;
            }
            list.push(
              newWorkstream({
                key,
                kind: form.kind,
                name: form.name.trim(),
                ...(hasParent && form.parentKey !== '' ? { parentKey: form.parentKey } : {}),
                ...(form.timeZone === '' ? {} : { timeZone: form.timeZone }),
                principal: other
                  ? {
                      kind: 'other',
                      displayName: form.displayName.trim(),
                      relationship: form.relationship.trim(),
                      timeZone: form.principalTimeZone || work.profile.workspace.timeZone,
                      consentNote: form.consentNote.trim(),
                    }
                  : { kind: 'self' },
              }),
            );
            work.forms.stream = {
              ...form,
              name: '',
              key: '',
              displayName: '',
              relationship: '',
              consentNote: '',
            };
            ui.render();
          },
          { test: 'stream-add', primary: true },
        ),
      ),
    ),
  );
}

const enumOptions = (values: readonly string[]) =>
  values.map((value) => ({ value, label: value.replace(/_/g, ' ') }));

/** S3 `profiles` (rows 19 to 33), one card per workstream. */
export function profilesStep(state: WizardState, ui: Ui): VNode {
  const list = state.work.profile.workstreams;
  if (list.length === 0) {
    return h('p', { class: 'empty', test: 'step-profiles' }, 'Add a workstream at S2 first.');
  }
  return h(
    'div',
    { test: 'step-profiles' },
    list.map((w) => {
      const jobSearch = w.kind === 'job_search';
      return section(
        w.name,
        h(
          'div',
          { class: 'form', test: `profile-${w.key}` },
          ask(
            19,
            field(
              'People doing the work, you included',
              String(w.headcount),
              (v) => (w.headcount = Math.max(1, Math.round(numberOf(v, 1)))),
              { type: 'number', test: `headcount-${w.key}` },
            ),
          ),
          ask(
            20,
            field(
              'People in a weekly leadership meeting',
              String(w.leadershipGroupSize),
              (v) => (w.leadershipGroupSize = Math.max(1, Math.round(numberOf(v, 1)))),
              { type: 'number', test: `leadership-${w.key}` },
            ),
          ),
          ask(
            21,
            checkbox(
              'There are teams under leads',
              w.hasTeamsUnderLeads,
              (checked) => (w.hasTeamsUnderLeads = checked),
              `teams-${w.key}`,
            ),
          ),
          ask(
            22,
            select(
              'Stage',
              w.stage,
              enumOptions(['idea', 'pre_revenue', 'early_revenue', 'growth', 'mature', 'n_a']),
              (v) => (w.stage = v as WorkstreamAnswers['stage']),
              `stage-${w.key}`,
            ),
          ),
          ask(
            23,
            select(
              'Business type',
              w.businessType,
              enumOptions([
                'services',
                'product',
                'ecommerce',
                'mixed_services_product',
                'nonprofit',
                'n_a',
              ]),
              (v) => (w.businessType = v as WorkstreamAnswers['businessType']),
              `business-${w.key}`,
            ),
          ),
          ask(
            24,
            select(
              'Primary goal',
              w.primaryGoal,
              enumOptions([
                'launch',
                'grow_revenue',
                'profitability',
                'stabilise',
                'land_role',
                'habit',
                'other',
              ]),
              (v) => (w.primaryGoal = v as WorkstreamAnswers['primaryGoal']),
              `goal-${w.key}`,
            ),
          ),
          ask(
            25,
            select(
              'Goal shape',
              w.goalShape,
              enumOptions(['one_dominant_outcome', 'few_priorities', 'many_streams']),
              (v) => {
                w.goalShape = v as WorkstreamAnswers['goalShape'];
                ui.render();
              },
              `shape-${w.key}`,
            ),
          ),
          ask(
            26,
            field(
              'Deadline (YYYY-MM-DD, for one dominant outcome)',
              w.deadline ?? '',
              (v) => {
                if (v.trim() === '') delete w.deadline;
                else w.deadline = v.trim();
              },
              { type: 'date', test: `deadline-${w.key}` },
            ),
          ),
          ask(
            27,
            jobSearch
              ? select(
                  'Role type',
                  w.roleType ?? 'any',
                  enumOptions(['full_time', 'fractional', 'contract', 'any']),
                  (v) => (w.roleType = v as NonNullable<WorkstreamAnswers['roleType']>),
                  `role-type-${w.key}`,
                )
              : h('p', { class: 'muted' }, 'Job search only.'),
          ),
          ask(
            28,
            jobSearch
              ? field(
                  'Target roles, comma separated',
                  (w.targetRoles ?? []).join(', '),
                  (v) => {
                    const roles = v
                      .split(',')
                      .map((r) => r.trim())
                      .filter((r) => r !== '');
                    if (roles.length === 0) delete w.targetRoles;
                    else w.targetRoles = roles;
                  },
                  { test: `target-roles-${w.key}` },
                )
              : h('p', { class: 'muted' }, 'Job search only.'),
          ),
          ask(
            29,
            select(
              'Existing framework',
              w.existingFramework,
              enumOptions(['none', 'eos', 'okr', '4dx', 'scaling_up', 'other']),
              (v) => {
                w.existingFramework = v as WorkstreamAnswers['existingFramework'];
                if (v === 'none') delete w.keepExisting;
                ui.render();
              },
              `existing-${w.key}`,
            ),
          ),
          ask(
            30,
            w.existingFramework === 'none'
              ? h('p', { class: 'muted' }, 'Asked when you already run a framework.')
              : checkbox(
                  'Keep it',
                  w.keepExisting === true,
                  (checked) => (w.keepExisting = checked),
                  `keep-${w.key}`,
                ),
          ),
          ask(
            31,
            select(
              'Weight',
              w.weightPreference,
              enumOptions(['light', 'standard', 'full']),
              (v) => (w.weightPreference = v as WorkstreamAnswers['weightPreference']),
              `weight-${w.key}`,
            ),
          ),
          ask(
            32,
            select(
              'Confidentiality',
              w.confidentiality,
              enumOptions(['normal', 'sensitive']),
              (v) => (w.confidentiality = v as WorkstreamAnswers['confidentiality']),
              `confidentiality-${w.key}`,
            ),
          ),
          ask(
            33,
            field(
              'Notes',
              w.notes ?? '',
              (v) => {
                if (v.trim() === '') delete w.notes;
                else w.notes = v;
              },
              { multiline: true, test: `notes-${w.key}` },
            ),
            h(
              'p',
              { class: 'muted' },
              'From a later version, AI may suggest answers from your notes; you accept each one.',
            ),
          ),
        ),
      );
    }),
  );
}
