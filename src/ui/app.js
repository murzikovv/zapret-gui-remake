const api = window.electronAPI;

// State
let currentFolder = localStorage.getItem('zapret-path');
let strategies = [];
let selectedStrategy = null;
let isStrategyRunning = false;
let pingInterval = null;
let uptimeInterval = null;
let uptimeStart = null;
let currentActiveDomainTab = null;
let domainLists = [];

// DOM Elements
const el = (id) => document.getElementById(id);
const setupScreen = el('setup-screen');
const mainApp = el('main-app');

// ─── Theme System ───
const PRESET_VARS = {
    dark:     { '--bg':'#0c0e14','--bg-2':'#131620','--bg-card':'#181b25','--bg-elevated':'#1f2335','--text-1':'#e8eaf0','--text-2':'#8b90a0','--text-3':'#525666','--accent':'#5b8def','--success':'#4ade80' },
    midnight: { '--bg':'#0a0c1a','--bg-2':'#0f1228','--bg-card':'#141830','--bg-elevated':'#1e2440','--text-1':'#dde2f5','--text-2':'#7880a8','--text-3':'#424870','--accent':'#7c9ef7','--success':'#34d399' },
    slate:    { '--bg':'#0f1117','--bg-2':'#161a23','--bg-card':'#1c2130','--bg-elevated':'#242c42','--text-1':'#e2e8f0','--text-2':'#94a3b8','--text-3':'#4a5568','--accent':'#60a5fa','--success':'#4ade80' },
    mocha:    { '--bg':'#13100e','--bg-2':'#1c1714','--bg-card':'#231e1a','--bg-elevated':'#302820','--text-1':'#ede0d4','--text-2':'#9a8f86','--text-3':'#5a504a','--accent':'#e08060','--success':'#a6d189' },
};

function applyCustomVars(vars) {
    let styleEl = document.getElementById('custom-theme-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-theme-style';
        document.head.appendChild(styleEl);
    }
    const lines = Object.entries(vars).map(([k,v]) => `  ${k}: ${v};`).join('\n');
    styleEl.textContent = `[data-theme="custom"] {\n${lines}\n  --accent-dim: color-mix(in srgb, var(--accent) 12%, transparent);\n  --accent-border: color-mix(in srgb, var(--accent) 30%, transparent);\n  --success-dim: color-mix(in srgb, var(--success) 10%, transparent);\n  --bg-card-hover: color-mix(in srgb, var(--bg-card) 50%, var(--bg-elevated));\n  --border: rgba(255,255,255,0.07);\n  --border-strong: rgba(255,255,255,0.12);\n  --connect-ring: color-mix(in srgb, var(--accent) 15%, transparent);\n}`;
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('zapret-theme', theme);
    document.querySelectorAll('.theme-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.theme === theme);
    });
    if (api.setTrayTheme) api.setTrayTheme(theme);
    if (theme === 'custom') {
        // Open editor if no custom theme saved yet
        const saved = localStorage.getItem('zapret-custom-vars');
        if (saved) {
            try { applyCustomVars(JSON.parse(saved)); } catch(e) {}
        } else {
            openThemeEditor();
        }
    }
}
document.querySelectorAll('.theme-dot').forEach(dot => {
    if (dot.dataset.theme === 'custom') {
        dot.onclick = (e) => {
            e.stopPropagation();
            const current = document.documentElement.getAttribute('data-theme');
            if (current === 'custom') {
                // Already on custom — open editor
                openThemeEditor();
            } else {
                applyTheme('custom');
            }
        };
    } else {
        dot.onclick = () => applyTheme(dot.dataset.theme);
    }
});
// Load saved custom vars on boot
(function() {
    const saved = localStorage.getItem('zapret-custom-vars');
    if (saved) { try { applyCustomVars(JSON.parse(saved)); } catch(e) {} }
})();
applyTheme(localStorage.getItem('zapret-theme') || 'dark');

// ─── Custom Theme Editor ───
const EDITOR_VARS = ['--bg','--bg-2','--bg-card','--text-1','--text-2','--accent','--success'];

