const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// How often to check for dead connections (ms)
const HEARTBEAT_INTERVAL = 30_000;
// A connection is considered dead if no message received in this time (ms)
const CONNECTION_TIMEOUT = 90_000;

const wss = new WebSocket.Server({ port: PORT });

let onlineUsers = 0;

wss.on('connection', (ws) => {
    ws.isAdmin = false;
    ws.lastActivity = Date.now(); // Track last message time

    onlineUsers++;
    console.log(`[+] User connected. Total online: ${onlineUsers}`);
    broadcastAdmin();

    ws.on('message', (message) => {
        ws.lastActivity = Date.now(); // Refresh on any incoming message
        try {
            const data = JSON.parse(message);
            if (data.type === 'admin_auth') {
                if (data.password === ADMIN_PASSWORD) {
                    ws.isAdmin = true;
                    onlineUsers--; // Don't count admins as users
                    console.log(`[*] Admin authenticated.`);
                    ws.send(JSON.stringify({ type: 'stats', count: onlineUsers }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
                }
            } else if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (e) {
            // ignore parsing errors
        }
    });

    ws.on('close', () => {
        if (!ws.isAdmin) {
            onlineUsers = Math.max(0, onlineUsers - 1); // Guard against negative
            console.log(`[-] User disconnected. Total online: ${onlineUsers}`);
        } else {
            console.log(`[*] Admin disconnected.`);
        }
        broadcastAdmin();
    });

    ws.on('error', () => {
        // Errors are handled by the close event
    });
});

// ─── Heartbeat: terminate dead connections that localtunnel silently dropped ───
setInterval(() => {
    const now = Date.now();
    wss.clients.forEach(ws => {
        if (now - ws.lastActivity > CONNECTION_TIMEOUT) {
            console.log(`[!] Terminating stale connection (no activity for ${CONNECTION_TIMEOUT / 1000}s)`);
            ws.terminate(); // Triggers 'close' event → counter decrements correctly
        }
    });
}, HEARTBEAT_INTERVAL);

function broadcastAdmin() {
    wss.clients.forEach(client => {
        if (client.isAdmin && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'stats', count: onlineUsers }));
        }
    });
}

console.log(`=========================================`);
console.log(`Analytics Server running on port ${PORT}`);
console.log(`Default admin password is: ${ADMIN_PASSWORD}`);
console.log(`=========================================`);
