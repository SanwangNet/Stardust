import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { endpointsForProcess } from '../scripts/updater/running-port.mjs';

test('finds the actual process listener independently of saved configuration', { skip: process.platform !== 'linux' }, async t => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.ok((await endpointsForProcess(process.pid)).some(endpoint => endpoint.port === server.address().port && endpoint.host === "127.0.0.1"));
});