function openThemeEditor() {
    // Load values into pickers
    const saved = localStorage.getItem('zapret-custom-vars');
    const vars = saved ? JSON.parse(saved) : PRESET_VARS.dark;
    EDITOR_VARS.forEach(v => {
        const swatch = document.querySelector(`.cp-swatch[data-var="${v}"]`);
        const hexEl  = document.querySelector(`.cp-hex[data-hex="${v}"]`);
        const val = vars[v] || '#000000';
        if (swatch) swatch.value = val;
        if (hexEl)  hexEl.value  = val;
    });
    el('modal-theme-editor').classList.remove('hidden');
}
window.loadEditorPreset = (preset) => {
    const vars = PRESET_VARS[preset] || PRESET_VARS.dark;
    EDITOR_VARS.forEach(v => {
        const swatch = document.querySelector(`.cp-swatch[data-var="${v}"]`);
        const hexEl  = document.querySelector(`.cp-hex[data-hex="${v}"]`);
        const val = vars[v] || '#000000';
        if (swatch) swatch.value = val;
        if (hexEl)  hexEl.value  = val;
    });
    // Live preview immediately
    applyCustomVars(vars);
    document.documentElement.setAttribute('data-theme', 'custom');
};
function getEditorVars() {
    const vars = {};
    EDITOR_VARS.forEach(v => {
        const swatch = document.querySelector(`.cp-swatch[data-var="${v}"]`);
        if (swatch) vars[v] = swatch.value;
    });
    return vars;
}
// Swatch → live preview + sync hex
document.querySelectorAll('.cp-swatch').forEach(swatch => {
    swatch.oninput = () => {
        const hexEl = document.querySelector(`.cp-hex[data-hex="${swatch.dataset.var}"]`);
        if (hexEl) hexEl.value = swatch.value;
        applyCustomVars(getEditorVars());
        document.documentElement.setAttribute('data-theme','custom');
        document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === 'custom'));
    };
});
// Hex input → sync swatch
document.querySelectorAll('.cp-hex').forEach(hexEl => {
    hexEl.oninput = () => {
        const val = hexEl.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(val)) {
            const swatch = document.querySelector(`.cp-swatch[data-var="${hexEl.dataset.hex}"]`);
            if (swatch) { swatch.value = val; swatch.dispatchEvent(new Event('input')); }
        }
    };
});
el('btn-theme-editor-save').onclick = () => {
    const vars = getEditorVars();
    localStorage.setItem('zapret-custom-vars', JSON.stringify(vars));
    applyCustomVars(vars);
    applyTheme('custom');
    el('modal-theme-editor').classList.add('hidden');
    log('✓ Тема сохранена');
};
el('btn-theme-editor-reset').onclick = () => {
    localStorage.removeItem('zapret-custom-vars');
    applyTheme('dark');
    el('modal-theme-editor').classList.add('hidden');
    log('Тема сброшена на Dark');
};

// ─── Analytics ───
let analyticsWs = null;

function connectAnalytics() {
    const url = 'wss://zapret-admin-murzikov-stats.loca.lt';
    if (analyticsWs) analyticsWs.close();
    
    try {
        analyticsWs = new WebSocket(url);
        analyticsWs.onopen = () => console.log('[Analytics] Connected');
        analyticsWs.onerror = () => {};
        analyticsWs.onclose = () => {
            setTimeout(connectAnalytics, 15000); // Reconnect every 15s
        };
    } catch (e) {
        console.warn('[Analytics] connection failed');
    }
}
setTimeout(connectAnalytics, 2000);

// ─── App Updates ───
let latestAppUpdateUrl = null;

