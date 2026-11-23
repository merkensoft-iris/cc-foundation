import type { Screen } from '../app/screen.js';
import { section } from '../ui/parts.js';
import { h } from '../ui/vnode.js';

const TITLE = 'Today';

interface HomeState {
  readonly due: number;
  readonly overdue?: number;
}

export const homeScreen: Screen<HomeState> = {
  load: () => Promise.resolve({ due: 3 }),
  render: (state) => section(TITLE, h('p', null, `${String(state.due)} items due`)),
};
