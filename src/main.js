const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, exec, execFile, execSync } = require('child_process');
const https = require('https');

const APP_VERSION = '1.2.9e';
const UPDATE_URL = 'https://raw.githubusercontent.com/murzikovv/zapret-gui-remake/main/version.json';

ipcMain.handle('check-app-update', async () => {
    console.log('[UPDATE] Checking for updates at:', UPDATE_URL);
    return new Promise((resolve) => {
        const urlWithCacheBust = UPDATE_URL + '?t=' + Date.now();
        https.get(urlWithCacheBust, { headers: { 'User-Agent': 'ZapretGUI-App' } }, (res) => {
            console.log('[UPDATE] Server response status:', res.statusCode);
            if (res.statusCode !== 200) {
                console.error('[UPDATE] Failed to fetch version.json, status:', res.statusCode);
                resolve({ success: false });
                return;
            }
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    const hasUpdate = info.version !== APP_VERSION;
                    console.log('[UPDATE] Found version:', info.version, 'Current:', APP_VERSION, 'HasUpdate:', hasUpdate);
                    resolve({ success: true, hasUpdate, version: info.version, url: info.url, changelog: info.changelog });
                } catch (e) { 
                    console.error('[UPDATE] JSON Parse Error:', e.message);
                    resolve({ success: false }); 
                }
            });
        }).on('error', (e) => {
            console.error('[UPDATE] Request Error:', e.message);
            resolve({ success: false });
        });
    });
});

// Track update download state so reopening the modal shows live progress
// rather than starting a second concurrent download on top of the first.
let updateDownloadState = { active: false, percent: 0, text: '', url: null };
let activeUpdateRequest = null;
let activeUpdateFileStream = null;
let activeUpdateTempPath = null;

function broadcastUpdateProgress() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update-progress', {
            percent: updateDownloadState.percent,
            text: updateDownloadState.text,
            active: updateDownloadState.active
        });
    }
}

ipcMain.handle('get-update-download-state', () => updateDownloadState);
ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('cancel-app-update-download', async () => {
    if (!updateDownloadState.active) return { wasActive: false };
    try {
        if (activeUpdateRequest) activeUpdateRequest.destroy(new Error('user cancelled'));
    } catch (e) {}
    try {
        if (activeUpdateFileStream) activeUpdateFileStream.close();
    } catch (e) {}
    try {
        if (activeUpdateTempPath && fs.existsSync(activeUpdateTempPath)) {
            fs.unlinkSync(activeUpdateTempPath);
        }
    } catch (e) {}
    activeUpdateRequest = null;
    activeUpdateFileStream = null;
    activeUpdateTempPath = null;
    updateDownloadState = { active: false, percent: 0, text: '', url: null };
    broadcastUpdateProgress();
    console.log('[UPDATE] Download cancelled by user');
    return { wasActive: true };
});

ipcMain.handle('download-app-update', async (event, url) => {
    if (updateDownloadState.active) {
        // Don't restart; tell UI to attach to the in-flight download.
        return { alreadyDownloading: true };
    }
    updateDownloadState = { active: true, percent: 0, text: 'Подключение...', url };
    broadcastUpdateProgress();

    return new Promise((resolve) => {
        const tempPath = path.join(app.getPath('temp'), 'ZapretGUISetup.exe');
        // Wipe any leftover temp file from a previous run/cancel
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
        const file = fs.createWriteStream(tempPath);
        activeUpdateFileStream = file;
        activeUpdateTempPath = tempPath;

        const cleanupRefs = () => {
            activeUpdateRequest = null;
            activeUpdateFileStream = null;
            activeUpdateTempPath = null;
        };

        const failed = (reason) => {
            try { file.close(); } catch (e) {}
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
            updateDownloadState = { active: false, percent: 0, text: '', url: null };
            broadcastUpdateProgress();
            cleanupRefs();
            console.error('[UPDATE DOWNLOAD]', reason);
            resolve(false);
        };

        const handleRes = (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                activeUpdateRequest = https.get(res.headers.location, { headers: { 'User-Agent': 'ZapretGUI-App' } }, handleRes).on('error', failed);
                return;
            }
            if (res.statusCode !== 200) return failed('HTTP ' + res.statusCode);
            const total = parseInt(res.headers['content-length'], 10) || 0;
            let current = 0;
            res.on('data', (chunk) => {
                current += chunk.length;
                updateDownloadState.percent = total ? Math.round(current / total * 100) : 0;
                updateDownloadState.text = total
                    ? `Загрузка обновления... ${(current / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ`
                    : 'Загрузка обновления...';
                broadcastUpdateProgress();
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                updateDownloadState.percent = 100;
                updateDownloadState.text = 'Запуск установщика...';
                broadcastUpdateProgress();
                cleanupRefs();
                exec(`start "" "${tempPath}"`);
                isQuitting = true;
                app.quit();
                resolve(true);
            });
            res.on('error', () => failed('response error'));
        };
        activeUpdateRequest = https.get(url, { headers: { 'User-Agent': 'ZapretGUI-App' } }, handleRes).on('error', failed);
    });
});