el('btn-app-update').onclick = async () => {
    el('modal-app-update').classList.remove('hidden');
    el('update-version-label').textContent = 'Проверка обновлений...';
    el('update-progress-wrap').classList.add('hidden');
    el('btn-app-download-now').classList.add('hidden');
    
    try {
        const res = await api.checkAppUpdate();
        if (res.success) {
            if (res.hasUpdate) {
                el('update-version-label').innerHTML = `
                    <div style="color:var(--success); font-weight:bold; font-size:1.1rem; margin-bottom:5px;">Доступна новая версия!</div>
                    <div style="color:var(--text-1); font-size:1rem;">Версия: ${res.version}</div>
                    <div style="margin-top:10px; font-size:0.8rem; color:var(--text-2); text-align:left; background:rgba(255,255,255,0.03); padding:10px; border-radius:5px; border:1px solid var(--border);">
                        ${res.changelog || 'Улучшения и исправления ошибок.'}
                    </div>
                `;
                latestAppUpdateUrl = res.url;
                el('btn-app-download-now').classList.remove('hidden');
            } else {
                el('update-version-label').innerHTML = `
                    <div style="color:var(--text-3); margin-bottom:10px;">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="opacity:0.3">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                    </div>
                    У вас установлена последняя версия
                `;
            }
        } else {
            el('update-version-label').textContent = 'Ошибка при проверке обновлений';
        }
    } catch (e) {
        el('update-version-label').textContent = 'Сервер обновлений недоступен';
    }
};

el('btn-app-download-now').onclick = async () => {
    if (!latestAppUpdateUrl) return;
    
    el('btn-app-download-now').classList.add('hidden');
    el('update-progress-wrap').classList.remove('hidden');
    
    api.onDownloadProgress((data) => {
        el('update-progress-fill').style.width = data.percent + '%';
        el('update-progress-percent').textContent = data.percent + '%';
        el('update-progress-text').textContent = data.text;
    });
    
    const success = await api.downloadAppUpdate(latestAppUpdateUrl);
    if (!success) {
        alert('Ошибка при загрузке обновления');
        el('btn-app-download-now').classList.remove('hidden');
        el('update-progress-wrap').classList.add('hidden');
    }
};

// Initialization
async function init() {
    if (currentFolder) {
        setupScreen.style.display = 'none';
        mainApp.style.display = 'flex';
        await loadStrategies();
        checkAutostart();
    } else {
        setupScreen.style.display = 'flex';
        mainApp.style.display = 'none';
    }

    // IPC Listeners
    if(api.onShowCloseDialog) {
        api.onShowCloseDialog(() => {
            const remember = localStorage.getItem('remember-close-choice');
            const lastChoice = localStorage.getItem('last-close-choice');
            
            if (remember === 'true' && lastChoice) {
                handleExit(lastChoice);
            } else {
                el('modal-exit').classList.remove('hidden');
            }
        });
    }

    if(api.onDownloadProgress) {
        api.onDownloadProgress((data) => {
            el('download-progress-container').classList.remove('hidden');
            el('download-status-text').innerText = data.text;
            el('download-percent').innerText = `${data.percent}%`;
            el('download-bar').style.width = `${data.percent}%`;
        });
    }

    if (api.onTrayStartStrategy) {
        api.onTrayStartStrategy(() => {
            if (!isStrategyRunning) startSelectedStrategy();
        });
    }
}

// Folder Selection
async function handleSelectFolder() {
    const path = await api.selectFolder();
    if (path) {
        currentFolder = path;
        localStorage.setItem('zapret-path', path);
        init();
    }
}
el('setup-btn-select').onclick = handleSelectFolder;
el('btn-select-folder').onclick = handleSelectFolder;

// Strategies List
async function loadStrategies() {
    if (!currentFolder) return;
    strategies = await api.listStrategies(currentFolder);
    const listEl = el('strategy-list');
    listEl.innerHTML = '';
    
    el('strategy-count').innerText = strategies.length;

    strategies.forEach(s => {
        const div = document.createElement('div');
        div.className = 'strategy-item';
        div.title = s;
        const label = s.replace(/\.bat$/i, '');
        div.innerHTML = `
            <span class="check">${selectedStrategy === s ? '▸' : ''}</span>
            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1;">${label}</span>
        `;
        div.onclick = () => selectStrategy(s, div);
        div.ondblclick = () => startSelectedStrategy();
        listEl.appendChild(div);
    });

    const last = localStorage.getItem('last-strategy');
    if (last && strategies.includes(last)) {
        selectStrategy(last, Array.from(listEl.children).find(e => e.title === last));
    } else if (strategies.length > 0) {
        selectStrategy(strategies[0], listEl.children[0]);
    }
}

