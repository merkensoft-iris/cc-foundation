import { registerWidget, type ThemeV1 } from '@cc/ui-sdk/v1';

function Header({ theme }: { readonly theme: ThemeV1 }): string {
  return `<h1 style="color: ${theme['color-primary']}; border-radius: ${theme['radius']}">Today</h1>`;
}

registerWidget({ slot: 'dashboard.header', component: Header });
