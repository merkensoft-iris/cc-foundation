// Extension API 2 (fixture): createApp() takes the screens it replaces as `replace`, and a
// screen draws with render().
export interface VNode {
  readonly tag: string;
  readonly children: readonly (VNode | string)[];
}
export declare function h(tag: string, props: null, ...children: (VNode | string)[]): VNode;
export declare function section(title: string, ...children: (VNode | string)[]): VNode;
export interface Screen<S> {
  load(): Promise<S>;
  render(state: S): VNode;
}
export interface AppOverrides {
  readonly replace?: Readonly<
    Record<string, { load(): Promise<unknown>; render(state: never): VNode }>
  >;
}
export declare function createApp(overrides?: AppOverrides): { start(): Promise<void> };
