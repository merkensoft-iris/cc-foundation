# Engine skills

Development skills that the `cc-engine` template ships in its own `.agents/skills/`
(08 §7). The foundation keeps the source here so the text is reviewed beside the contract it
describes, and the engine template copies it:

| Source here             | Copied to, in `cc-engine`              | Task       |
| ----------------------- | -------------------------------------- | ---------- |
| `cc-engine-ui/SKILL.md` | `.agents/skills/cc-engine-ui/SKILL.md` | P1-31 (E3) |

The copy is part of the engine PR that installs `AGENTS.md` rule 1 ([ADR 0008](../../docs/adr/0008-engine-owned-ui.md)
decision 2). Until then the template has no development skill. Change the text here, and the
engine picks the change up in its next template PR. Nothing in this directory runs, and it holds
no foundation code.
