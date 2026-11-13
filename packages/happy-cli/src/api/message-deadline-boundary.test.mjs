import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { Server } from 'socket.io';

test('message_deadline_covers_preparation_and_real_socket_connect', async () => {
  const directory = mkdtempSync('/private/tmp/xc-disposable/happy-message-deadline-');
  const http = createServer();
  const server = new Server(http, { path: '/v1/updates', transports: ['websocket'] });
  const received = [];
  server.on('connection', socket => socket.on('message', (message, acknowledge) => {
    received.push(message);
    acknowledge({ ok: true, id: 'row-' + received.length, seq: received.length,
      localId: message.localId, createdAt: Date.now() });
  }));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  let child;
  try {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { Socket } from 'socket.io-client';
      import { ApiSessionMessageClient } from './src/api/apiSessionMessage.ts';

      // Use real transport/crypto, adding CPU-stall fault injection only after
      // the actual writer connect event. No connection or ACK is fabricated.
      const connect = Socket.prototype.connect;
      let connections = 0;
      let stalled = false;
      Socket.prototype.connect = function () {
        this.once('connect', () => {
          if (++connections === 4) {
            stalled = true;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
          }
        });
        return connect.call(this);
      };
      try {
        const client = new ApiSessionMessageClient('isolated-transport-test', {
          id: 'deadline-test', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy',
        });
        const input = { messageRole: 'agent', messageType: 'event', message: 'deadline check',
          eventId: 'deadline-event', localId: 'xc-msg-v1-' + 'a'.repeat(64), timeoutMs: 1000 };
        assert.equal((await client.sendAgentEventOnce(input)).result, 'success');
        await assert.rejects(client.sendAgentEventOnce({ ...input, localId: 'xc-msg-v1-' + 'b'.repeat(64) }),
          error => /deadline/.test(error.message) && error.persistenceOutcome === 'not-sent');
        assert.equal(stalled, true, 'must reach the real writer connection before the injected stall');

        // Real encryption and exact-ciphertext validation must consume the
        // same budget, not receive a fresh timeout after a CPU/GC stall.
        const ciphertext = client.prepareAgentEventOnce(input);
        const prepare = client.prepareAgentEventOnce;
        let preparations = 0;
        client.prepareAgentEventOnce = function (request) {
          const result = prepare.call(this, request);
          preparations += 1;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
          return result;
        };
        for (const encryptedRecord of [undefined, ciphertext]) {
          await assert.rejects(client.sendAgentEventOnce({ ...input, encryptedRecord,
            localId: 'xc-msg-v1-' + 'c'.repeat(64) }),
            error => /deadline/.test(error.message) && error.persistenceOutcome === 'not-sent');
        }
        assert.equal(preparations, 2);
        assert.equal(connections, 4, 'expired preparation must not start another connection');
      } finally { Socket.prototype.connect = connect; }
    `;
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('../..', import.meta.url), timeout: 15000,
      env: { ...process.env, HAPPY_HOME_DIR: directory,
        HAPPY_SERVER_URL: 'http://127.0.0.1:' + http.address().port,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output = (output + data).slice(-16000); });
    child.stderr.on('data', data => { output = (output + data).slice(-16000); });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    assert.equal(received.length, 1, 'expired operation must never reach the local transport peer');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
});
