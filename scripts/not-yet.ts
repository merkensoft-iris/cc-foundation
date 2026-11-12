/**
 * Placeholder for a root script whose implementation arrives in a later phase
 * (docs/design/09-build-plan.md). Prints what is missing and exits 0, the no-op code
 * of 08 §6. Usage: node scripts/not-yet.ts <script> <phase>
 */
const [script, phase] = process.argv.slice(2);
if (script === undefined || phase === undefined) {
  console.error('usage: node scripts/not-yet.ts <script> <phase>');
  process.exit(2);
}
console.log(
  `pnpm ${script}: nothing to run yet; it arrives in ${phase} (docs/design/09-build-plan.md).`,
);
