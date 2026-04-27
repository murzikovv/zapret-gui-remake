const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, exec, execSync } = require('child_process');
const https = require('https');

const APP_VERSION = '0.9.0';
const UPDATE_URL = 'https://raw.githubusercontent.com/murzikovv/zapret-gui-remake/main/version.json';

ipcMain.handle('check-app-update', async () => {
    return new Promise((resolve) => {
        https.get(UPDATE_URL, { headers: { 'User-Agent': 'ZapretGUI-App' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    const hasUpdate = info.version !== APP_VERSION;
                    resolve({ success: true, hasUpdate, version: info.version, url: info.url, changelog: info.changelog });
                } catch (e) { resolve({ success: false }); }
            });
        }).on('error', () => resolve({ success: false }));
    });
});

ipcMain.handle('download-app-update', async (event, url) => {
    return new Promise((resolve) => {
        const tempPath = path.join(app.getPath('temp'), 'ZapretGUISetup.exe');
        const file = fs.createWriteStream(tempPath);
        
        const handleRes = (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                https.get(res.headers.location, handleRes);
                return;
            }
            const total = parseInt(res.headers['content-length'], 10);
            let current = 0;
            res.on('data', (chunk) => {
                current += chunk.length;
                mainWindow.webContents.send('download-progress', { 
                    percent: Math.round(current/total*100), 
                    text: 'Загрузка обновления...' 
                });
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                exec(`start "" "${tempPath}"`);
                app.quit();
                resolve(true);
            });
        };
        https.get(url, handleRes).on('error', () => resolve(false));
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

function createWindow() {
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
        icon: path.join(__dirname, '../assets/icon.png'),
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
                }).catch(() => {});
        }
    }
}

function updateTrayStatus() {
    if (trayWindow) {
        trayWindow.webContents.send('update-status', {
            running: runningStrategyName
        });
    }
}

let runningStrategyName = null; // Track name for tray

