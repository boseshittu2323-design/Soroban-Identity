import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContextStore = new AsyncLocalStorage();
