// Extension API 1 (fixture): the default UI's composition API. createApp() takes the screens it
// replaces as `screens`, and a screen draws with view().
export interface VNode {
  readonly tag: string;
  readonly children: readonly (VNode | string)[];
}
export declare function h(tag: string, props: null, ...children: (VNode | string)[]): VNode;
export declare function section(title: string, ...children: (VNode | string)[]): VNode;
export interface Screen<S> {
  load(): Promise<S>;
  view(state: S): VNode;
}
export interface AppOverrides {
  readonly screens?: Readonly<
    Record<string, { load(): Promise<unknown>; view(state: never): VNode }>
  >;
}
export declare function createApp(overrides?: AppOverrides): { start(): Promise<void> };
