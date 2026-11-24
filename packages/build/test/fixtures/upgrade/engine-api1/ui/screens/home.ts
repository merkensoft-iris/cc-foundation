import type { Screen } from '@cc/ui/v1';
import { section } from '@cc/ui/v1';
import { h } from '@cc/ui/v1';

const TITLE = 'This week';

interface HomeState {
  readonly due: number;
}

export const homeScreen: Screen<HomeState> = {
  load: () => Promise.resolve({ due: 3 }),
  view: (state) => section(TITLE, h('p', null, `${String(state.due)} items due`)),
};
