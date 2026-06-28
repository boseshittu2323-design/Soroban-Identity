import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContextStore = new AsyncLocalStorage();

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatArgs(args) {
  const store = requestContextStore.getStore();
  if (store && store.requestId) {
    if (typeof args[0] === 'string') {
      return [`[${store.requestId}] ${args[0]}`, ...args.slice(1)];
    } else {
      return [`[${store.requestId}]`, ...args];
    }
  }
  return args;
}

console.log = function (...args) {
  originalLog.apply(console, formatArgs(args));
};

console.error = function (...args) {
  originalError.apply(console, formatArgs(args));
};

console.warn = function (...args) {
  originalWarn.apply(console, formatArgs(args));
};
