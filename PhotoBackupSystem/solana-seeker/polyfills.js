// Global polyfills/shims to satisfy Hermes static checks in release builds
import { decode as atob, encode as btoa } from 'base-64';
import { Buffer } from 'buffer';

// Core globals
if (typeof globalThis.atob === 'undefined') globalThis.atob = atob;
if (typeof globalThis.btoa === 'undefined') globalThis.btoa = btoa;
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

// Timers / microtasks
if (typeof globalThis.setImmediate === 'undefined') {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
}
if (typeof globalThis.queueMicrotask === 'undefined') {
  globalThis.queueMicrotask = (cb) => Promise.resolve().then(cb);
}

// Optional globals used by React Native internals and devtools
if (typeof globalThis.SharedArrayBuffer === 'undefined') globalThis.SharedArrayBuffer = undefined;
if (typeof globalThis.DebuggerInternal === 'undefined') globalThis.DebuggerInternal = undefined;
if (typeof globalThis.nativeFabricUIManager === 'undefined') globalThis.nativeFabricUIManager = undefined;
if (typeof globalThis.RN$enableMicrotasksInReact === 'undefined') globalThis.RN$enableMicrotasksInReact = undefined;
if (typeof globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = undefined;
if (typeof globalThis.nativeRuntimeScheduler === 'undefined') globalThis.nativeRuntimeScheduler = undefined;

// Networking / browser-ish APIs (RN usually provides these; guard to satisfy Hermes)
if (typeof globalThis.fetch === 'undefined') {
  require('whatwg-fetch'); // populates fetch, Headers, Request, Response
}
if (typeof globalThis.Headers === 'undefined') globalThis.Headers = undefined;
if (typeof globalThis.Request === 'undefined') globalThis.Request = undefined;
if (typeof globalThis.Response === 'undefined') globalThis.Response = undefined;
if (typeof globalThis.URLSearchParams === 'undefined') globalThis.URLSearchParams = undefined;
if (typeof globalThis.AbortController === 'undefined') globalThis.AbortController = undefined;
if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = undefined;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = {};
if (typeof globalThis.MessageChannel === 'undefined') globalThis.MessageChannel = undefined;

// Misc utilities
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
}
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = undefined;
if (typeof globalThis.msCrypto === 'undefined') globalThis.msCrypto = undefined;
if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = undefined;
if (typeof globalThis.FileReader === 'undefined') globalThis.FileReader = undefined;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