function isAdmin() {
    try {
        execSync('net session', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

console.log('[STARTUP] Checking for admin privileges...');
if (process.platform === 'win32' && !isAdmin()) {
    console.log('[STARTUP] Not running as admin. Attempting elevation...');
    try {
        let command = process.execPath;
        let argsList = app.isPackaged ? process.argv.slice(1) : [app.getAppPath(), ...process.argv.slice(2)];

        // Use a temporary VBScript for robust elevation without quoting hell
        const vbsPath = path.join(app.getPath('userData'), 'elevate.vbs');
        const vbsCode = `Set UAC = CreateObject("Shell.Application")\r\nUAC.ShellExecute "${command}", "${argsList.join(' ')}", "", "runas", 1`;
        fs.writeFileSync(vbsPath, vbsCode, 'utf-8');

        exec(`cscript //nologo "${vbsPath}"`, (err) => {
            if (err) console.error('[STARTUP] Failed to elevate:', err);
            app.quit();
        });
    } catch (e) {
        console.error('[STARTUP] Elevation error:', e);
        app.quit();
    }
    return;
}
console.log('[STARTUP] Admin privileges confirmed.');

// Use default userData path (AppData/Roaming) since we are using NSIS installer now
// which installs to protected Program Files directory.

const VERSIONS_DIR = path.join(app.getPath('userData'), 'zapret_versions');

if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, { recursive: true });

const GLOBAL_LISTS_DIR = path.join(app.getPath('userData'), 'global_lists');
if (!fs.existsSync(GLOBAL_LISTS_DIR)) fs.mkdirSync(GLOBAL_LISTS_DIR, { recursive: true });

// Initialize all list files in global cache
const ALL_LIST_FILES = ['list-general.txt', 'list-exclude.txt', 'list-general-user.txt', 'list-exclude-user.txt'];
ALL_LIST_FILES.forEach(file => {
    const p = path.join(GLOBAL_LISTS_DIR, file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8');
});

// One-time migration: ensure user domains are preserved
const MIGRATION_FLAG = path.join(GLOBAL_LISTS_DIR, '.migrated-to-user-v2');
if (!fs.existsSync(MIGRATION_FLAG)) {
    try {
        [['list-general.txt', 'list-general-user.txt'], ['list-exclude.txt', 'list-exclude-user.txt']].forEach(([src, dst]) => {
            const srcPath = path.join(GLOBAL_LISTS_DIR, src);
            const dstPath = path.join(GLOBAL_LISTS_DIR, dst);
            if (fs.existsSync(srcPath)) {
                const srcContent = fs.readFileSync(srcPath, 'utf-8').trim();
                const dstContent = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, 'utf-8').trim() : '';

                if (srcContent && !dstContent) {
                    fs.writeFileSync(dstPath, srcContent + '\n', 'utf-8');
                    console.log(`[MIGRATE] Preserved content from ${src} into ${dst}`);
                }
            }
        });
        fs.writeFileSync(MIGRATION_FLAG, new Date().toISOString(), 'utf-8');
    } catch (e) {
        console.warn('[MIGRATE] Migration warning:', e.message);
    }
}

let mainWindow;
let trayWindow = null;
let activeProcess = null;
let tray;
let isQuitting = false;

// ─── Robust icon path lookup (used both for window and tray) ───
function getIconPath() {
    const pathsToTry = [
        // Unpacked assets (packaged build, see asarUnpack in package.json)
        path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png'),
        // Generic resourcesPath fallbacks
        path.join(process.resourcesPath, 'assets', 'icon.png'),
        path.join(process.resourcesPath, 'icon.png'),
        // Inside-asar / dev run
        path.join(app.getAppPath(), 'assets', 'icon.png'),
        path.join(__dirname, '..', 'assets', 'icon.png')
    ];
    for (const p of pathsToTry) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

function createWindow() {
    const iconPath = getIconPath();
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        backgroundColor: '#0c0e14',
        icon: iconPath || undefined,
        frame: false,
    });

    const isHidden = process.argv.includes('--hidden');

    const indexPath = path.join(__dirname, 'ui/index.html');
    mainWindow.loadFile(indexPath).catch(err => {
        console.error('Failed to load local file:', err);
    });

    if (isHidden) {
        mainWindow.hide();
    } else {
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
        });
    }

    // Bypass LocalTunnel warning page for WebSockets
    session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ['wss://*.loca.lt/*', 'https://*.loca.lt/*'] },
        (details, callback) => {
            details.requestHeaders['Bypass-Tunnel-Reminder'] = 'true';
            details.requestHeaders['User-Agent'] = 'localtunnel';
            callback({ requestHeaders: details.requestHeaders });
        }
    );

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.webContents.send('show-close-dialog');
        } else {
            // Ensure alles is killed before final exit
            killActiveProcess();
            cleanupZapretBinariesSync();
        }
    });

    createTray();
}

function createTrayWindow() {
    if (trayWindow) return;

    trayWindow = new BrowserWindow({
        width: 200,
        height: 220,
        show: false,
        frame: false,
        fullscreenable: false,
        resizable: false,
        transparent: false,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        skipTaskbar: true,
        backgroundColor: '#1e293b'
    });

    trayWindow.loadFile(path.join(__dirname, 'tray-window.html'));

    // Hide the window when it loses focus
    trayWindow.on('blur', () => {
        trayWindow.hide();
    });
}

function toggleTrayWindow() {
    if (!trayWindow) createTrayWindow();

    if (trayWindow.isVisible()) {
        trayWindow.hide();
    } else {
        const trayBounds = tray.getBounds();
        const windowBounds = trayWindow.getBounds();

        let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
        let y = Math.round(trayBounds.y - windowBounds.height);
        if (x < 0) x = 0;

        trayWindow.setPosition(x, y, false);
        trayWindow.show();
        trayWindow.focus();

        // Send current status and theme to tray
        updateTrayStatus();
        // Theme is stored in localStorage of mainWindow — read from it via executeJavaScript
        if (mainWindow) {
            mainWindow.webContents.executeJavaScript(`localStorage.getItem('zapret-theme') || 'dark'`)
                .then(theme => {
                    if (trayWindow) trayWindow.webContents.send('update-theme', theme);
                }).catch(() => { });
        }
    }
}

function updateTrayStatus() {
    if (trayWindow) {
        trayWindow.webContents.send('update-status', {
            running: runningStrategyName
        });
    }
    applyTrayState(!!runningStrategyName);
}

let runningStrategyName = null; // Track name for tray
let cachedTrayBase = null;

