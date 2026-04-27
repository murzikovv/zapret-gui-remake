const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Basic
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    listStrategies: (path) => ipcRenderer.invoke('list-strategies', path),
    startStrategy: (folderPath, strategyFile) => ipcRenderer.invoke('start-strategy', { folderPath, strategyFile }),
    stopStrategy: () => ipcRenderer.invoke('stop-strategy'),
    checkConnection: () => ipcRenderer.invoke('check-connection'),

    // System
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    minimizeToTray: () => ipcRenderer.invoke('window-minimize-to-tray'),
    forceQuit: () => ipcRenderer.invoke('app-force-quit'),
    onShowCloseDialog: (callback) => ipcRenderer.on('show-close-dialog', callback),
    onTrayStartStrategy: (callback) => ipcRenderer.on('tray-start-strategy', callback),
    toggleAutostart: (enable) => ipcRenderer.invoke('toggle-autostart', enable),
    checkAutostart: () => ipcRenderer.invoke('check-autostart'),

    // Files
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('save-file', { filePath, content }),

    // VPN Removed

    // Download & Install
    checkZapretVersion: () => ipcRenderer.invoke('check-zapret-version'),
    getLocalVersion: (folderPath) => ipcRenderer.invoke('get-local-version', folderPath),
    checkDefaultPath: () => ipcRenderer.invoke('check-default-path'),
    downloadInstallZapret: (data) => ipcRenderer.invoke('download-install-zapret', data),
    listInstalledVersions: () => ipcRenderer.invoke('list-installed-versions'),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, value) => callback(value)),

    // Manager
    getLists: (folderPath) => ipcRenderer.invoke('get-lists', folderPath),
    readList: (folderPath, filename) => ipcRenderer.invoke('read-list', { folderPath, filename }),
    saveList: (folderPath, filename, content) => ipcRenderer.invoke('save-list', { folderPath, filename, content }),
    installService: (folderPath) => ipcRenderer.invoke('install-service', folderPath),
    removeService: (folderPath) => ipcRenderer.invoke('remove-service', folderPath),
    checkServiceStatus: (folderPath) => ipcRenderer.invoke('check-service-status', folderPath),
    getServiceConfig: (folderPath) => ipcRenderer.invoke('get-service-config', folderPath),
    updateServiceConfig: (folderPath, config) => ipcRenderer.invoke('update-service-config', { folderPath, config }),
    updateIpset: (folderPath) => ipcRenderer.invoke('update-ipset', folderPath),
    updateHosts: (folderPath) => ipcRenderer.invoke('update-hosts', folderPath),
    runDiagnostics: (folderPath) => ipcRenderer.invoke('run-diagnostics', folderPath),
    runTests: (folderPath) => ipcRenderer.invoke('run-tests', folderPath),
    getPings: () => ipcRenderer.invoke('get-pings'),
    setTrayTheme: (theme) => ipcRenderer.send('set-tray-theme', theme),

    // App Updates
    checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
    downloadAppUpdate: (url) => ipcRenderer.invoke('download-app-update', url),
});
