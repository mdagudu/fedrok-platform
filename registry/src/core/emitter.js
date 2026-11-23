// Tiny event emitter that works in Node and browsers.
export class Emitter {
  constructor() {
    this._handlers = {};
  }
  on(event, fn) {
    (this._handlers[event] ||= []).push(fn);
    return this;
  }
  off(event, fn) {
    this._handlers[event] = (this._handlers[event] || []).filter((h) => h !== fn);
  }
  emit(event, ...args) {
    for (const fn of this._handlers[event] || []) fn(...args);
  }
}