function getTrayBaseImage() {
    if (cachedTrayBase) return cachedTrayBase;
    const iconPath = getIconPath();
    if (!iconPath) return null;
    cachedTrayBase = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    return cachedTrayBase;
}

// Generate a small overlay badge (filled circle, green=running, gray=idle).
// Used for Tray.setImage (composited with base) and BrowserWindow.setOverlayIcon.
function makeStatusBadge(active, size = 16) {
    const buf = Buffer.alloc(size * size * 4);
    const [r, g, b] = active ? [74, 222, 128] : [100, 100, 100];
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const radius = (size / 2) - 1;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - cx, y - cy);
            const i = (y * size + x) * 4;
            if (d <= radius) {
                // BGRA on Windows
                buf[i] = b; buf[i+1] = g; buf[i+2] = r; buf[i+3] = 255;
            } else if (d <= radius + 1) {
                const alpha = Math.round(255 * (radius + 1 - d));
                buf[i] = b; buf[i+1] = g; buf[i+2] = r; buf[i+3] = alpha;
            } else {
                buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 0;
            }
        }
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function applyTrayState(running) {
    if (tray) {
        // Use icon-active.png / icon-idle.png if user dropped them into assets/, else use the shared base
        const stateFile = running ? 'icon-active.png' : 'icon-idle.png';
        const tryPaths = [
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', stateFile),
            path.join(__dirname, '..', 'assets', stateFile),
            path.join(app.getAppPath(), 'assets', stateFile)
        ];
        let img = null;
        for (const p of tryPaths) {
            if (fs.existsSync(p)) { img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 }); break; }
        }
        if (!img) img = getTrayBaseImage();
        if (img) tray.setImage(img);
        const stratLabel = runningStrategyName ? runningStrategyName.replace(/\.bat$/i, '') : '';
        tray.setToolTip(running
            ? `Zapret GUI • Подключено${stratLabel ? ': ' + stratLabel : ''}`
            : 'Zapret GUI • Отключено');
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.setOverlayIcon(running ? makeStatusBadge(true) : null, running ? 'Active' : '');
        } catch (e) {
            // setOverlayIcon may fail on some Windows configurations; non-fatal
        }
    }
}

function createTray() {
    try {
        if (tray) return;

        const baseImage = getTrayBaseImage();
        if (!baseImage) {
            console.warn('[TRAY] Icon not found in any expected location');
            return;
        }

        tray = new Tray(baseImage);
        tray.setToolTip('Zapret GUI');
        applyTrayState(false);

        tray.on('click', () => {
            toggleTrayWindow();
        });

        tray.on('right-click', () => {
            toggleTrayWindow();
        });

        tray.on('double-click', () => {
            mainWindow.show();
            mainWindow.focus();
        });
    } catch (e) {
        console.error('[TRAY] Failed to create tray:', e);
    }
}

app.whenReady().then(() => {
    // Ensures the taskbar groups by our AppUserModelID and shows the right icon on Windows
    if (process.platform === 'win32') {
        try { app.setAppUserModelId('com.murzikov.zapretgui'); } catch (e) {}
    }
    createWindow();
    cleanupStaleDevAutostartEntries();
    selfHealAutostart();

    // Global hotkey: Ctrl+Shift+Z toggles bypass even when window is hidden in tray
    try {
        const ok = globalShortcut.register('Control+Shift+Z', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('global-hotkey-toggle');
            }
        });
        console.log('[HOTKEY] Ctrl+Shift+Z registered:', ok);
    } catch (e) {
        console.warn('[HOTKEY] register failed:', e.message);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (e) {}
});

app.on('window-all-closed', () => {
    killActiveProcess();
    if (process.platform !== 'darwin') app.quit();
});

function killActiveProcess() {
    if (activeProcess) {
        console.log(`Killing process ${activeProcess.pid}`);
        try {
            execSync(`taskkill /pid ${activeProcess.pid} /T /F`, { stdio: 'ignore' });
        } catch (e) {
            // Exit code 128 = process already terminated, that's fine
            if (e.status !== 128) {
                console.warn('[KILL] taskkill warning:', e.message?.split('\n')[0]);
            }
        }
        activeProcess = null;
    }
    updateTrayStatus();
}

// Tray theme sync
ipcMain.on('set-tray-theme', (event, theme) => {
    if (trayWindow) {
        trayWindow.webContents.send('update-theme', theme);
    }
});

// IPC Handlers

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Zapret Folder'
    });
    return result.filePaths[0];
});

ipcMain.handle('list-strategies', async (event, folderPath) => {
    console.log('Listing strategies in', folderPath);
    try {
        const files = fs.readdirSync(folderPath);
        const batFiles = files.filter(file =>
            file.toLowerCase().startsWith('general') &&
            file.toLowerCase().endsWith('.bat') &&
            !file.toLowerCase().includes('include')
        );
        return batFiles;
    } catch (error) {
        console.error('Error reading dir:', error);
        return [];
    }
});

function sendZapretLog(line) {
    if (!line) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('zapret-log', line);
    }
}

// ─── winws watchdog ───
// Polls every 5s while a strategy is logically "running". If none of the known
// zapret binaries are alive, the user's bypass crashed externally and we sync UI.
let winwsWatchdog = null;
const ZAPRET_BINS = ['winws.exe', 'dvtws.exe', 'nfqws.exe', 'zapret.exe'];

function isAnyZapretBinaryRunning() {
    return new Promise(resolve => {
        // /FI "IMAGENAME eq X" returns "INFO: No tasks..." with exit 0 when absent.
        // Easier: list all our names and check stdout.
        exec('tasklist /NH /FO CSV', { windowsHide: true }, (err, stdout) => {
            if (err) return resolve(true); // fail open — don't kill UI state on transient tasklist error
            const lower = stdout.toLowerCase();
            for (const bin of ZAPRET_BINS) {
                if (lower.includes(bin)) return resolve(true);
            }
            resolve(false);
        });
    });
}

