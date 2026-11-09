import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as manager from './manager.js';
import { mountPreview } from './proxy.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
mountPreview(app);

app.post('/api/jobs', async (req, res) => {
  try { const j = await manager.start(req.body.type, req.body.cwd, req.body.opts);
    res.json({ id: j.id, ports: j.ports, status: j.status }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/jobs', (_rq, res) => res.json([...manager.jobs.values()].map(j =>
  ({ id: j.id, type: j.type, status: j.status, ports: j.ports, startedAt: j.startedAt }))));
app.get('/api/jobs/:id', (req, res) => {
  const j = manager.jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({ id: j.id, type: j.type, status: j.status, ports: j.ports, logs: j.logs });
});
app.delete('/api/jobs/:id', async (req, res) => { await manager.stop(req.params.id); res.json({ ok: true }); });

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/logs' });
wss.on('connection', (ws, req) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  const unsub = manager.subscribe(id, m => ws.readyState === 1 && ws.send(JSON.stringify(m)));
  ws.on('close', unsub);
});

const PORT = Number(process.env.ORCHESTRATOR_PORT || 7400);
server.listen(PORT, '127.0.0.1', () => console.log(`orchestrator ready on ${PORT}`));
