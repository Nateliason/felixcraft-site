'use strict';

// Synthetic DOM fixtures only. These are not site copy or browser-rendering tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../assets/exercises.js'), 'utf8');
const keys = ['email', 'notes', 'research'];

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.attributes = {};
    this.listeners = {};
    this.disabled = true;
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.textContent = '';
    this.focusCount = 0;
    this.selectCount = 0;
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() { this.focusCount++; }
  select() { this.selectCount++; }
  click() {
    assert.equal(this.disabled, false, 'Cannot click an uninitialized control');
    return this.listeners.click();
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ writeText = async () => {}, clipboardMissing = false, hash = '', advancedMissing = false } = {}) {
  const choices = keys.map(key => new Element({ exercise: key }));
  const panes = keys.map(key => new Element({ exercisePane: key }));
  const buttons = keys.map(key => new Element({ copy: key, copied: `COPIED_${key}`, fallback: `FALLBACK_${key}` }));
  const fields = Object.fromEntries(keys.map(key => {
    const field = new Element();
    field.value = `PROMPT_${key}\nFICTIONAL_SAMPLE_${key}\nREVIEW_${key}`;
    return [key, field];
  }));
  const statuses = Object.fromEntries(keys.map(key => [key, new Element()]));
  const advanced = advancedMissing ? null : new Element();
  const windowListeners = {};
  const location = { hash };
  // Real HTML supplies the initial selection; the script must preserve it at boot.
  choices.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.exercise === 'email')));
  panes.forEach(pane => { pane.hidden = pane.dataset.exercisePane !== 'email'; });
  const context = {
    document: {
      querySelectorAll(selector) {
        switch (selector) {
          case '[data-exercise]': return choices;
          case '[data-exercise-pane]': return panes;
          case '[data-copy]': return buttons;
          case '.copy-status': return Object.values(statuses);
          default: throw Error(`Unexpected selector ${selector}`);
        }
      },
      querySelector(selector) {
        assert.equal(selector, '.advanced-tool');
        return advanced;
      },
      getElementById(id) {
        if (id.startsWith('prompt-')) return fields[id.slice(7)];
        if (id.startsWith('status-')) return statuses[id.slice(7)];
        throw Error(`Unexpected ID ${id}`);
      },
    },
    navigator: clipboardMissing ? {} : { clipboard: { writeText } },
    location,
    window: { addEventListener(type, callback) { windowListeners[type] = callback; } },
    fetch() { throw Error('Exercises must not initiate network requests'); },
  };
  vm.runInNewContext(source, context, { filename: 'assets/exercises.js' });
  return { choices, panes, buttons, fields, statuses, advanced, location, windowListeners };
}

function assertSelected(f, key) {
  for (const button of f.choices) assert.equal(button.getAttribute('aria-pressed'), String(button.dataset.exercise === key));
  for (const pane of f.panes) assert.equal(pane.hidden, pane.dataset.exercisePane !== key);
  assert.equal(f.panes.filter(pane => !pane.hidden).length, 1);
}

(async () => {
  const copied = [];
  const f = fixture({ writeText: async text => copied.push(text) });
  f.choices.concat(f.buttons).forEach(control => assert.equal(control.disabled, false));
  assertSelected(f, 'email');

  // Every choice, including switching back, must select exactly one pane and reset statuses.
  for (const key of ['notes', 'research', 'email', 'email']) {
    Object.values(f.statuses).forEach(status => { status.textContent = 'STALE'; });
    f.choices[keys.indexOf(key)].click();
    assertSelected(f, key);
    Object.values(f.statuses).forEach(status => assert.equal(status.textContent, ''));
    await f.buttons[keys.indexOf(key)].click();
    await f.buttons[keys.indexOf(key)].click();
    assert.equal(copied.at(-1), f.fields[key].value, 'Copy must preserve the complete prompt and fictional sample');
    assert.equal(copied.at(-2), f.fields[key].value, 'Repeated copy must stay on the current exercise');
    assert.equal(f.statuses[key].textContent, `COPIED_${key}`);
    assert.equal(f.fields[key].focusCount, 0);
  }
  assert.equal(copied.length, 8);

  // Rejection and absent Clipboard API must both expose/select the complete field.
  for (const options of [{ writeText: async () => { throw Error('denied'); } }, { clipboardMissing: true }]) {
    const fallback = fixture(options);
    await fallback.buttons[0].click();
    assert.equal(fallback.fields.email.focusCount, 1);
    assert.equal(fallback.fields.email.selectCount, 1);
    assert.equal(fallback.statuses.email.textContent, 'FALLBACK_email');
  }

  // A completion after switching must not announce success or focus a now-hidden field.
  for (const outcome of ['resolve', 'reject']) {
    const pending = deferred();
    const race = fixture({ writeText: () => pending.promise });
    const click = race.buttons[0].click();
    race.choices[1].click();
    pending[outcome](outcome === 'reject' ? Error('late denial') : undefined);
    await click;
    assertSelected(race, 'notes');
    assert.equal(race.statuses.email.textContent, '');
    assert.equal(race.statuses.notes.textContent, '');
    assert.equal(race.fields.email.focusCount, 0);
    assert.equal(race.fields.email.selectCount, 0);
  }

  // Returning to the original pane does not make its earlier pending request current again.
  const returnPending = deferred();
  const returned = fixture({ writeText: () => returnPending.promise });
  const earlier = returned.buttons[0].click();
  returned.choices[1].click();
  returned.choices[0].click();
  returnPending.resolve();
  await earlier;
  assert.equal(returned.statuses.email.textContent, '');

  // Out-of-order repeats on one button: an older failure cannot overwrite the latest success.
  const first = deferred(), second = deferred();
  let calls = 0;
  const repeated = fixture({ writeText: () => (++calls === 1 ? first.promise : second.promise) });
  const firstClick = repeated.buttons[0].click();
  const secondClick = repeated.buttons[0].click();
  second.resolve(); await secondClick;
  first.reject(Error('superseded denial')); await firstClick;
  assert.equal(repeated.statuses.email.textContent, 'COPIED_email');
  assert.equal(repeated.fields.email.focusCount, 0);
  assert.equal(repeated.fields.email.selectCount, 0);

  // Keep existing article links into the secondary advanced builder working.
  assert.equal(fixture({ hash: '#tools' }).advanced.open, true);
  const hashChange = fixture({ hash: '#workflows' });
  assert.equal(hashChange.advanced.open, false);
  hashChange.location.hash = '#tools';
  hashChange.windowListeners.hashchange();
  assert.equal(hashChange.advanced.open, true);
  hashChange.windowListeners.hashchange();
  assert.equal(hashChange.advanced.open, true);
  fixture({ hash: '#tools', advancedMissing: true });

  console.log('PASS exercise stub-DOM tests: choices, complete/repeated copy, clipboard fallbacks, stale async suppression, and #tools deep links. Not browser-rendering or full network QA.');
})().catch(error => { console.error(error); process.exitCode = 1; });