function startWinwsWatchdog() {
    if (winwsWatchdog) return;
    // Grace period: winws may take a moment to appear after the .bat launches it.
    let graceTicksLeft = 3;
    winwsWatchdog = setInterval(async () => {
        if (!runningStrategyName) {
            stopWinwsWatchdog();
            return;
        }
        const alive = await isAnyZapretBinaryRunning();
        if (!alive) {
            if (graceTicksLeft-- > 0) return;
            console.log('[WATCHDOG] No zapret binaries detected — syncing UI to stopped state');
            const exitedName = runningStrategyName;
            activeProcess = null;
            runningStrategyName = null;
            updateTrayStatus();
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('zapret-exited', { code: -1, strategy: exitedName });
            }
            stopWinwsWatchdog();
        } else {
            graceTicksLeft = 3;
        }
    }, 5000);
}

function stopWinwsWatchdog() {
    if (winwsWatchdog) {
        clearInterval(winwsWatchdog);
        winwsWatchdog = null;
    }
}

function attachProcessStreams(proc, strategyFile) {
    if (!proc || !proc.stdout || !proc.stderr) return;
    let stdoutBuf = '';
    let stderrBuf = '';
    const drain = (chunk, isErr) => {
        const text = chunk.toString('utf-8');
        let buf = (isErr ? stderrBuf : stdoutBuf) + text;
        const lines = buf.split(/\r?\n/);
        const tail = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) sendZapretLog((isErr ? '! ' : '') + trimmed);
        }
        if (isErr) stderrBuf = tail; else stdoutBuf = tail;
    };
    proc.stdout.on('data', d => drain(d, false));
    proc.stderr.on('data', d => drain(d, true));
    // NOTE: deliberately no proc.on('exit') reset of runningStrategyName.
    // Flowseal's .bat strategies use `start winws.exe ...` and exit immediately,
    // leaving winws running independently. Treating .bat exit as "process died"
    // would falsely reset the UI to "disconnected" while winws is still active.
    // winws lifecycle is tracked separately by the watchdog below.
}

