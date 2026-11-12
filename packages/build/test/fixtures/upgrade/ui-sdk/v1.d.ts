// Extension API 1 (fixture): flat theme tokens passed as a prop, dashboard slots.
export type TokenNameV1 = 'color-primary' | 'radius';
export type ThemeV1 = Readonly<Record<TokenNameV1, string>>;
export interface WidgetV1 {
  readonly slot: 'dashboard.header' | 'dashboard.aside';
  readonly component: (props: { readonly theme: ThemeV1 }) => string;
}
export declare function registerWidget(widget: WidgetV1): void;
