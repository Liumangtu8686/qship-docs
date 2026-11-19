#!/usr/bin/env node
// Muse doorbell: deliver pushed messages through the one-shot wake path.
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const log = (event, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
const env = process.env;
const profile = env.AGENTPEERCHAT_CONFIG || join(homedir(), 'workspace/agentpeerchat/profile.json');
const script = fileURLToPath(new URL('./apc-watch-v2.sh', import.meta.url));
let config = {};
try {
  try { config = JSON.parse(await readFile(profile, 'utf8')); }
  catch (error) {
    if (!(error.code === 'ENOENT' && env.AGENTPEERCHAT_TOKEN && env.AGENTPEERCHAT_URL)) {
      throw new Error('CLI profile is unreadable or invalid JSON; set AGENTPEERCHAT_CONFIG, or AGENTPEERCHAT_URL and AGENTPEERCHAT_TOKEN without a profile.');
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CLI profile must be a JSON object.');
  if (typeof WebSocket !== 'function') throw new Error('Node 22.15+ with built-in WebSocket is required.');
  if (!env.HATCH_HOOK_RUNTIME) throw new Error('HATCH_HOOK_RUNTIME must point to the Muse hook runtime.');
  try { await access(env.HATCH_HOOK_RUNTIME); await access(script); }
  catch { throw new Error('Muse hook runtime or apc-watch-v2.sh is unreadable.'); }
} catch (error) { console.error(error.message); process.exit(1); }
const token = env.AGENTPEERCHAT_TOKEN || config.token;
if (typeof token !== 'string' || !token.trim()) {
  console.error('No CLI token: set AGENTPEERCHAT_TOKEN or the profile token field.'); process.exit(1);
}
let base;
try {
  base = new URL(env.AGENTPEERCHAT_URL || config.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw 0;
  if (config.url && env.AGENTPEERCHAT_URL && !env.AGENTPEERCHAT_TOKEN && new URL(config.url).origin !== base.origin) throw 0;
} catch { console.error('Invalid instance URL or profile/URL mismatch; use the saved instance or supply its explicit token.'); process.exit(1); }
// Pass the exact same identity and instance to the CLI as to the stream.
const childEnv = { ...env, AGENTPEERCHAT_CONFIG: profile, AGENTPEERCHAT_URL: base.origin,
  AGENTPEERCHAT_TOKEN: token, APC_SELF_ID: env.APC_SELF_ID || config.principal_id || '' };
// The CLI allows env-only connections when there is no saved profile.
try { await access(profile); } catch { childEnv.AGENTPEERCHAT_CONFIG = ''; }

let stopping = false, connected = false, ws, poll, retry, heartbeat, handshake, controller;
let child, childTimeout, queued = false;
const pushes = new Map();
let failures = 0;
function check(reason, push) {
  if (stopping) return;
  if (push) pushes.set(push.type === 'message' ? push.message.id : push.thread_id, push);
  if (child) { if (!push) queued = true; return; }
  log('check', { reason });
  const batch = [...pushes.values()];
  pushes.clear();
  const args = batch.length ? [script, '-'] : [script];
  child = spawn('bash', args, { env: childEnv, stdio: ['pipe', 'inherit', 'inherit'], detached: true });
  child.stdin.on('error', () => log('check_input_failed'));
  child.stdin.end(batch.length ? JSON.stringify(batch) : undefined);
  const current = child;
  childTimeout = setTimeout(() => {
    log('check_timeout');
    try { process.kill(-current.pid, 'SIGKILL'); } catch { /* exited */ }
  }, 45000);
  current.on('error', () => log('check_start_failed'));
  current.on('close', (code, signal) => {
    clearTimeout(childTimeout); child = undefined;
    log('check_complete', { code, signal });
    if (pushes.size) check('coalesced');
    else if (queued) { queued = false; check('coalesced'); }
  });
}
function fallback() {
  connected = false;
  if (!poll && !stopping) {
    log('fallback_polling', { interval_ms: 5000 });
    check('fallback');
    poll = setInterval(() => check('fallback'), 5000);
  }
}
async function connect() {
  if (stopping) return;
  let socket, finished = false, lastPong = Date.now();
  const failed = () => {
    if (finished) return;
    finished = true;
    clearTimeout(handshake); clearInterval(heartbeat);
    controller?.abort();
    try { socket?.close(); } catch { /* already closed */ }
    if (stopping) return;
    log('stream_disconnected'); fallback();
    failures += 1;
    const delay = failures >= 5 ? 60000 : Math.min(30000, 1000 * 2 ** (failures - 1));
    log('retry_scheduled', { failures, delay_ms: delay });
    retry = setTimeout(connect, delay);
  };
  try {
    controller = new AbortController();
    handshake = setTimeout(failed, 10000);
    const response = await fetch(new URL('/api/v1/realtime/ticket', base), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) { log('ticket_failed', { status: response.status }); failed(); return; }
    const data = await response.json();
    if (finished || stopping) return;
    if (typeof data.ticket !== 'string' || !data.ticket) { failed(); return; }
    const url = new URL('/api/v1/events', base);
    url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = socket = new WebSocket(url, ['apc-v1', `ticket.${data.ticket}`]);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
    let pairedFallback = false;
    socket.addEventListener('message', event => {
      if (finished || stopping) return;
      if (event.data === 'pong') { lastPong = Date.now(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const skipFallback = pairedFallback;
      pairedFallback = false;
      if (message?.type === 'ready' && !connected) {
        clearTimeout(handshake); clearInterval(poll); poll = undefined;
        connected = true; failures = 0; lastPong = Date.now();
        log('ready', { type: 'ready', mode: 'push' });
        // Catch messages sent before startup or during a disconnected interval.
        check('resync');
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 60000) { log('heartbeat_timeout'); failed(); return; }
          try { socket.send('ping'); } catch { failed(); }
        }, 30000);
        socket.send('ping');
      } else if (message?.type === 'message' && message.thread_id && message.message?.id) {
        pairedFallback = true;
        check('message', message);
      } else if (message?.type === 'new_group' && message.thread_id && typeof message.instruction === 'string') {
        pairedFallback = true;
        check('new_group', message);
      } else if (message?.type === 'mailbox_changed' && !skipFallback) {
        log('mailbox_changed'); check('mailbox_changed');
      }
    });
  } catch { failed(); }
}
function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of [poll, retry, heartbeat, handshake, childTimeout]) clearTimeout(timer);
  controller?.abort();
  try { ws?.close(); } catch { /* closed */ }
  if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
  log('stopped');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
fallback();
void connect();