function selectStrategy(name, divElement) {
    selectedStrategy = name;
    document.querySelectorAll('.strategy-item').forEach(item => {
        item.classList.remove('selected');
        const check = item.querySelector('.check');
        if (check) check.textContent = '';
    });
    if (divElement) {
        divElement.classList.add('selected');
        const check = divElement.querySelector('.check');
        if (check) check.textContent = '▸';
    }
    el('btn-start-strategy').disabled = false;
}

// Start / Stop Strategy
async function startSelectedStrategy() {
    if (!selectedStrategy) return;
    if (isStrategyRunning) {
        log('■ Остановка обхода...');
        await api.stopStrategy();
        setStrategyStatus(false, null);
    } else {
        const name = selectedStrategy.replace(/\.bat$/i,'');
        log(`▶ Запуск обхода: ${name}...`);
        const res = await api.startStrategy(currentFolder, selectedStrategy);
        if (res.success) {
            localStorage.setItem('last-strategy', selectedStrategy);
            setStrategyStatus(true, selectedStrategy);
            log(`✓ Подключено · ${name}`);
        } else {
            log(`✗ Ошибка запуска: ${res.error || 'неизвестная ошибка'}`);
        }
    }
}

el('btn-connect-main').onclick = startSelectedStrategy;
el('btn-start-strategy').onclick = startSelectedStrategy;

// ─── Uptime Timer ───
function startUptime() {
    uptimeStart = Date.now();
    if (uptimeInterval) clearInterval(uptimeInterval);
    uptimeInterval = setInterval(() => {
        const s = Math.floor((Date.now() - uptimeStart) / 1000);
        const h = Math.floor(s / 3600).toString().padStart(2,'0');
        const m = Math.floor((s % 3600) / 60).toString().padStart(2,'0');
        const sec = (s % 60).toString().padStart(2,'0');
        const upEl = el('status-uptime');
        if (upEl) upEl.innerText = `Аптайм ${h}:${m}:${sec}`;
    }, 1000);
}
function stopUptime() {
    if (uptimeInterval) clearInterval(uptimeInterval);
    uptimeInterval = null;
    uptimeStart = null;
    const upEl = el('status-uptime');
    if (upEl) upEl.innerText = '';
}