ipcMain.handle('start-strategy', async (event, { folderPath, strategyFile }) => {
    killActiveProcess();
    await cleanupZapretBinaries();

    const fullPath = path.join(folderPath, strategyFile);
    console.log(`Starting strategy: ${strategyFile}`);

    try {
        // Direct spawn is more reliable for tracking PID.
        // Pipe stdout/stderr so winws output reaches the in-app log.
        activeProcess = spawn('cmd.exe', ['/c', fullPath], {
            cwd: folderPath,
            detached: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        attachProcessStreams(activeProcess, strategyFile);

        console.log(`Spawned PID: ${activeProcess.pid}`);
        runningStrategyName = strategyFile;
        updateTrayStatus();
        startWinwsWatchdog();
        return { success: true, pid: activeProcess.pid };
    } catch (e) {
        console.error("Spawn error:", e);
        return { success: false, error: e.message };
    }
});

async function stopStrategyAndCleanup() {
    stopWinwsWatchdog();
    killActiveProcess();
    await cleanupZapretBinaries();
    runningStrategyName = null;
    updateTrayStatus();
}

ipcMain.handle('stop-strategy', async () => {
    await stopStrategyAndCleanup();
    return true;
});

function cleanupZapretBinariesSync() {
    try {
        execSync('taskkill /F /IM winws.exe /IM dvtws.exe /IM nfqws.exe /IM zapret.exe', { stdio: 'ignore' });
    } catch (e) { }
}

function cleanupZapretBinaries() {
    return new Promise(resolve => {
        const cmd = 'taskkill /F /IM winws.exe /IM dvtws.exe /IM nfqws.exe /IM zapret.exe';
        exec(cmd, () => resolve(true));
    });
}

// Renderer asks at boot whether any zapret binaries are already running.
// If so, UI shows a banner offering to adopt the session (mark as running) or kill it.
ipcMain.handle('detect-orphan-zapret', async () => {
    const alive = await isAnyZapretBinaryRunning();
    return { alive, hasOurProcess: !!runningStrategyName };
});

ipcMain.handle('kill-orphan-zapret', async () => {
    stopWinwsWatchdog();
    await cleanupZapretBinaries();
    runningStrategyName = null;
    activeProcess = null;
    updateTrayStatus();
    return true;
});

// Adopt a pre-existing winws session — UI labels it as running without a known strategy name.
ipcMain.handle('adopt-orphan-zapret', async () => {
    runningStrategyName = '(внешний обход)';
    updateTrayStatus();
    startWinwsWatchdog();
    return true;
});

ipcMain.handle('check-connection', async () => {
    const checkUrl = (hostname) => new Promise((resolve) => {
        const req = https.get({
            hostname: hostname,
            port: 443,
            path: '/',
            method: 'HEAD',
            timeout: 5000,
            rejectUnauthorized: false
        }, (res) => {
            console.log(`[CHECK] ${hostname}: ${res.statusCode}`);
            if (res.statusCode >= 200 && res.statusCode < 500) { // 4xx can still mean we reached the server
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('error', (e) => {
            console.log(`[CHECK] ${hostname} Error: ${e.message}`);
            resolve(false);
        });
        req.on('timeout', () => {
            console.log(`[CHECK] ${hostname} Timeout`);
            req.destroy();
            resolve(false);
        });
    });

    // Check Discord first (primary target)
    if (await checkUrl('discord.com')) return true;

    // Fallback to YouTube
    if (await checkUrl('www.youtube.com')) return true;

    return false;
});

ipcMain.handle('get-pings', async (event, targets) => {
    // Accept custom targets from the renderer, fall back to defaults
    const targetList = (Array.isArray(targets) && targets.length > 0) ? targets : [
        { name: 'YouTube', host: 'www.youtube.com' },
        { name: 'Discord', host: 'discord.com' },
        { name: 'Roblox', host: 'www.roblox.com' }
    ];

    const pingHost = (host) => new Promise((resolve) => {
        const start = process.hrtime.bigint();
        const socket = new net.Socket();
        let done = false;
        const finish = (val) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(val);
        };
        socket.setTimeout(2000);
        socket.on('connect', () => {
            const ns = Number(process.hrtime.bigint() - start);
            finish(Math.max(1, Math.round(ns / 1e6)));
        });
        socket.on('error', () => finish(null));
        socket.on('timeout', () => finish(null));
        socket.connect(443, host);
    });

    try {
        // Ping all targets in parallel — faster and the SYN handshake cost stays comparable.
        const entries = await Promise.all(targetList.map(async t => [t.name, await pingHost(t.host)]));
        const result = Object.fromEntries(entries);
        console.log('[PINGS]', entries.map(([k,v]) => `${k}: ${v}ms`).join(', '));
        return result;
    } catch (e) {
        console.error('[PING ERROR]', e);
        const empty = {};
        targetList.forEach(t => { empty[t.name] = null; });
        return empty;
    }
});

// Window Controls
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());
ipcMain.handle('window-minimize-to-tray', () => mainWindow.hide());
ipcMain.handle('app-force-quit', () => {
    isQuitting = true;
    app.quit();
});

// ─── Background image storage (on-disk, avoids localStorage quota) ───
const BG_IMAGE_DIR = path.join(app.getPath('userData'), 'bg-images');
if (!fs.existsSync(BG_IMAGE_DIR)) fs.mkdirSync(BG_IMAGE_DIR, { recursive: true });

const BG_ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const BG_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
};

function listBgFiles() {
    try {
        return fs.readdirSync(BG_IMAGE_DIR).filter(f => f.startsWith('background.'));
    } catch (e) { return []; }
}

function removeAllBgFiles() {
    for (const f of listBgFiles()) {
        try { fs.unlinkSync(path.join(BG_IMAGE_DIR, f)); } catch (e) {}
    }
}

ipcMain.handle('bg-image-save', async (event, { buffer, ext }) => {
    const safeExt = String(ext || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!BG_ALLOWED_EXTS.includes(safeExt)) return { success: false, error: 'unsupported ext' };
    removeAllBgFiles();
    const target = path.join(BG_IMAGE_DIR, `background.${safeExt}`);
    fs.writeFileSync(target, Buffer.from(buffer));
    return { success: true, ext: safeExt, bytes: buffer.byteLength || buffer.length || 0 };
});

ipcMain.handle('bg-image-load', async () => {
    const files = listBgFiles();
    if (!files.length) return null;
    const f = files[0];
    const ext = f.split('.').pop().toLowerCase();
    const mime = BG_MIME[ext] || 'application/octet-stream';
    try {
        const buf = fs.readFileSync(path.join(BG_IMAGE_DIR, f));
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
        return null;
    }
});

ipcMain.handle('bg-image-remove', async () => {
    removeAllBgFiles();
    return true;
});

// File Operations
ipcMain.handle('read-file', async (event, filePath) => {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        return null;
    }
});
ipcMain.handle('save-file', async (event, { filePath, content }) => {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
});

// Autostart
const AUTOSTART_SETTINGS_PATH = path.join(app.getPath('userData'), 'autostart_settings.json');

function readAutostartPrefs() {
    try {
        if (fs.existsSync(AUTOSTART_SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(AUTOSTART_SETTINGS_PATH, 'utf-8')) || {};
        }
    } catch (e) {}
    return {};
}

function applyAutostart(enable, minimizeOnStart) {
    // In dev mode, refuse to register autostart — it would point to node_modules/electron.exe
    if (!app.isPackaged) {
        console.warn('[AUTOSTART] Skipped: dev mode (run packaged build to test autostart)');
        // Clear any stale entry left over from a previous packaged install
        app.setLoginItemSettings({ openAtLogin: false });
        return false;
    }
    const args = [];
    if (minimizeOnStart) args.push('--hidden');
    app.setLoginItemSettings({
        openAtLogin: !!enable,
        path: process.execPath,
        args
    });
    return !!enable;
}

ipcMain.handle('toggle-autostart', (event, { enable, minimizeOnStart }) => {
    const actual = applyAutostart(enable, minimizeOnStart);
    fs.writeFileSync(AUTOSTART_SETTINGS_PATH, JSON.stringify({ enable: actual, minimizeOnStart: !!minimizeOnStart }));
    return actual;
});

// Self-heal: on every packaged launch, re-write login item with current exe path.
// This fixes the case where autostart was set up from a previous install or dev run
// and now points to a stale electron.exe / old location.
function selfHealAutostart() {
    if (!app.isPackaged) return;
    const prefs = readAutostartPrefs();
    if (!prefs.enable) return;
    applyAutostart(true, !!prefs.minimizeOnStart);
    console.log('[AUTOSTART] Refreshed login item path to', process.execPath);
}

// Scan HKCU\...\Run for any entry that points to a `node_modules\electron\dist\electron.exe`
// (a leftover from old dev runs that registered autostart). Such entries open the bare
// Electron welcome screen on boot. Removing them is always safe — real installed apps
// never live inside node_modules.
function cleanupStaleDevAutostartEntries() {
    if (process.platform !== 'win32') return;
    try {
        const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
            // Format: "    <Name>    REG_SZ    <Value>"
            const m = line.match(/^\s+(\S.*?\S)\s+REG_SZ\s+(.+)$/);
            if (!m) continue;
            const [, name, value] = m;
            if (/node_modules\\electron\\dist\\electron\.exe/i.test(value)) {
                console.log('[AUTOSTART] Removing stale dev entry:', name, '→', value.trim());
                try {
                    execFile('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name, '/f'], { windowsHide: true });
                } catch (e) {
                    console.warn('[AUTOSTART] failed to remove:', name, e.message);
                }
            }
        }
    } catch (e) {
        // Reg query failed (e.g. no entries) — non-fatal
    }
}

ipcMain.handle('check-autostart', () => {
    const prefs = readAutostartPrefs();
    return {
        enable: app.getLoginItemSettings().openAtLogin,
        minimizeOnStart: !!prefs.minimizeOnStart
    };
});

// --- VPN REMOVED ---

// --- Version Check & Download ---

ipcMain.handle('check-zapret-version', async () => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/Flowseal/zapret-discord-youtube/releases',
            headers: { 'User-Agent': 'ZapretGUI-App' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const releases = JSON.parse(data);
                    const filtered = (Array.isArray(releases) ? releases : [releases]).map(r => ({
                        version: r.tag_name || r.name,
                        name: r.name,
                        url: r.zipball_url,
                        published_at: r.published_at,
                        body: r.body
                    }));
                    resolve({ success: true, releases: filtered });
                } catch (e) { resolve({ success: false, error: 'Failed to parse GitHub response' }); }
            });
        }).on('error', (e) => resolve({ success: false, error: e.message }));
    });
});

