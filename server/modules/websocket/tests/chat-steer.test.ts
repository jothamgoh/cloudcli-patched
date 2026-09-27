import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'steer-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type SteerCall = { provider: string; sessionId: string; command: string };

async function withGateway(
  steerResult: boolean,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: string[];
    steers: SteerCall[];
    releaseRun: () => void;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-steer-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: string[] = [];
  const steers: SteerCall[] = [];
  const socket = createFakeSocket();
  let releaseRun: () => void = () => {};
  const heldRun = new Promise<void>((resolve) => { releaseRun = resolve; });

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Steer session', now, now, null);

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (_provider: string, command: string) => {
            runs.push(command);
            await heldRun;
          },
          steer: async (provider: string, sessionId: string, command: string) => {
            steers.push({ provider, sessionId, command });
            return steerResult;
          },
        } as never,
      },
    );

    await runTest({ socket, runs, steers, releaseRun });
  } finally {
    releaseRun();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a steer during a run goes to the running turn instead of starting a new one', async () => {
  await withGateway(true, async ({ socket, runs, steers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'first' }));
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'change of plan' }));
    await settle();

    assert.deepEqual(runs, ['first']);
    assert.deepEqual(steers, [{ provider: 'claude', sessionId: SESSION_ID, command: 'change of plan' }]);
    assert.equal(socket.frames.some((frame) => frame.code === 'STEER_UNAVAILABLE'), false);
  });
});

test('a steer after the run finished is sent as a normal turn', async () => {
  await withGateway(true, async ({ socket, runs, steers, releaseRun }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'first' }));
    await settle();
    releaseRun();
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'follow-up' }));
    await settle();

    assert.deepEqual(runs, ['first', 'follow-up']);
    assert.deepEqual(steers, []);
  });
});

test('a steer the runtime refuses is reported to the client', async () => {
  await withGateway(false, async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'first' }));
    await settle();
    socket.emit('message', JSON.stringify({ type: 'chat.steer', sessionId: SESSION_ID, content: 'too late' }));
    await settle();

    assert.deepEqual(runs, ['first']);
    assert.equal(socket.frames.some((frame) => JSON.stringify(frame).includes('STEER_UNAVAILABLE')), true);
  });
});