el('btn-find-working').onclick = async () => {
    if (!currentFolder || strategies.length === 0) {
        return alert('Нет доступных обходов в выбранной папке');
    }
    
    const btn = el('btn-find-working');
    btn.disabled = true;
    btn.innerText = 'Поиск...';
    
    if (isStrategyRunning) {
        await api.stopStrategy();
        setStrategyStatus(false, null);
    }
    
    let found = false;
    for (const s of strategies) {
        selectStrategy(s, Array.from(el('strategy-list').children).find(e => e.title === s));
        const res = await api.startStrategy(currentFolder, s);
        if (res.success) {
            setStrategyStatus(true, s);
            log(`Тестирование: ${s}...`);
            await new Promise(r => setTimeout(r, 4000));
            const check = await api.checkConnection();
            if (check) {
                log(`✓ Найден рабочий обход: ${s}`);
                localStorage.setItem('last-strategy', s);
                found = true;
                break;
            } else {
                log(`✗ Не работает: ${s}`);
                await api.stopStrategy();
                setStrategyStatus(false, null);
            }
        }
    }
    
    if (found) {
        alert('Рабочий обход найден и запущен!');
    } else {
        alert('Рабочий обход не найден');
    }
    
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Найти рабочий`;
};

function setStrategyStatus(running, name) {
    isStrategyRunning = running;
    const sideBtn = el('btn-start-strategy');
    const connectBtn = el('btn-connect-main');
    const label = el('connect-label');
    const stratName = el('connect-strategy-name');
    const pingsGrid = el('pings-grid');
    const panel = el('status-panel');

    if (running) {
        // Sidebar button
        sideBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"/></svg> Остановить`;
        sideBtn.classList.add('danger');
        // Big connect button
        connectBtn.classList.add('running');
        el('connect-icon-play').style.display = 'none';
        el('connect-icon-stop').style.display = '';
        label.textContent = 'Отключиться';
        label.classList.add('running');
        if (name) {
            stratName.textContent = name.replace(/\.bat$/i,'');
            stratName.style.display = '';
        }
        // Panel active
        panel.classList.add('active');
        pingsGrid.style.display = '';
        pingsGrid.innerHTML = '';
        startPings();
        startUptime();
    } else {
        const uptime = uptimeStart ? formatUptime(Date.now() - uptimeStart) : null;
        if (uptime) log(`■ Обход остановлен · работал ${uptime}`);
        sideBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Запустить`;
        sideBtn.classList.remove('danger');
        connectBtn.classList.remove('running');
        el('connect-icon-play').style.display = '';
        el('connect-icon-stop').style.display = 'none';
        label.textContent = 'Подключить';
        label.classList.remove('running');
        stratName.style.display = 'none';
        panel.classList.remove('active');
        pingsGrid.style.display = 'none';
        stopPings();
        stopUptime();
    }
}

function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}ч ${m}м ${sec}с`;
    if (m > 0) return `${m}м ${sec}с`;
    return `${sec}с`;
}


// Pings
async function startPings() {
    if (pingInterval) clearInterval(pingInterval);
    updatePings();
    pingInterval = setInterval(updatePings, 3000);
}

function stopPings() {
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = null;
}

async function updatePings() {
    if (!isStrategyRunning) return;
    const pings = await api.getPings();
    const grid = el('pings-grid');
    if (!grid) return;
    const createBox = (name, ms) => `
        <div class="status-box">
            <div class="status-box-name">${name}</div>
            <div class="status-box-value" style="color:${ms ? 'var(--success)' : 'var(--error)'}">
                ${ms ? ms + ' ms' : '—'}
            </div>
        </div>`;
    grid.innerHTML = `<div class="status-grid">${createBox('YouTube', pings.youtube) + createBox('Discord', pings.discord) + createBox('Roblox', pings.roblox)}</div>`;
}

// Version Manager
el('btn-version-manager').onclick = openVersionManager;
el('setup-btn-download').onclick = openVersionManager;

async function openVersionManager() {
    el('modal-versions').classList.remove('hidden');
    el('download-progress-container').classList.add('hidden');
    
    // Installed
    const installed = await api.listInstalledVersions();
    const instList = el('installed-versions-list');
    instList.innerHTML = '';
    
    if (installed.length === 0) {
        instList.innerHTML = '<div style="color:var(--text-3); font-size:0.82rem; padding:8px 0;">Нет установленных версий</div>';
    } else {
        installed.forEach(v => {
            const isActive = currentFolder === v.path;
            instList.innerHTML += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px;
                    background:${isActive ? 'var(--accent-dim)' : 'var(--bg)'};
                    border:1px solid ${isActive ? 'var(--accent-border)' : 'var(--border)'};
                    border-radius:var(--radius-sm);">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-weight:600; font-size:0.85rem;">${v.id}</span>
                        ${isActive ? '<span class="badge badge-accent">АКТИВНА</span>' : ''}
                    </div>
                    <button class="${isActive ? 'btn-small' : 'btn btn-small'}" onclick="activateVersion('${v.path.replace(/\\/g, '\\\\')}')" ${isActive ? 'disabled' : ''}>
                        ${isActive ? 'Текущая' : 'Активировать'}
                    </button>
                </div>
            `;
        });
    }

    // GitHub
    const githubList = el('github-versions-list');
    const githubRes = await api.checkZapretVersion();
    
    if (githubRes.success) {
        githubList.innerHTML = '';
        githubRes.releases.forEach(r => {
            const isInstalled = installed.some(v => v.id === r.version);
            githubList.innerHTML += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px;
                    background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm);">
                    <div>
                        <div style="font-weight:600; font-size:0.85rem;">${r.version}</div>
                        <div style="font-size:0.72rem; color:var(--text-3);">${new Date(r.published_at).toLocaleDateString('ru-RU')}</div>
                    </div>
                    <div>
                        ${isInstalled
                            ? '<span class="badge badge-success">Установлено</span>'
                            : `<button class="btn btn-small" onclick="installVersion('${r.url}', '${r.version}')">Скачать</button>`
                        }
                    </div>
                </div>
            `;
        });
    } else {
        githubList.innerHTML = '<div style="color:var(--error); font-size:0.82rem;">Ошибка загрузки с GitHub</div>';
    }
}