ipcMain.handle('download-install-zapret', async (event, { url, version }) => {
    return new Promise((resolve) => {
        try {
            console.log(`[DOWNLOAD] Starting download for ${version}...`);
            const versionDir = path.join(VERSIONS_DIR, version);
            if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

            const tempZip = path.join(app.getPath('temp'), `zapret_${version}.zip`);
            const file = fs.createWriteStream(tempZip);

            const handleResponse = (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    https.get(response.headers.location, { headers: { 'User-Agent': 'ZapretGUI-App' } }, handleResponse);
                    return;
                }

                const totalBytes = parseInt(response.headers['content-length'], 10);
                let downloadedBytes = 0;

                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 50;
                    mainWindow.webContents.send('download-progress', {
                        percent,
                        text: `Загрузка: ${Math.round(downloadedBytes / 1024 / 1024 * 10) / 10}MB${totalBytes ? " / " + Math.round(totalBytes / 1024 / 1024 * 10) / 10 + "MB" : ""}`
                    });
                });

                response.pipe(file);

                file.on('finish', async () => {
                    file.close();
                    mainWindow.webContents.send('download-progress', { percent: 90, text: 'Распаковка...' });

                    const tempExtractDir = path.join(app.getPath('temp'), `zapret_ext_${version}`);
                    if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
                    fs.mkdirSync(tempExtractDir, { recursive: true });

                    const psExtract = `powershell -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${tempExtractDir}' -Force"`;
                    exec(psExtract, (err) => {
                        if (err) return resolve({ success: false, error: 'Ошибка распаковки' });

                        mainWindow.webContents.send('download-progress', { percent: 95, text: 'Установка...' });
                        const innerFiles = fs.readdirSync(tempExtractDir);
                        const sourcePath = innerFiles.length === 1 ? path.join(tempExtractDir, innerFiles[0]) : tempExtractDir;

                        exec(`xcopy "${sourcePath}" "${versionDir}" /E /I /Y`, (copyErr) => {
                            if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
                            if (copyErr) resolve({ success: false, error: 'Ошибка переноса файлов' });
                            else {
                                // Disable auto-updater which opens the browser
                                const checkUpdatesFile = path.join(versionDir, 'utils', 'check_updates.enabled');
                                if (fs.existsSync(checkUpdatesFile)) {
                                    try { fs.unlinkSync(checkUpdatesFile); } catch (e) { }
                                }
                                resolve({ success: true, path: versionDir, version });
                            }
                        });
                    });
                });
            };

            https.get(url, { headers: { 'User-Agent': 'ZapretGUI-App' } }, handleResponse).on('error', (e) => {
                resolve({ success: false, error: e.message });
            });
        } catch (e) {
            resolve({ success: false, error: e.message });
        }
    });
});

ipcMain.handle('get-local-version', async (event, folderPath) => {
    try {
        if (!folderPath) {
            console.error('[VERSION] No folder path provided');
            return 'No Path';
        }

        const newsPath = path.join(folderPath, 'docs', 'news.txt');
        console.log('[VERSION] Checking folder:', folderPath);
        console.log('[VERSION] Looking for news.txt at:', newsPath);

        if (fs.existsSync(newsPath)) {
            const content = fs.readFileSync(newsPath, 'utf-8').split('\n')[0];
            const match = content.match(/v?(\d+(\.\d+)*)/i);
            if (match) {
                const ver = 'v' + match[1].replace('v', '');
                console.log('[VERSION] Found local version:', ver);
                return ver;
            }
            return content.trim().substring(0, 10);
        } else {
            console.warn('[VERSION] news.txt not found in', folderPath);
            return 'v0 (No news.txt)';
        }
    } catch (e) {
        console.error('[VERSION] Error:', e);
        return 'Error';
    }
});

ipcMain.handle('check-default-path', async () => {
    const defaultPath = path.join(path.dirname(app.getPath('exe')), 'zapret');
    if (fs.existsSync(defaultPath)) return defaultPath;
    return null;
});

ipcMain.handle('list-installed-versions', async () => {
    try {
        if (!fs.existsSync(VERSIONS_DIR)) return [];
        const dirs = fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => ({
                id: d.name,
                path: path.join(VERSIONS_DIR, d.name)
            }));
        return dirs;
    } catch (e) {
        return [];
    }
});

