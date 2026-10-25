// Isolated reset lifecycle regression. Only temporary synthetic files and DI
// owners are used: no QQ process, child worker, listening socket or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel } from '../src/kernel/kernel.js';
import { createDataResetCoordinator } from '../src/kernel/data-reset.js';
import { defaultComponents } from '../bundled/runtime-defaults/components.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('root reset awaits account and protocol owners before stopping primary business and backing up', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-account-reset-'));
  const dataDir = path.join(root, 'data'), events = [];
  const accountStop = deferred(), accountStopping = deferred();
  let kernel, reset, backupCount = 0;
  const closeCounts = new Map();
  t.after(async () => {
    accountStop.resolve();
    await kernel?.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^qqa-account-reset-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'bundled'));
  const close = name => async () => {
    closeCounts.set(name, (closeCounts.get(name) || 0) + 1);
    events.push(name + ':start');
    if (name === 'accounts') {
      accountStopping.resolve();
      await accountStop.promise;
    }
    events.push(name + ':done');
  };
  kernel = createKernel({
    appRoot: root,
    env: { QQ_AGENT_DATA_DIR: dataDir, QQ_AGENT_PORT: '0', QQ_AGENT_MIGRATE_FROM: path.join(root, 'absent') },
    fetchImpl: () => assert.fail('No network requests are permitted'),
    components: {
      'runtime.logger': args => defaultComponents['runtime.logger']({ ...args, mirrorConsole: false }),
      'runtime.priceUpdates': () => ({ resolve: () => null, refresh: async () => ({ ok: true }) }),
      'runtime.accounts': () => ({ close: close('accounts'), snapshot: async () => ({ primary: 'primary', accounts: [] }) }),
      'runtime.accountGateway': () => ({ close: close('gateway'), handle() { assert.fail('No account requests are permitted'); } }),
      'runtime.protocolLogin': () => ({ close: close('protocolLogin') }),
      'runtime.localProtocols': () => ({ close: close('localProtocols') }),
      'runtime.services': args => {
        const services = defaultComponents['runtime.services'](args);
        return { ...services, async stop() { events.push('primaryBusiness:stop'); await services.stop(); } };
      },
      'runtime.reset': args => {
        reset = createDataResetCoordinator({ ...args, fsImpl: {
          ...fs,
          cpSync(source, target, options) {
            backupCount++;
            assert.deepEqual(events.slice(0, 8), [
              'gateway:start', 'gateway:done', 'accounts:start', 'accounts:done',
              'protocolLogin:start', 'protocolLogin:done', 'localProtocols:start', 'localProtocols:done',
            ]);
            assert.ok(events.indexOf('primaryBusiness:stop') > events.indexOf('localProtocols:done'));
            events.push('backup');
            return fs.cpSync(source, target, options);
          },
        } });
        return reset;
      },
      'llm.complete': () => assert.fail('No model calls are permitted'),
    },
  });
  const syntheticAccountData = path.join(dataDir, 'accounts', 'synthetic-account', 'data');
  fs.mkdirSync(syntheticAccountData, { recursive: true });
  fs.writeFileSync(path.join(syntheticAccountData, 'synthetic-state.json'), '{"saved":true}\n');
  const pending = reset.request();
  await accountStopping.promise;
  assert.equal(reset.status().phase, 'preparing');
  assert.equal(backupCount, 0, 'No backup may begin while the account owner is still stopping');
  assert.equal(events.includes('primaryBusiness:stop'), false, 'The primary business must wait for account shutdown');
  assert.equal(events.includes('protocolLogin:start'), false, 'Protocol administration remains available until account shutdown completes');
  accountStop.resolve();
  const result = await pending;
  assert.equal(result.resetAccepted, true);
  assert.equal(result.resetCompleted, false);
  assert.equal(backupCount, 1);
  assert.equal(fs.readFileSync(path.join(result.backupDir, 'accounts', 'synthetic-account', 'data', 'synthetic-state.json'), 'utf8'), '{"saved":true}\n');
  assert.equal(fs.existsSync(path.join(syntheticAccountData, 'synthetic-state.json')), true, 'Accepting reset does not delete the source directory');
  await kernel.stop();
  for (const name of ['gateway', 'accounts', 'protocolLogin', 'localProtocols']) {
    assert.equal(closeCounts.get(name), 1, `${name} is disposed once across reset and final stop`);
  }
});
