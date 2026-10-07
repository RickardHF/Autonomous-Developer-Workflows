// Progress + preferences persistence. localStorage only — no account, no backend, no secrets.

const KEY = 'agentic-workshop.progress';
const VERSION = 2;

function blank() {
  return { v: VERSION, theme: 'auto', done: {}, modules: {}, updated: Date.now() };
}

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return blank();
  const next = blank();
  if (typeof raw.theme === 'string') next.theme = raw.theme;
  if (raw.done && typeof raw.done === 'object' && !Array.isArray(raw.done)) next.done = raw.done;
  if (raw.modules && typeof raw.modules === 'object' && !Array.isArray(raw.modules)) {
    next.modules = Object.fromEntries(
      Object.entries(raw.modules).filter(([, status]) => status === 'complete' || status === 'skipped')
    );
  }
  if (Number.isFinite(raw.updated)) next.updated = raw.updated;
  return next;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.state = this.#read();
  }

  #read() {
    try {
      return migrate(JSON.parse(localStorage.getItem(KEY)));
    } catch {
      return blank();
    }
  }

  #commit() {
    this.state.updated = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // Private browsing or a full quota — the session still works, it just won't persist.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  // --- tasks -------------------------------------------------------------
  doneSet(exerciseId) {
    return this.state.done[exerciseId] || (this.state.done[exerciseId] = {});
  }

  isDone(exerciseId, taskId) {
    return Boolean(this.doneSet(exerciseId)[taskId]);
  }

  setDone(exerciseId, taskId, value, { resume = false } = {}) {
    const set = this.doneSet(exerciseId);
    if (value) set[taskId] = 1;
    else delete set[taskId];
    if (resume && this.state.modules[exerciseId] === 'skipped') delete this.state.modules[exerciseId];
    this.#commit();
  }

  toggle(exerciseId, taskId, options) {
    const next = !this.isDone(exerciseId, taskId);
    this.setDone(exerciseId, taskId, next, options);
    return next;
  }

  /** Completed count for an exercise, ignoring stale ids from edited content. */
  completed(exerciseId, taskIds) {
    const set = this.doneSet(exerciseId);
    return taskIds.reduce((n, id) => n + (set[id] ? 1 : 0), 0);
  }

  clearExercise(exerciseId) {
    delete this.state.done[exerciseId];
    delete this.state.modules[exerciseId];
    this.#commit();
  }

  // --- modules -----------------------------------------------------------
  moduleStatus(exerciseId) {
    return this.state.modules[exerciseId] || '';
  }

  isModuleComplete(exerciseId) {
    return this.moduleStatus(exerciseId) === 'complete';
  }

  isSkipped(exerciseId) {
    return this.moduleStatus(exerciseId) === 'skipped';
  }

  setModuleStatus(exerciseId, status) {
    if (status !== '' && status !== 'complete' && status !== 'skipped') {
      throw new Error(`Unsupported module status: ${status}`);
    }
    if (status) this.state.modules[exerciseId] = status;
    else delete this.state.modules[exerciseId];
    this.#commit();
  }

  // --- preferences -------------------------------------------------------
  get theme() {
    return this.state.theme || 'auto';
  }

  set theme(value) {
    this.state.theme = value;
    this.#commit();
  }

  // --- import / export ---------------------------------------------------
  export() {
    return JSON.stringify(this.state, null, 2);
  }

  import(json) {
    const raw = JSON.parse(json);
    // Validate the file itself, before migrate() fills in defaults — otherwise any
    // JSON at all looks valid and silently wipes the visitor's progress.
    if (!raw || typeof raw !== 'object' || !raw.done || typeof raw.done !== 'object' || Array.isArray(raw.done)) {
      throw new Error('That does not look like a workshop progress file.');
    }
    this.state = migrate(raw);
    this.#commit();
  }

  /** Clears progress only — the theme is a preference, not progress. */
  reset() {
    const theme = this.theme;
    this.state = blank();
    this.state.theme = theme;
    this.#commit();
  }
}

export const store = new Store();
