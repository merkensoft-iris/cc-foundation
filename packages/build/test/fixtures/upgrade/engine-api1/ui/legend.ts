import { registerWidget, type ThemeV1, type TokenNameV1 } from '@cc/ui-sdk/v1';

const keys: readonly TokenNameV1[] = ['color-primary', 'radius'];

function Legend({ theme }: { readonly theme: ThemeV1 }): string {
  return keys.map((k) => `${k}: ${theme[k]}`).join(', ');
}

registerWidget({ slot: 'dashboard.aside', component: Legend });
