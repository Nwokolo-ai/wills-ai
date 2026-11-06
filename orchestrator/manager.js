import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allocate, release } from './portpool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG = 500;
export const jobs = new Map();

function log(job, stream, chunk) {
  const text = chunk.toString();
  job.logs.push({ t: Date.now(), stream, text });
  if (job.logs.length > MAX_LOG) job.logs.splice(0, job.logs.length - MAX_LOG);
  job.listeners.forEach(fn => fn({ stream, text }));
}

function spawnChild(job, label, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: job.cwd, 
    env: { ...process.env, ...env, NODE_ENV: env.NODE_ENV || 'development' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  job[label] = child;
  child.stdout.on('data', c => log(job, `${label}:out`, c));
  child.stderr.on('data', c => log(job, `${label}:err`, c));
  child.on('exit', (code) => {
    log(job, 'system', `${label} exited code=${code}\n`);
    if (job.status === 'running') job.status = code === 0 ? 'stopped' : 'crashed';
  });
  return child;
}

function makeJob(type, cwd) {
  return { id: 'job_' + crypto.randomBytes(6).toString('hex'), type, cwd,
    status: 'idle', ports: {}, logs: [], listeners: new Set(), startedAt: null };
}

async function startStatic(job, rootDir) {
  const port = await allocate();
  job.ports.frontend = port;
  const file = `/tmp/static-${job.id}.mjs`;
  const script = `
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = process.env.ROOT_DIR;
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
http.createServer((req,res)=>{
  let p = decodeURIComponent(new URL(req.url,'http://x').pathname);
  if(p==='/') p='/index.html';
  const fp = path.join(root, p);
  if(!fp.startsWith(root)){res.writeHead(403);return res.end();}
  fs.readFile(fp,(e,d)=>{
    if(e){res.writeHead(404);return res.end('not found: '+p);}
    res.writeHead(200,{'Content-Type':mime[path.extname(fp)]||'application/octet-stream'});
    res.end(d);
  });
}).listen(${port},'127.0.0.1',()=>console.log('static up on ${port}'));
`;
  fs.writeFileSync(file, script);
  spawnChild(job, 'frontend', 'node', [file], { ROOT_DIR: rootDir });
}

async function startNode(job, entry = 'server.js') {
  const port = await allocate();
  job.ports.backend = port;
  spawnChild(job, 'backend', 'node', [entry], { PORT: String(port) });
}

async function startFullstack(job, opts) {
  await startNode(job, opts.backendEntry || 'server.js');
  await startStatic(job, path.join(job.cwd, opts.frontendDir || 'public'));
}

async function startStrategy(job, opts) {
  // Points to the new strategy-runner.mjs we created in the shared folder
  const runner = opts.runner || path.resolve(__dirname, '../shared/strategy-runner.mjs');
  const stratFile = path.resolve(job.cwd, opts.strategyFile || 'strategy.js');
  
  // Pass all necessary environment variables to the runner & SDK
  spawnChild(job, 'strategy', 'node', [runner], {
    STRATEGY_FILE: stratFile,
    POLL_MS: String(opts.pollMs || 60000),
    STRATEGY_ID: opts.strategyId, 
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    USER_AI_KEY: opts.userAiKey || ''
  });
}

async function startTask(job, opts) {
  const child = spawnChild(job, 'task', opts.cmd, opts.args || []);
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs ?? 60000);
  return new Promise(res => child.on('exit', code => {
    clearTimeout(t); job.status = code === 0 ? 'done' : 'failed'; res(code);
  }));
}

export async function start(type, cwd, opts = {}) {
  if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`);
  const job = makeJob(type, cwd);
  jobs.set(job.id, job);
  job.status = 'starting';
  try {
    if (type === 'static')         await startStatic(job, cwd);
    else if (type === 'node')      await startNode(job, opts.entry);
    else if (type === 'fullstack') await startFullstack(job, opts);
    else if (type === 'strategy')  await startStrategy(job, opts);
    else if (type === 'task') { await startTask(job, opts); job.startedAt = Date.now(); return job; }
    else throw new Error(`unknown type: ${type}`);
    job.status = 'running';
    job.startedAt = Date.now();
    return job;
  } catch (e) {
    job.status = 'error'; log(job, 'system', `start failed: ${e.message}\n`);
    await stop(job.id); throw e;
  }
}

export async function stop(id) {
  const job = jobs.get(id); if (!job) return;
  job.status = 'stopping';
  for (const k of ['frontend', 'backend', 'strategy', 'task']) {
    const c = job[k];
    if (c && !c.killed) { try { c.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 2000); }
  }
  for (const p of Object.values(job.ports)) release(p);
  job.status = 'stopped';
}

export function subscribe(id, fn) {
  const job = jobs.get(id); if (!job) return () => {};
  job.listeners.add(fn);
  return () => job.listeners.delete(fn);
}
