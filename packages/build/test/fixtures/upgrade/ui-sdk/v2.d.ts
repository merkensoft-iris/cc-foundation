// Extension API 2 (fixture): nested tokens read with token(), home slots, a required title.
export type TokenPath = 'color.accent' | 'radius.base';
export declare function token(path: TokenPath): string;
export interface Widget {
  readonly slot: 'home.header' | 'home.aside';
  readonly title: string;
  readonly component: () => string;
}
export declare function defineWidget(widget: Widget): void;
