/**
 * The product skill (07 §8 item 3, C-07-06): generated from the help text of `cc-axi`, with
 * every command and no live data.
 */
import { describe, expect, it } from 'vitest';

import { renderSkill, SKILL_DESCRIPTION } from '../src/skill.js';
import { COMMANDS, usageOf } from '../src/spec.js';
import { referenceData } from './support/fixture-api.ts';

describe('skills/command-center/SKILL.md', () => {
  it('C-07-06 has the trigger-shaped description and names every cc-axi command', () => {
    const skill = renderSkill();
    expect(
      skill.startsWith(`---\nname: command-center\ndescription: ${SKILL_DESCRIPTION}\n---\n`),
    ).toBe(true);
    for (const command of COMMANDS) expect(skill).toContain(`\`${usageOf(command)}\``);
  });

  it('C-07-06 holds no live data: no workstream, item title or workspace of the fixtures', () => {
    const skill = renderSkill();
    const data = referenceData();
    for (const workstream of data.workstreams) expect(skill).not.toContain(workstream.name);
    for (const item of data.items) expect(skill).not.toContain(item.title);
  });
});