window.activateVersion = (path) => {
    currentFolder = path;
    localStorage.setItem('zapret-path', path);
    el('modal-versions').classList.add('hidden');
    init();
};

window.installVersion = async (url, version) => {
    const res = await api.downloadInstallZapret({ url, version });
    if (res.success) {
        activateVersion(res.path);
    } else {
        alert("Ошибка установки: " + res.error);
    }
};

// Domains Manager
el('btn-domains-manager').onclick = openDomainsManager;

async function openDomainsManager() {
    el('modal-domains').classList.remove('hidden');
    domainLists = await api.getLists(currentFolder);
    
    const tabsContainer = el('domains-tabs');
    tabsContainer.innerHTML = '';
    
    if (domainLists.length > 0) {
        // User-editable tabs first (marked with star)
        domainLists.forEach(list => {
            const btn = document.createElement('button');
            const isUserList = list.includes('свои');
            btn.className = 'btn-tool';
            if (isUserList) {
                btn.style.borderColor = 'var(--accent)';
                btn.style.color = 'var(--accent)';
            }
            btn.innerText = list;
            btn.title = isUserList ? 'Редактируемый вами список' : 'Системный список (управляется автоматически)';
            btn.onclick = () => selectDomainTab(list);
            tabsContainer.appendChild(btn);
        });
        selectDomainTab(domainLists[0]);
    } else {
        el('domains-textarea').value = '';
        el('domains-file-hint').innerText = 'Списки не найдены';
    }
}

async function selectDomainTab(tabName) {
    currentActiveDomainTab = tabName;
    
    // Update active tab highlight
    const tabs = el('domains-tabs').children;
    for(let i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].innerText === tabName);
    }

    const content = await api.readList(currentFolder, tabName);
    el('domains-textarea').value = content || '';

    // Show file hint and line count
    const isUserList = tabName.includes('свои');
    const fileHintEl = el('domains-file-hint');
    const lineCountEl = el('domains-line-count');
    
    if (fileHintEl) {
        fileHintEl.innerText = isUserList
            ? '✓ Редактируемый список (ваши домены)'
            : '⚠️ Системный список — изменения могут быть перезаписаны при обновлении';
    }
    if (lineCountEl) {
        const lines = content ? content.split('\n').filter(l => l.trim()).length : 0;
        lineCountEl.innerText = lines > 0 ? `${lines} доменов` : 'список пустой';
    }
}

el('btn-save-domains').onclick = async () => {
    if (!currentActiveDomainTab) return;
    const content = el('domains-textarea').value;
    const ok = await api.saveList(currentFolder, currentActiveDomainTab, content);
    if (ok) {
        // Just visual feedback, the modal can stay open
        const btn = el('btn-save-domains');
        btn.innerText = 'Сохранено!';
        setTimeout(() => btn.innerText = 'Сохранить', 2000);
    } else {
        alert("Ошибка сохранения");
    }
};

// Service Manager
el('btn-service-manager').onclick = async () => {
    if (!currentFolder) return alert('Сначала выберите папку Zapret');
    el('modal-service').classList.remove('hidden');
    await refreshServiceModal();
};