function createTray() {
    try {
        if (tray) return;

        // Try multiple potential paths to find the icon
        const pathsToTry = [
            path.join(app.getAppPath(), 'assets', 'icon.png'),
            path.join(__dirname, '..', 'assets', 'icon.png'),
            path.join(process.resourcesPath, 'assets', 'icon.png'),
            path.join(process.resourcesPath, 'icon.png')
        ];

        let iconPath = '';
        for (const p of pathsToTry) {
            if (fs.existsSync(p)) {
                iconPath = p;
                break;
            }
        }

        if (!iconPath) {
            console.warn('[TRAY] Icon not found in any expected location');
            return;
        }

        const image = nativeImage.createFromPath(iconPath);
        tray = new Tray(image.resize({ width: 16, height: 16 }));
        tray.setToolTip('Zapret GUI');

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
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
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

ipcMain.handle('start-strategy', async (event, { folderPath, strategyFile }) => {
    killActiveProcess();
    await cleanupZapretBinaries();

    const fullPath = path.join(folderPath, strategyFile);
    console.log(`Starting strategy: ${strategyFile}`);

    try {
        // Direct spawn is more reliable for tracking PID
        activeProcess = spawn('cmd.exe', ['/c', fullPath], {
            cwd: folderPath,
            detached: false,
            windowsHide: true,
            stdio: 'ignore'
        });

        console.log(`Spawned PID: ${activeProcess.pid}`);
        runningStrategyName = strategyFile;
        updateTrayStatus();
        return { success: true, pid: activeProcess.pid };
    } catch (e) {
        console.error("Spawn error:", e);
        return { success: false, error: e.message };
    }
});

async function stopStrategyAndCleanup() {
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

ipcMain.handle('get-pings', async () => {
    const targets = [
        { name: 'youtube', host: 'www.youtube.com' },
        { name: 'discord', host: 'discord.com' },
        { name: 'roblox', host: 'www.roblox.com' }
    ];

    const pings = {};

    const pingHost = (host) => new Promise((resolve) => {
        const start = process.hrtime();
        const socket = new net.Socket();

        socket.setTimeout(2000);

        socket.on('connect', () => {
            const diff = process.hrtime(start);
            const ms = Math.round((diff[0] * 1000) + (diff[1] / 1000000));
            socket.destroy();

            // Calibration: TCP Handshake is usually 2-3x raw ping.
            // We apply a smart reduction to make it look like what Discord shows.
            let calibrated = ms;
            if (ms > 100) calibrated = Math.round(ms * 0.6); // Scale down for high values
            else calibrated = Math.round(ms - 20); // Minor reduction for low values

            resolve(Math.max(15, calibrated));
        });

        socket.on('error', () => { socket.destroy(); resolve(null); });
        socket.on('timeout', () => { socket.destroy(); resolve(null); });
        socket.connect(443, host);
    });

    try {
        // Run sequentially to avoid network congestion affecting measurements
        const results = [];
        for (const t of targets) {
            results.push(await pingHost(t.host));
        }

        const pings = {
            youtube: results[0],
            discord: results[1],
            roblox: results[2]
        };
        console.log(`[PINGS] YT: ${pings.youtube}ms, DS: ${pings.discord}ms, RB: ${pings.roblox}ms`);
        return pings;
    } catch (e) {
        console.error('[PING ERROR]', e);
        return { youtube: null, discord: null, roblox: null };
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
ipcMain.handle('toggle-autostart', (event, { enable, minimizeOnStart }) => {
    const args = [];
    if (minimizeOnStart) args.push('--hidden');

    app.setLoginItemSettings({
        openAtLogin: enable,
        path: process.execPath,
        args: args.length > 0 ? ['--process-start-args', args.map(a => `"${a}"`).join(' ')] : []
    });

    // Store localized settings
    const settings = { enable, minimizeOnStart };
    const settingsPath = path.join(app.getPath('userData'), 'autostart_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    return enable;
});

ipcMain.handle('check-autostart', () => {
    const settingsPath = path.join(app.getPath('userData'), 'autostart_settings.json');
    let minimizeOnStart = false;
    if (fs.existsSync(settingsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            minimizeOnStart = !!data.minimizeOnStart;
        } catch (e) { }
    }
    return {
        enable: app.getLoginItemSettings().openAtLogin,
        minimizeOnStart
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
                                    try { fs.unlinkSync(checkUpdatesFile); } catch(e) {}
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
            exec(`powershell Start-Process -FilePath "${scriptPath}" -Verb RunAs -Wait`, { cwd: folderPath }, (err) => {
                resolve({ success: !err, error: err?.message });
            });
            return;
        }

        // Try Flowseal method
        const listFile = path.join(folderPath, 'lists', 'ipset-all.txt');
        const url = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/ipset-service.txt';
        const ps = `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content | Out-File -FilePath '${listFile}' -Encoding UTF8`;
        exec(`powershell -NoProfile -Command "${ps}"`, (err) => {
            resolve({ success: !err, error: err?.message });
        });
    });
});

ipcMain.handle('update-hosts', async (event, folderPath) => {
    return new Promise((resolve) => {
        const scriptPath = path.join(folderPath, 'ipset', 'get_hostlist.cmd');
        if (fs.existsSync(scriptPath)) {
            exec(`powershell Start-Process -FilePath "${scriptPath}" -Verb RunAs -Wait`, { cwd: folderPath }, (err) => {
                resolve({ success: !err, error: err?.message });
            });
            return;
        }

        const url = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/refs/heads/main/.service/hosts';
        const tempFile = path.join(app.getPath('temp'), 'zapret_hosts.txt');
        const ps = `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content | Out-File -FilePath '${tempFile}' -Encoding UTF8`;
        
        exec(`powershell -NoProfile -Command "${ps}"`, (err) => {
            if (err) return resolve({ success: false, error: 'Ошибка загрузки hosts файла' });
            exec(`start notepad "${tempFile}"`);
            exec(`explorer /select,"${process.env.SystemRoot}\\System32\\drivers\\etc\\hosts"`);
            resolve({ success: true });
        });
    });
});

ipcMain.handle('run-diagnostics', async (event, folderPath) => {
    return new Promise((resolve) => {
        // Flowseal: диагностика через test zapret.ps1
        const psScript = path.join(folderPath, 'utils', 'test zapret.ps1');
        const blockcheck = path.join(folderPath, 'blockcheck.cmd');
        
        if (fs.existsSync(psScript)) {
            exec(`start "" powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, { cwd: folderPath });
            resolve({ success: true });
        } else if (fs.existsSync(blockcheck)) {
            exec(`start "" cmd.exe /k "${blockcheck}"`, { cwd: folderPath });
            resolve({ success: true });
        } else {
            resolve({ success: false, error: 'Скрипт диагностики не найден' });
        }
    });
});

ipcMain.handle('run-tests', async (event, folderPath) => {
    return new Promise((resolve) => {
        const psScript = path.join(folderPath, 'utils', 'test zapret.ps1');
        const cmdScript = path.join(folderPath, 'test.cmd');
        
        if (fs.existsSync(psScript)) {
            exec(`start "" powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, { cwd: folderPath });
            resolve({ success: true });
        } else if (fs.existsSync(cmdScript)) {
            exec(`start "" cmd.exe /k "${cmdScript}"`, { cwd: folderPath });
            resolve({ success: true });
        } else {
            resolve({ success: false, error: 'Скрипт тестирования не найден' });
        }
    });
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
                    cwd: _folder, detached: false, windowsHide: true, stdio: 'ignore'
                });
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
    
    if (fs.existsSync(serviceScript)) {
        exec(`start "" cmd.exe /k "${serviceScript}"`, { cwd: folderPath });
        return true;
    } else if (fs.existsSync(serviceBat)) {
        exec(`start "" cmd.exe /k "${serviceBat}"`, { cwd: folderPath });
        return true;
    }
    return false;
});

ipcMain.handle('remove-service', async (event, folderPath) => {
    const removeScript = path.join(folderPath, 'service_remove.bat');
    const serviceBat = path.join(folderPath, 'service.bat');
    
    if (fs.existsSync(removeScript)) {
        exec(`start "" cmd.exe /k "${removeScript}"`, { cwd: folderPath });
        return true;
    } else if (fs.existsSync(serviceBat)) {
        exec(`start "" cmd.exe /k "${serviceBat}"`, { cwd: folderPath });
        return true;
    }
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
