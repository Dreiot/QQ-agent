// Real desktop entry + on-disk composition + real pending-reset implementation.
// Native Electron is an in-memory recorder; no desktop, live data or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createDataResetCoordinator } from '../src/kernel/data-reset.js';

const workspace = path.resolve(import.meta.dirname, '..');

for (const phase of ['normal', 'preflight-failure', 'async-preflight']) {
  test(`desktop composition ${phase}: selected preflight precedes Chromium and owns cleanup`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-desktop175-'));
    const dataDir = path.join(root, 'data'), eventsFile = path.join(root, 'events.jsonl');
    const savedFetch = globalThis.fetch, savedError = console.error, savedArgv = process.argv;
    const envKeys = ['QQ_AGENT_DATA_DIR', 'QQ_AGENT_PROFILE'];
    const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const listeners = new Map(['uncaughtException', 'unhandledRejection'].map(event => [event, new Set(process.listeners(event))]));
    let desktop;
    t.after(async () => {
      await desktop?.stopElectron?.(electron);
      globalThis.fetch = savedFetch; console.error = savedError; process.argv = savedArgv;
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      for (const [event, existing] of listeners) for (const listener of process.listeners(event)) if (!existing.has(listener)) process.removeListener(event, listener);
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('qqa-desktop175-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    for (const name of ['src', 'bundled']) fs.cpSync(path.join(workspace, name), path.join(root, name), { recursive: true });
    fs.cpSync(path.join(workspace, 'scripts/lib'), path.join(root, 'scripts/lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'electron'));
    fs.copyFileSync(path.join(workspace, 'electron/main.js'), path.join(root, 'electron/main.js'));
    const rendererLeaveSource = path.join(workspace, 'electron/renderer-leave.js'), rendererLeaveCopy = path.join(root, 'electron/renderer-leave.js');
    fs.copyFileSync(rendererLeaveSource, rendererLeaveCopy);
    assert.deepEqual(fs.readFileSync(rendererLeaveCopy), fs.readFileSync(rendererLeaveSource), 'the real renderer leave dependency is copied byte-for-byte');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(dataDir, 'electron-user-data/Cache'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"old":true}');
    const cache = path.join(dataDir, 'electron-user-data/Cache/old-cache');
    fs.writeFileSync(cache, 'synthetic stale Chromium cache');
    const reset = await createDataResetCoordinator({ dataDir, quiesce: async () => {} }).request();
    const marker = `${dataDir}.reset-pending.json`;
    assert.ok(fs.existsSync(marker));
    const layer = path.join(root, 'overrides/desktop-fixture');
    fs.mkdirSync(layer, { recursive: true });
    const manifest = path.join(layer, 'composition.json');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, id: 'desktop-fixture', components: {
      'runtime.persona.text': { module: './entry.mjs', export: 'persona' },
      'runtime.config.defaults': { module: './entry.mjs', export: 'defaults' },
      'runtime.reset.complete': { module: './entry.mjs', export: 'reset' },
      'runtime.kernel': { module: './entry.mjs', export: 'kernel' },
    } }));
    fs.writeFileSync(path.join(layer, 'changed.mjs'), 'throw new Error("175 startup rescanned a different composition generation");');
    fs.writeFileSync(path.join(layer, 'entry.mjs'), `
import fs from 'node:fs';
import { buildDefaultConfig } from '../../src/kernel/config.js';
import { completePendingDataReset } from '../../src/kernel/data-reset.js';
const events = new URL('../../events.jsonl', import.meta.url), phase = ${JSON.stringify(phase)};
const record = (kind, detail = {}) => fs.appendFileSync(events, JSON.stringify({ kind, ...detail }) + '\\n');
let scope;
record('module-evaluated');
export function persona({ lifecycle }) {
  scope = lifecycle; record('persona'); lifecycle.onStop(() => record('persona-cleanup'));
  return 'selected-persona-175';
}
export function defaults({ personaText, lifecycle, ...options }) {
  record('defaults', { personaText, sameScope: lifecycle === scope }); lifecycle.onStop(() => record('defaults-cleanup'));
  return { ...buildDefaultConfig({ ...options, personaText }), selected175: true };
}
export function reset({ dataDir, defaults, lifecycle }) {
  record('reset', { selected: defaults.selected175, persona: defaults.persona.roleText, sameScope: lifecycle === scope });
  lifecycle.onStop(() => record('reset-cleanup'));
  if (phase === 'preflight-failure') throw new Error('175 synthetic preflight failure');
  if (phase === 'async-preflight') return Promise.reject(new Error('175 asynchronous reset is invalid'));
  return completePendingDataReset({ dataDir, defaults, isProcessAlive: () => false });
}
export function kernel({ lifecycle, components }) {
  record('factory', { sameScope: lifecycle === scope, samePersona: components['runtime.persona.text'] === persona });
  lifecycle.onStop(() => record('factory-cleanup'));
  return { config: { get: () => ({ server: { token: 'synthetic175', autoStart: false, closeToTray: false } }), onChange: () => () => record('unsubscribe') },
    bus: { emit() {} }, start: async () => { record('start'); return 4175; }, stop: async () => record('stop') };
}
`);
    const record = (kind, detail = {}) => fs.appendFileSync(eventsFile, JSON.stringify({ kind, ...detail }) + '\n');
    const events = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const app = new EventEmitter(), ipcMain = new EventEmitter(), handlers = new Map();
    Object.assign(app, {
      isPackaged: false, paths: { appData: path.join(root, 'app-data') },
      getPath(name) { return this.paths[name] ?? root; },
      setPath(name, value) {
        assert.equal(name, 'userData'); assert.equal(value, path.join(dataDir, 'electron-user-data'));
        assert.equal(fs.existsSync(cache), false, 'selected reset completes before Chromium receives its cache path');
        assert.equal(fs.existsSync(marker), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).selected175, true);
        record('set-user-data'); this.paths[name] = value;
      },
      requestSingleInstanceLock: () => true,
      async whenReady() {
        record('ready');
        // Changes after preflight must wait for the following application generation.
        fs.writeFileSync(manifest, JSON.stringify({ version: 1, id: 'changed', components: { 'runtime.kernel': './changed.mjs' } }));
      },
      setLoginItemSettings() {}, quit() { record('quit'); }, exit(code) { record('exit', { code }); },
    });
    ipcMain.handle = (name, fn) => handlers.set(name, fn);
    ipcMain.removeHandler = name => handlers.delete(name);
    class BrowserWindow extends EventEmitter {
      constructor() { super(); this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: '' }; this.webContents.setWindowOpenHandler = () => {}; this.webContents.isDestroyed = () => this.destroyed; record('window'); }
      isDestroyed() { return this.destroyed; }
      async loadURL(url) { this.webContents.mainFrame.url = url; }
      show() {} hide() {} focus() {}
      destroy() { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); record('window-destroy'); }
    }
    const electron = { app, ipcMain, BrowserWindow, dialog: { showErrorBox(title) { record('dialog', { title }); } },
      session: { defaultSession: { setProxy: async () => {}, setPermissionRequestHandler() {} } }, shell: { openExternal() { assert.fail('no external navigation'); } } };
    process.env.QQ_AGENT_DATA_DIR = dataDir; process.env.QQ_AGENT_PROFILE = '3'; process.argv = [process.execPath, 'synthetic-test175.mjs'];
    globalThis.fetch = async url => { assert.equal(String(url), 'https://kondius.cn/qq-agent/version.json'); return { ok: true, json: async () => ({ version: '0.5.0' }) }; };
    console.error = (...args) => record('error-log', { text: String(args[0]) });
    desktop = await import(pathToFileURL(path.join(root, 'electron/main.js')));
    if (phase === 'normal') {
      const application = await desktop.startElectron(electron);
      assert.equal(application.acquired, true);
      await desktop.stopElectron(electron);
      const kinds = events().map(event => event.kind);
      for (const kind of ['module-evaluated', 'persona', 'defaults', 'reset', 'set-user-data', 'ready', 'factory', 'start', 'window']) assert.equal(kinds.filter(value => value === kind).length, 1, kind);
      assert.ok(kinds.indexOf('reset') < kinds.indexOf('set-user-data'));
      assert.ok(kinds.indexOf('set-user-data') < kinds.indexOf('ready'));
      assert.ok(kinds.indexOf('ready') < kinds.indexOf('factory'));
      assert.equal(events().find(event => event.kind === 'defaults').personaText, 'selected-persona-175');
      assert.equal(events().find(event => event.kind === 'reset').selected, true);
      assert.equal(events().find(event => event.kind === 'reset').sameScope, true);
      assert.deepEqual(events().find(event => event.kind === 'factory'), { kind: 'factory', sameScope: true, samePersona: true });
      assert.deepEqual(kinds.filter(kind => kind.endsWith('-cleanup')), ['factory-cleanup', 'reset-cleanup', 'defaults-cleanup', 'persona-cleanup']);
      assert.ok(fs.existsSync(reset.backupDir), 'the verified synthetic backup remains available');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).server.port, 3410);
      assert.equal(kinds.includes('dialog'), false);
    } else {
      await assert.rejects(desktop.startElectron(electron), phase === 'preflight-failure' ? /175 synthetic preflight failure/ : /must be synchronous/);
      const kinds = events().map(event => event.kind);
      assert.equal(kinds.includes('set-user-data'), false);
      assert.equal(kinds.includes('ready'), false);
      assert.equal(kinds.includes('factory'), false);
      assert.deepEqual(kinds.filter(kind => kind.endsWith('-cleanup')), ['reset-cleanup', 'defaults-cleanup', 'persona-cleanup']);
      assert.ok(kinds.indexOf('persona-cleanup') < kinds.indexOf('dialog'), 'preflight resources close before startup reporting');
      assert.equal(kinds.filter(kind => kind === 'dialog').length, 1);
      assert.equal(events().find(event => event.kind === 'exit').code, 1);
      assert.ok(fs.existsSync(marker), 'rejected preflight preserves pending reset for the next boot');
      assert.ok(fs.existsSync(cache));
      assert.equal(handlers.size, 0);
    }
  });
}
