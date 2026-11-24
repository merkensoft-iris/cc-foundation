/**
 * A fixture codemod from extension API 1 to 2, against the fixture `@cc/ui-sdk` and `@cc/ui` in
 * `fixtures/upgrade/`: the shape of a real `<n>-to-<n+1>` codemod (ADR 0003 decision 6), used
 * to prove the runner (AC-08-10). It never guesses: a widget that reads the theme with a
 * computed key, or a screen it cannot find the drawing method of, is marked for a person and
 * stays on the v1 shim.
 *
 * The UI part (ADR 0008 decision 1) moves the engine's composition root and its replaced or
 * ejected screens to `@cc/ui/v2`: `createApp({ screens })` becomes `createApp({ replace })`, and a
 * screen's `view` becomes `render`.
 */
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

import type { Codemod, CodemodContext } from '../src/codemod.js';

/** Shared with the fixture's runtime up-cast, as a real rename table would be. */
export const TOKEN_RENAMES_1_TO_2: Readonly<Record<string, string>> = {
  'color-primary': 'color.accent',
  radius: 'radius.base',
};
export const SLOT_RENAMES_1_TO_2: Readonly<Record<string, string>> = {
  'dashboard.header': 'home.header',
  'dashboard.aside': 'home.aside',
};

function upgradeTokens(context: CodemodContext): void {
  const flat = context.readJson('theme/tokens.json') as Record<string, string> | undefined;
  if (flat === undefined) return;
  const nested: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(flat)) {
    const [group = name, leaf = 'base'] = (TOKEN_RENAMES_1_TO_2[name] ?? name).split('.');
    nested[group] = { ...nested[group], [leaf]: value };
  }
  context.writeJson('theme/tokens.json', nested);
  context.edit('theme/tokens.json', Object.keys(flat).length);
}

function upgradeWidget(context: CodemodContext, file: SourceFile, path: string): void {
  const v1 = file.getImportDeclaration('@cc/ui-sdk/v1');
  if (v1 === undefined) return;
  const accesses = file
    .getDescendantsOfKind(SyntaxKind.ElementAccessExpression)
    .filter((access) => access.getExpression().getText() === 'theme');
  const computed = accesses.filter(
    (access) => !Node.isStringLiteral(access.getArgumentExpression()),
  );
  if (computed.length > 0) {
    for (const access of computed) {
      context.todo(
        access,
        `reads the theme with a computed key (${access.getText()}); use token() with a TokenPath`,
      );
    }
    return; // stays on the v1 shim until a person finishes it
  }
  for (const access of accesses) {
    const name = access.getArgumentExpressionOrThrow().getText().slice(1, -1);
    access.replaceWithText(`token('${TOKEN_RENAMES_1_TO_2[name] ?? name}')`);
    context.edit(path);
  }
  for (const fn of file.getFunctions()) {
    const [parameter] = fn.getParameters();
    if (parameter !== undefined && parameter.getName().includes('theme')) {
      parameter.remove();
      context.edit(path);
    }
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'registerWidget') continue;
    call.getExpression().replaceWithText('defineWidget');
    const [argument] = call.getArguments();
    if (Node.isObjectLiteralExpression(argument)) {
      const value = (key: string) => {
        const property = argument.getProperty(key);
        return Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
      };
      const slotNode = value('slot');
      const slot = Node.isStringLiteral(slotNode) ? slotNode.getLiteralValue() : '';
      const component = value('component')?.getText() ?? 'Widget';
      // The title is required at API 2; the source identifier names the widget.
      argument.replaceWithText(
        `{ slot: '${SLOT_RENAMES_1_TO_2[slot] ?? slot}', title: '${component}', component: ${component} }`,
      );
    }
    context.edit(path, 3);
  }
  v1.setModuleSpecifier('@cc/ui-sdk/v2');
  v1.removeNamedImports();
  v1.addNamedImports(['defineWidget', 'token']);
  context.edit(path);
}

/** Renames the property `from` of an object literal to `to`; whether it was there. */
function renameProperty(object: Node, from: string, to: string): boolean {
  if (!Node.isObjectLiteralExpression(object)) return false;
  const property = object.getProperty(from);
  if (Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
    property.getNameNode().replaceWithText(to);
    return true;
  }
  return false;
}

function upgradeComposition(context: CodemodContext, file: SourceFile, path: string): void {
  const v1 = file
    .getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue() === '@cc/ui/v1');
  if (v1.length === 0) return;
  for (const declaration of file.getVariableDeclarations()) {
    if (!/^Screen</.test(declaration.getTypeNode()?.getText() ?? '')) continue;
    const screen = declaration.getInitializer();
    if (screen !== undefined && renameProperty(screen, 'view', 'render')) {
      context.edit(path);
    } else {
      context.todo(declaration, `screen ${declaration.getName()} has no view to rename to render`);
      return; // stays on the v1 shim until a person finishes it
    }
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'createApp') continue;
    const [overrides] = call.getArguments();
    if (overrides !== undefined && renameProperty(overrides, 'screens', 'replace')) {
      context.edit(path);
    }
  }
  for (const declaration of v1) {
    declaration.setModuleSpecifier('@cc/ui/v2');
    context.edit(path);
  }
}

export const codemod1to2: Codemod = {
  from: 1,
  title:
    'dashboard slots become home slots; tokens are nested and read with token(); createApp takes replace and screens render()',
  run(context) {
    upgradeTokens(context);
    for (const file of context.project.getSourceFiles()) {
      const path = file
        .getFilePath()
        .slice(context.root.length + 1)
        .split('\\')
        .join('/');
      if (path.startsWith('ui/')) {
        upgradeWidget(context, file, path);
        upgradeComposition(context, file, path);
      }
    }
  },
};