// Maintenance Commands
ipcMain.handle('update-ipset', async (event, folderPath) => {
    return new Promise((resolve) => {
        const scriptPath = path.join(folderPath, 'ipset', 'get_config.cmd');
        if (fs.existsSync(scriptPath)) {
            // Run as Admin to ensure it can write to program files / protected folders
            execFile('powershell.exe', [
                '-NoProfile',
                'Start-Process', '-FilePath', scriptPath, '-Verb', 'RunAs', '-Wait'
            ], { cwd: folderPath, windowsHide: true }, (err) => {
                resolve({ success: !err, error: err?.message });
            });
            return;
        }

        // Try Flowseal method
        const listFile = path.join(folderPath, 'lists', 'ipset-all.txt');
        const url = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/ipset-service.txt';
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content | Out-File -FilePath $env:ZAPRET_LIST_FILE -Encoding UTF8`
        ], { env: { ...process.env, ZAPRET_LIST_FILE: listFile }, windowsHide: true }, (err) => {
            resolve({ success: !err, error: err?.message });
        });
    });
});

ipcMain.handle('update-hosts', async (event, folderPath) => {
    return new Promise((resolve) => {
        const scriptPath = path.join(folderPath, 'ipset', 'get_hostlist.cmd');
        if (fs.existsSync(scriptPath)) {
            execFile('powershell.exe', [
                '-NoProfile',
                'Start-Process', '-FilePath', scriptPath, '-Verb', 'RunAs', '-Wait'
            ], { cwd: folderPath, windowsHide: true }, (err) => {
                resolve({ success: !err, error: err?.message });
            });
            return;
        }

        const url = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/hosts';
        const tempFile = path.join(app.getPath('temp'), 'zapret_hosts.txt');
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content | Out-File -FilePath $env:ZAPRET_TEMP_FILE -Encoding UTF8`
        ], { env: { ...process.env, ZAPRET_TEMP_FILE: tempFile }, windowsHide: true }, (err) => {
            if (err) return resolve({ success: false, error: 'Ошибка загрузки hosts файла' });
            // open downloaded file in Notepad, no shell needed
            execFile('notepad.exe', [tempFile], { windowsHide: false });
            const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
            execFile('explorer.exe', ['/select,', hostsPath], { windowsHide: false });
            resolve({ success: true });
        });
    });
});

function spawnDetached(cmd, args, cwd) {
    // Spawn a visible console window detached from this process — used for diagnostics/test scripts
    spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

ipcMain.handle('run-diagnostics', async (event, folderPath) => {
    const psScript = path.join(folderPath, 'utils', 'test zapret.ps1');
    const blockcheck = path.join(folderPath, 'blockcheck.cmd');
    if (fs.existsSync(psScript)) {
        spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript], folderPath);
        return { success: true };
    } else if (fs.existsSync(blockcheck)) {
        spawnDetached('cmd.exe', ['/k', blockcheck], folderPath);
        return { success: true };
    }
    return { success: false, error: 'Скрипт диагностики не найден' };
});

ipcMain.handle('run-tests', async (event, folderPath) => {
    const psScript = path.join(folderPath, 'utils', 'test zapret.ps1');
    const cmdScript = path.join(folderPath, 'test.cmd');
    if (fs.existsSync(psScript)) {
        spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript], folderPath);
        return { success: true };
    } else if (fs.existsSync(cmdScript)) {
        spawnDetached('cmd.exe', ['/k', cmdScript], folderPath);
        return { success: true };
    }
    return { success: false, error: 'Скрипт тестирования не найден' };
});

// Domain List Management

// Flowseal uses 4 list files:
// list-general.txt        - system bypass list (usually empty, auto-managed)
// list-general-user.txt   - USER's custom bypass domains (editable)
// list-exclude.txt        - system exclude list
// list-exclude-user.txt   - USER's custom exclude domains (editable)
const UI_LIST_NAMES = {
    'Обход (свои домены)': 'list-general-user.txt',
    'Исключения (свои домены)': 'list-exclude-user.txt',
    'Обход (системный)': 'list-general.txt',
    'Исключения (системные)': 'list-exclude.txt',
};

ipcMain.handle('get-lists', async (event, folderPath) => {
    // Return only the two essential lists with user-friendly names
    return Object.keys(UI_LIST_NAMES);
});

ipcMain.handle('read-list', async (event, { folderPath, filename }) => {
    const actualFilename = UI_LIST_NAMES[filename] || filename;

    // Priority: lists/ subfolder in active version, then global cache
    if (folderPath && fs.existsSync(folderPath)) {
        const listsPath = path.join(folderPath, 'lists', actualFilename);
        if (fs.existsSync(listsPath)) {
            try { return fs.readFileSync(listsPath, 'utf-8'); } catch (e) { }
        }
        // Also check folder root (some older versions)
        const rootPath = path.join(folderPath, actualFilename);
        if (fs.existsSync(rootPath)) {
            try { return fs.readFileSync(rootPath, 'utf-8'); } catch (e) { }
        }
    }

    // Fallback: global cache
    const globalFilePath = path.join(GLOBAL_LISTS_DIR, actualFilename);
    try {
        if (!fs.existsSync(globalFilePath)) return '';
        return fs.readFileSync(globalFilePath, 'utf-8');
    } catch (e) { return ''; }
});

