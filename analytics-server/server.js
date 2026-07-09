// Zapret GUI analytics server.
//
// Accurate online counting: new clients (v1.3.0+) send stateless HTTP heartbeats
// from the Electron MAIN process with a persistent anonymous client id.
//   - dedup by id  → counts PEOPLE, not connections (restarts/reconnects don't inflate)
//   - stateless HTTP → survives localtunnel drops (no long-lived socket to break)
//   - main-process sender → keeps beating while the window is minimized / in tray
// Legacy clients (≤1.2.9x) still connect via WebSocket — counted separately and
// merged into the total until everyone updates.
//
// Endpoints:
//   GET /hb?id=<uuid>&v=<version>   heartbeat (also accepts POST)
//   GET /bye?id=<uuid>              instant "I'm quitting" (optional, improves accuracy)
//   GET /stats.json?p=<password>    live stats JSON
//   GET /                           dashboard page (enter password once)

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// A client is "online" if we got a heartbeat within this window.
// Clients beat every 45s → window tolerates one missed beat + tunnel hiccups.
const ONLINE_WINDOW_MS = parseInt(process.env.ONLINE_WINDOW_MS || '120000', 10);
// Forget ids that have been silent for a long time (memory hygiene)
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

// ─── Heartbeat store: clientId → { lastSeen, version } ───
const clients = new Map();

function onlineIds(now = Date.now()) {
    const list = [];
    for (const [id, info] of clients) {
        if (now - info.lastSeen <= ONLINE_WINDOW_MS) list.push([id, info]);
    }
    return list;
}

function buildStats() {
    const now = Date.now();
    const online = onlineIds(now);
    const byVersion = {};
    for (const [, info] of online) {
        const v = info.version || '?';
        byVersion[v] = (byVersion[v] || 0) + 1;
    }
    const legacy = legacySockets().length;
    return {
        online: online.length,          // unique heartbeat clients (v1.3.0+)
        legacy,                         // old-version clients still on WebSocket
        total: online.length + legacy,  // the number that matters
        byVersion,
        windowSec: Math.round(ONLINE_WINDOW_MS / 1000),
        updatedAt: new Date(now).toISOString(),
    };
}

// Purge ancient ids hourly
setInterval(() => {
    const now = Date.now();
    for (const [id, info] of clients) {
        if (now - info.lastSeen > PURGE_AFTER_MS) clients.delete(id);
    }
}, 60 * 60 * 1000);

// ─── HTTP ───
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function send(res, code, body, type = 'application/json') {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;

    if (url.pathname === '/hb') {
        const id = (q.get('id') || '').trim();
        if (!ID_RE.test(id)) return send(res, 400, '{"ok":false}');
        const version = (q.get('v') || '?').slice(0, 20);
        const known = clients.get(id);
        clients.set(id, { lastSeen: Date.now(), version });
        if (!known) console.log(`[+] hb: new client (${version}). Online now: ${buildStats().total}`);
        broadcastLegacyAdmins();
        return send(res, 200, '{"ok":true}');
    }

    if (url.pathname === '/bye') {
        const id = (q.get('id') || '').trim();
        if (ID_RE.test(id) && clients.delete(id)) {
            console.log(`[-] bye. Online now: ${buildStats().total}`);
            broadcastLegacyAdmins();
        }
        return send(res, 200, '{"ok":true}');
    }

    if (url.pathname === '/stats.json') {
        if (q.get('p') !== ADMIN_PASSWORD) return send(res, 403, '{"error":"wrong password"}');
        return send(res, 200, JSON.stringify(buildStats()));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, DASHBOARD_HTML, 'text/html');
    }

    send(res, 404, '{"error":"not found"}');
});

// ─── Legacy WebSocket support (app versions ≤1.2.9x) ───
// Live-socket counting (Set) instead of the old drift-prone ++/-- counter.
const wss = new WebSocket.Server({ server });

function legacySockets() {
    return [...wss.clients].filter(ws => ws.readyState === WebSocket.OPEN && !ws.isAdmin);
}

function broadcastLegacyAdmins() {
    const msg = JSON.stringify({ type: 'stats', count: buildStats().total });
    wss.clients.forEach(c => {
        if (c.isAdmin && c.readyState === WebSocket.OPEN) c.send(msg);
    });
}