async function refreshServiceModal() {
    const status = await api.checkServiceStatus(currentFolder);
    const stEl = el('service-status-text');
    if (status.installed) {
        stEl.innerText = status.running ? 'ЗАПУЩЕН' : 'ОСТАНОВЛЕН';
        stEl.style.color = status.running ? 'var(--success)' : 'var(--warning)';
    } else {
        stEl.innerText = 'НЕ УСТАНОВЛЕН';
        stEl.style.color = 'var(--error)';
    }
    const config = await api.getServiceConfig(currentFolder);
    el('select-cfg-game').value = config.GAME_FILTER || 'disabled';
    el('select-cfg-auto').value = config.AUTO_UPDATE || 'disabled';
    el('select-cfg-ipset').value = config.IPSET_FILTER || 'none';
}

el('btn-service-install').onclick = async () => {
    await api.installService(currentFolder);
    setTimeout(() => refreshServiceModal(), 2000);
};
el('btn-service-remove').onclick = async () => {
    await api.removeService(currentFolder);
    setTimeout(() => refreshServiceModal(), 2000);
};

el('select-cfg-game').onchange = (e) => {
    api.updateServiceConfig(currentFolder, { GAME_FILTER: e.target.value });
    log('Game Filter: ' + e.target.value);
};
el('select-cfg-auto').onchange = (e) => {
    api.updateServiceConfig(currentFolder, { AUTO_UPDATE: e.target.value });
    log('Автообновление: ' + e.target.value);
};
el('select-cfg-ipset').onchange = (e) => {
    api.updateServiceConfig(currentFolder, { IPSET_FILTER: e.target.value });
    log('IPSet Filter: ' + e.target.value);
};

window.runMaintenance = async (cmd) => {
    log(`Запуск инструмента: ${cmd}...`);
    let res;
    if (cmd === 'ipset') res = await api.updateIpset(currentFolder);
    if (cmd === 'hosts') res = await api.updateHosts(currentFolder);
    if (cmd === 'diag') res = await api.runDiagnostics(currentFolder);
    if (cmd === 'test') res = await api.runTests(currentFolder);

    if (res && res.success) log(`Успешно выполнено: ${cmd}`);
    else if (res && res.error) log(`Ошибка (${cmd}): ${res.error}`);
};

// Autostart
async function checkAutostart() {
    const status = await api.checkAutostart();
    el('btn-autostart').classList.toggle('active', status.enable);
    const abtn = el('btn-autostart');
    abtn.innerHTML = status.enable
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Автозапуск: ВКЛ`
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Автозапуск`;
}
el('btn-autostart').onclick = async () => {
    const isActive = el('btn-autostart').classList.contains('active');
    await api.toggleAutostart({ enable: !isActive, minimizeOnStart: false });
    checkAutostart();
};

// Exit handling
window.handleExit = (choice) => {
    const remember = el('exit-remember-cb').checked;
    if (remember) {
        localStorage.setItem('remember-close-choice', 'true');
        localStorage.setItem('last-close-choice', choice);
    } else {
        localStorage.removeItem('remember-close-choice');
    }

    if (choice === 'minimize') {
        api.minimizeToTray();
        el('modal-exit').classList.add('hidden');
    } else {
        api.forceQuit();
    }
};

// Search strategy
el('search-strategy').oninput = (e) => {
    const term = e.target.value.toLowerCase();
    const items = el('strategy-list').children;
    for (let i=0; i<items.length; i++) {
        const text = items[i].innerText.toLowerCase();
        items[i].style.display = text.includes(term) ? 'flex' : 'none';
    }
};

// Logs
function log(msg) {
    const container = el('logs-container');
    const div = document.createElement('div');
    const text = msg.toLowerCase();
    div.className = 'log-entry' +
        (text.includes('✓') || text.includes('успеш') || text.includes('[ok]') ? ' log-ok' : '') +
        (text.includes('✗') || text.includes('ошибка') || text.includes('[err]') ? ' log-err' : '');
    const time = new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    div.innerHTML = `<span style="color:var(--text-3); margin-right:8px;">${time}</span>${msg}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// Initial Boot
init();