ipcMain.handle('save-list', async (event, { folderPath, filename, content }) => {
    const actualFilename = UI_LIST_NAMES[filename] || filename;
    try {
        // Save to lists/ subfolder in active version folder (primary target)
        if (folderPath && fs.existsSync(folderPath)) {
            const listsDir = path.join(folderPath, 'lists');
            if (!fs.existsSync(listsDir)) fs.mkdirSync(listsDir, { recursive: true });
            const targetPath = path.join(listsDir, actualFilename);
            fs.writeFileSync(targetPath, content, 'utf-8');
            console.log(`[SAVE] Saved to: ${targetPath}`);
        }

        // Also update global cache
        const globalFilePath = path.join(GLOBAL_LISTS_DIR, actualFilename);
        fs.writeFileSync(globalFilePath, content, 'utf-8');

        // Auto-restart bypass if currently running
        if (activeProcess && runningStrategyName) {
            console.log(`[SAVE] Restarting strategy ${runningStrategyName} to apply changes`);
            const _folder = folderPath;
            const _strategy = runningStrategyName;
            killActiveProcess();
            await cleanupZapretBinaries();
            setTimeout(() => {
                activeProcess = spawn('cmd.exe', ['/c', path.join(_folder, _strategy)], {
                    cwd: _folder, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
                });
                attachProcessStreams(activeProcess, _strategy);
                runningStrategyName = _strategy;
                updateTrayStatus();
            }, 1000);
        }

        return true;
    } catch (e) {
        console.error('[SAVE ERROR]', e);
        return false;
    }
});

// Service Management
ipcMain.handle('install-service', async (event, folderPath) => {
    const serviceScript = path.join(folderPath, 'service_install.bat');
    const serviceBat = path.join(folderPath, 'service.bat');
    if (fs.existsSync(serviceScript)) { spawnDetached('cmd.exe', ['/k', serviceScript], folderPath); return true; }
    if (fs.existsSync(serviceBat))    { spawnDetached('cmd.exe', ['/k', serviceBat], folderPath);    return true; }
    return false;
});

ipcMain.handle('remove-service', async (event, folderPath) => {
    const removeScript = path.join(folderPath, 'service_remove.bat');
    const serviceBat = path.join(folderPath, 'service.bat');
    if (fs.existsSync(removeScript)) { spawnDetached('cmd.exe', ['/k', removeScript], folderPath); return true; }
    if (fs.existsSync(serviceBat))   { spawnDetached('cmd.exe', ['/k', serviceBat], folderPath);   return true; }
    return false;
});

ipcMain.handle('check-service-status', async (event, folderPath) => {
    return new Promise((resolve) => {
        exec('sc query zapret', (err, stdout) => {
            const installed = !stdout.includes('1060'); // 1060 = service not installed
            const running = stdout.includes('RUNNING');
            resolve({ installed, running });
        });
    });
});

ipcMain.handle('get-service-config', async (event, folderPath) => {
    const config = {};
    const gameFlagPath = path.join(folderPath, 'utils', 'game_filter.enabled');
    const autoFlagPath = path.join(folderPath, 'utils', 'check_updates.enabled');
    const ipsetPath = path.join(folderPath, 'lists', 'ipset-all.txt');

    if (fs.existsSync(gameFlagPath)) {
        try {
            const mode = fs.readFileSync(gameFlagPath, 'utf-8').trim().toLowerCase();
            if (mode === 'tcp') config.GAME_FILTER = 'tcp';
            else if (mode === 'udp') config.GAME_FILTER = 'udp';
            else config.GAME_FILTER = 'all'; // 'all' or anything else
        } catch (e) { config.GAME_FILTER = 'all'; }
    } else {
        config.GAME_FILTER = 'disabled';
    }

    config.AUTO_UPDATE = fs.existsSync(autoFlagPath) ? 'enabled' : 'disabled';

    if (fs.existsSync(ipsetPath)) {
        const content = fs.readFileSync(ipsetPath, 'utf-8').trim();
        if (content === '') config.IPSET_FILTER = 'any';
        else if (content.includes('203.0.113.113')) config.IPSET_FILTER = 'none';
        else config.IPSET_FILTER = 'loaded';
    } else {
        config.IPSET_FILTER = 'none';
    }
    return config;
});

ipcMain.handle('update-service-config', async (event, { folderPath, config }) => {
    try {
        const utilsDir = path.join(folderPath, 'utils');
        const listsDir = path.join(folderPath, 'lists');
        if (!fs.existsSync(utilsDir)) fs.mkdirSync(utilsDir, { recursive: true });
        if (!fs.existsSync(listsDir)) fs.mkdirSync(listsDir, { recursive: true });

        if ('GAME_FILTER' in config) {
            const flag = path.join(utilsDir, 'game_filter.enabled');
            if (config.GAME_FILTER === 'disabled') {
                if (fs.existsSync(flag)) fs.unlinkSync(flag);
            } else {
                // Write mode: all, tcp, udp
                fs.writeFileSync(flag, config.GAME_FILTER + '\n', 'utf-8');
            }
        }
        if ('AUTO_UPDATE' in config) {
            const flag = path.join(utilsDir, 'check_updates.enabled');
            if (config.AUTO_UPDATE === 'enabled') {
                fs.writeFileSync(flag, 'ENABLED\n', 'utf-8');
            } else {
                if (fs.existsSync(flag)) fs.unlinkSync(flag);
            }
        }
        if ('IPSET_FILTER' in config) {
            const listFile = path.join(listsDir, 'ipset-all.txt');
            if (config.IPSET_FILTER === 'none') {
                fs.writeFileSync(listFile, '203.0.113.113/32\n', 'utf-8');
            } else if (config.IPSET_FILTER === 'any') {
                fs.writeFileSync(listFile, '', 'utf-8');
            }
        }
        return true;
    } catch (e) { return false; }
});




ipcMain.handle('get-versions-root', () => VERSIONS_DIR);

ipcMain.on('tray-action', (event, action) => {
    switch (action) {
        case 'request-status':
            updateTrayStatus();
            break;
        case 'show':
            mainWindow.show();
            mainWindow.focus();
            if (trayWindow) trayWindow.hide();
            break;
        case 'start':
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('tray-start-strategy');
            if (trayWindow) trayWindow.hide();
            break;
        case 'stop':
            stopStrategyAndCleanup();
            if (mainWindow) mainWindow.webContents.send('tray-stop-strategy');
            updateTrayStatus();
            break;
        case 'quit':
            isQuitting = true;
            app.quit();
            break;
    }
});
