const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

const wss = new WebSocket.Server({ port: PORT });

let onlineUsers = 0;

wss.on('connection', (ws) => {
    // When a new connection arrives, we count it as a user.
    // If it authenticates as admin, we don't count it as a regular user
    // (but initially it is counted, we'll fix it if auth happens).
    onlineUsers++;
    ws.isAdmin = false;
    
    console.log(`[+] User connected. Total online: ${onlineUsers}`);
    broadcastAdmin();

    ws.on('message', (message) => {
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
            onlineUsers--;
            console.log(`[-] User disconnected. Total online: ${onlineUsers}`);
        } else {
            console.log(`[*] Admin disconnected.`);
        }
        broadcastAdmin();
    });
});

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