wss.on('connection', (ws) => {
    ws.isAdmin = false;
    ws.lastActivity = Date.now();
    console.log(`[+] legacy ws connected. Online now: ${buildStats().total}`);
    broadcastLegacyAdmins();

    ws.on('message', (message) => {
        ws.lastActivity = Date.now();
        try {
            const data = JSON.parse(message);
            if (data.type === 'admin_auth') {
                if (data.password === ADMIN_PASSWORD) {
                    ws.isAdmin = true;
                    ws.send(JSON.stringify({ type: 'stats', count: buildStats().total }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) { /* ignore */ }
    });

    ws.on('close', () => { broadcastLegacyAdmins(); });
    ws.on('error', () => {});
});

// Kill zombie legacy sockets that localtunnel silently dropped
setInterval(() => {
    const now = Date.now();
    wss.clients.forEach(ws => {
        if (now - ws.lastActivity > 90_000) ws.terminate();
    });
}, 30_000);

// ─── Dashboard ───
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zapret GUI — онлайн</title>
<style>
  :root { color-scheme: dark; }
  * { margin:0; box-sizing:border-box; }
  body { background:#0c0e14; color:#e8eaf0; font-family:'Segoe UI',system-ui,sans-serif;
         min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { text-align:center; padding:40px; max-width:520px; width:100%; }
  h1 { font-size:0.95rem; font-weight:600; color:#8b90a0; letter-spacing:0.08em; text-transform:uppercase; }
  #count { font-size:7rem; font-weight:800; line-height:1.1; margin:12px 0;
           background:linear-gradient(135deg,#5b8def,#4ade80); -webkit-background-clip:text; background-clip:text; color:transparent; }
  #sub { color:#525666; font-size:0.85rem; min-height:1.2em; }
  #vers { margin-top:28px; display:flex; flex-direction:column; gap:6px; }
  .vrow { display:flex; justify-content:space-between; padding:8px 14px; background:#181b25;
          border:1px solid rgba(255,255,255,0.07); border-radius:8px; font-size:0.85rem; }
  .vrow span:last-child { font-weight:700; color:#5b8def; }
  #login { display:flex; gap:8px; margin-top:16px; }
  input { flex:1; padding:10px 14px; background:#131620; color:#e8eaf0; font-size:0.9rem;
          border:1px solid rgba(255,255,255,0.12); border-radius:8px; outline:none; }
  button { padding:10px 18px; background:#5b8def; color:#fff; border:0; border-radius:8px; font-weight:600; cursor:pointer; }
  .err { color:#f87171; } .stale #count { filter:grayscale(1); opacity:0.4; }
</style></head><body>
<div class="card">
  <h1>Zapret GUI — сейчас онлайн</h1>
  <div id="count">–</div>
  <div id="sub">введите пароль</div>
  <div id="login"><input id="pw" type="password" placeholder="Пароль администратора"><button onclick="go()">Смотреть</button></div>
  <div id="vers"></div>
</div>
<script>
let pw = localStorage.getItem('zapret-stats-pw') || '';
let timer = null, lastOkAt = 0;
async function poll() {
  try {
    const r = await fetch('/stats.json?p=' + encodeURIComponent(pw), { cache:'no-store' });
    if (r.status === 403) { logout('Неверный пароль'); return; }
    const s = await r.json();
    lastOkAt = Date.now();
    document.body.classList.remove('stale');
    document.getElementById('login').style.display = 'none';
    document.getElementById('count').textContent = s.total;
    document.getElementById('sub').innerHTML =
      'новых (точный счёт): <b>' + s.online + '</b> · старые версии: <b>' + s.legacy + '</b>' +
      '<br>окно ' + s.windowSec + 'с · обновлено ' + new Date(s.updatedAt).toLocaleTimeString();
    const vers = Object.entries(s.byVersion).sort((a,b) => b[1]-a[1]);
    document.getElementById('vers').innerHTML =
      vers.map(([v,n]) => '<div class="vrow"><span>v'+v+'</span><span>'+n+'</span></div>').join('');
  } catch (e) {
    if (Date.now() - lastOkAt > 20000) {
      document.body.classList.add('stale');
      document.getElementById('sub').innerHTML = '<span class="err">нет связи с сервером…</span>';
    }
  }
}
function go() {
  pw = document.getElementById('pw').value;
  localStorage.setItem('zapret-stats-pw', pw);
  start();
}
function logout(msg) {
  clearInterval(timer); timer = null;
  localStorage.removeItem('zapret-stats-pw');
  document.getElementById('login').style.display = 'flex';
  document.getElementById('sub').innerHTML = '<span class="err">' + msg + '</span>';
  document.getElementById('count').textContent = '–';
}
function start() { if (timer) clearInterval(timer); poll(); timer = setInterval(poll, 5000); }
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
if (pw) start();
</script></body></html>`;

server.listen(PORT, () => {
    console.log('=========================================');
    console.log(`Analytics Server running on port ${PORT}`);
    console.log(`Dashboard:  http://localhost:${PORT}/  (пароль: ${ADMIN_PASSWORD})`);
    console.log(`Online window: ${ONLINE_WINDOW_MS / 1000}s`);
    console.log('=========================================');
});
