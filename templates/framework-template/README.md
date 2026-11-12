# Framework template scaffold

The files `pnpm cc:new-template` copies (08 §6). `{{id}}`, `{{name}}`, `{{dir}}` and
`{{validator}}` are replaced when a file is written.

- `template.yaml.tmpl`: a new catalogue template, written to
  `packages/frameworks/templates/<id>/1.0.0.yaml`.
- `pack.yaml.tmpl`: a new pack, written to `packages/frameworks/packs/<id>/1.0.0.yaml`.
- `validator.ts.tmpl`: the stub validator of a new template's first invariant, written to
  `packages/frameworks/validators/<id>.ts`. Register it in `validators/index.ts`.
- `test.ts.tmpl`: validator and recommender test cases to fill in, written to
  `packages/frameworks/test/<id>.test.ts`.

A fork (`--from <id>@<version>`) needs no scaffold: it copies the source template.
