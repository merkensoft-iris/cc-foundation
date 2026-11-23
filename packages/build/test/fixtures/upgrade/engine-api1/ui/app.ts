import { createApp } from '@cc/ui/v1';

import { homeScreen } from './screens/home.js';

void createApp({ screens: { home: homeScreen } }).start();
