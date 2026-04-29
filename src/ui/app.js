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
    dark:     { '--bg':'#0c0e14','--bg-2':'#131620','--bg-card':'#181b25','--bg-card-hover':'#1e2230','--bg-elevated':'#1f2335','--text-1':'#e8eaf0','--text-2':'#8b90a0','--text-3':'#525666','--accent':'#5b8def','--success':'#4ade80','--error':'#f87171','--warning':'#fbbf24','--btn-shadow':'rgba(0,0,0,0.45)' },
    midnight: { '--bg':'#0a0c1a','--bg-2':'#0f1228','--bg-card':'#141830','--bg-card-hover':'#1a1f3c','--bg-elevated':'#1e2440','--text-1':'#dde2f5','--text-2':'#7880a8','--text-3':'#424870','--accent':'#7c9ef7','--success':'#34d399','--error':'#f87171','--warning':'#fbbf24','--btn-shadow':'rgba(0,0,0,0.45)' },
    slate:    { '--bg':'#0f1117','--bg-2':'#161a23','--bg-card':'#1c2130','--bg-card-hover':'#222840','--bg-elevated':'#242c42','--text-1':'#e2e8f0','--text-2':'#94a3b8','--text-3':'#4a5568','--accent':'#60a5fa','--success':'#4ade80','--error':'#f87171','--warning':'#fbbf24','--btn-shadow':'rgba(0,0,0,0.45)' },
    mocha:    { '--bg':'#13100e','--bg-2':'#1c1714','--bg-card':'#231e1a','--bg-card-hover':'#2b2420','--bg-elevated':'#302820','--text-1':'#ede0d4','--text-2':'#9a8f86','--text-3':'#5a504a','--accent':'#e08060','--success':'#a6d189','--error':'#e78284','--warning':'#e5c890','--btn-shadow':'rgba(0,0,0,0.45)' },
    light:    { '--bg':'#f4f5f7','--bg-2':'#ffffff','--bg-card':'#ffffff','--bg-card-hover':'#f9fafb','--bg-elevated':'#ffffff','--text-1':'#111827','--text-2':'#4b5563','--text-3':'#9ca3af','--accent':'#3b82f6','--success':'#10b981','--error':'#ef4444','--warning':'#f59e0b','--btn-shadow':'rgba(0,0,0,0.1)' },
};

// ─── DOM Listeners (Safe Wrapper) ───
const setOnClick = (id, fn) => {
    const element = el(id);
    if (element) element.onclick = fn;
};
const setOnInput = (id, fn) => {
    const element = el(id);
    if (element) element.oninput = fn;
};
const setOnChange = (id, fn) => {
    const element = el(id);
    if (element) element.onchange = fn;
};

function applyCustomVars(vars) {
    let styleEl = document.getElementById('custom-theme-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'custom-theme-style';
        document.head.appendChild(styleEl);
    }
    const hasBorder    = vars['--border'];
    const hasBorderStr = vars['--border-strong'];
    const lines = Object.entries(vars).map(([k,v]) => `  ${k}: ${v};`).join('\n');
    styleEl.textContent = `[data-theme="custom"] {\n${lines}\n  --accent-dim: color-mix(in srgb, var(--accent) 12%, transparent);\n  --accent-border: color-mix(in srgb, var(--accent) 30%, transparent);\n  --success-dim: color-mix(in srgb, var(--success) 10%, transparent);\n  --error-dim: color-mix(in srgb, var(--error) 10%, transparent);\n  --connect-ring: color-mix(in srgb, var(--accent) 15%, transparent);\n${!hasBorder ? '  --border: rgba(255,255,255,0.07);' : ''}\n${!hasBorderStr ? '  --border-strong: rgba(255,255,255,0.12);' : ''}\n}`;
}

// Returns the RGB triplet (no hash, comma-separated) for a given hex color string
function hexToRgbTriple(hex) {
    const c = hex.replace('#','');
    const r = parseInt(c.substring(0,2),16);
    const g = parseInt(c.substring(2,4),16);
    const b = parseInt(c.substring(4,6),16);
    return `${r},${g},${b}`;
}

// Sync --glass-rgb to current theme's --bg so glass tint matches
function syncGlassRgb() {
    if (!document.body.classList.contains('has-bg')) return;
    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    // --bg is a hex color in built-in themes; for custom it may need a fallback
    if (/^#[0-9a-f]{6}$/i.test(bgColor)) {
        document.documentElement.style.setProperty('--glass-rgb', hexToRgbTriple(bgColor));
    }
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
        // Restore custom background if saved
        const savedBg   = localStorage.getItem('zapret-bg-image');
        const savedBlur = parseInt(localStorage.getItem('zapret-bg-blur') || '0', 10);
        if (savedBg) {
            applyBackground(savedBg, savedBlur);
        }
    } else {
        // Hide background for built-in themes
        applyBackground(null, 0);
    }
    // After theme applied, update glass tint (slight delay so CSS vars settle)
    requestAnimationFrame(syncGlassRgb);
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
const EDITOR_VARS = ['--bg','--bg-2','--bg-card','--bg-card-hover','--bg-elevated','--text-1','--text-2','--text-3','--accent','--success','--error','--warning','--btn-shadow'];

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
    loadCustomTemplates();
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

// ─── Custom Theme Templates ───
function loadCustomTemplates() {
    const listEl = el('theme-templates-list');
    if (!listEl) return;
    const saved = JSON.parse(localStorage.getItem('zapret-theme-templates') || '[]');
    listEl.innerHTML = '';
    
    if (saved.length === 0) {
        listEl.innerHTML = '<div style="font-size:0.75rem; color:var(--text-3); width:100%;">Нет сохраненных шаблонов</div>';
        return;
    }
    
    saved.forEach((tpl, idx) => {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.alignItems = 'stretch';
        wrap.style.background = 'var(--bg-card)';
        wrap.style.border = '1px solid var(--border)';
        wrap.style.borderRadius = 'var(--radius-sm)';
        wrap.style.overflow = 'hidden';
        
        const btnLoad = document.createElement('button');
        btnLoad.className = 'theme-preset-btn';
        btnLoad.style.border = 'none';
        btnLoad.style.borderRadius = '0';
        btnLoad.style.margin = '0';
        btnLoad.style.background = 'transparent';
        btnLoad.textContent = tpl.name;
        btnLoad.onclick = () => applyThemeTemplate(tpl);
        
        const btnDel = document.createElement('button');
        btnDel.className = 'icon-btn';
        btnDel.style.borderRadius = '0';
        btnDel.style.borderLeft = '1px solid var(--border)';
        btnDel.style.padding = '0 6px';
        btnDel.style.color = 'var(--error)';
        btnDel.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
        btnDel.onclick = () => {
            if (confirm(`Удалить шаблон "${tpl.name}"?`)) {
                saved.splice(idx, 1);
                localStorage.setItem('zapret-theme-templates', JSON.stringify(saved));
                loadCustomTemplates();
            }
        };
        
        wrap.appendChild(btnLoad);
        wrap.appendChild(btnDel);
        listEl.appendChild(wrap);
    });
}

setOnClick('btn-theme-template-save', () => {
    const nameInput = el('theme-template-name');
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) return alert('Введите название шаблона');
    
    const template = {
        name: name,
        vars: getEditorVars(),
        bgImage: localStorage.getItem('zapret-bg-image') || null,
        bgBlur: localStorage.getItem('zapret-bg-blur') || '0',
        uiBlur: localStorage.getItem('zapret-ui-blur') || '16',
        overlayColor: localStorage.getItem('zapret-overlay-color') || '#000000',
        overlayOpacity: localStorage.getItem('zapret-overlay-opacity') || '0',
        glassColor: localStorage.getItem('zapret-glass-color') || '#000000',
        glassOpacity: localStorage.getItem('zapret-glass-opacity') || '20'
    };
    
    const saved = JSON.parse(localStorage.getItem('zapret-theme-templates') || '[]');
    const existingIdx = saved.findIndex(t => t.name === name);
    if (existingIdx >= 0) {
        if(confirm(`Шаблон "${name}" уже существует. Перезаписать?`)) {
            saved[existingIdx] = template;
        } else {
            return;
        }
    } else {
        saved.push(template);
    }
    
    localStorage.setItem('zapret-theme-templates', JSON.stringify(saved));
    nameInput.value = '';
    loadCustomTemplates();
});

function applyThemeTemplate(tpl) {
    localStorage.setItem('zapret-custom-vars', JSON.stringify(tpl.vars));
    
    if (tpl.bgImage) localStorage.setItem('zapret-bg-image', tpl.bgImage);
    else localStorage.removeItem('zapret-bg-image');
    
    localStorage.setItem('zapret-bg-blur', tpl.bgBlur);
    localStorage.setItem('zapret-ui-blur', tpl.uiBlur);
    localStorage.setItem('zapret-overlay-color', tpl.overlayColor);
    localStorage.setItem('zapret-overlay-opacity', tpl.overlayOpacity);
    localStorage.setItem('zapret-glass-color', tpl.glassColor);
    localStorage.setItem('zapret-glass-opacity', tpl.glassOpacity);
    
    openThemeEditor();
    
    if (tpl.bgImage) applyBackground(tpl.bgImage, parseInt(tpl.bgBlur, 10));
    else applyBackground(null, 0);
    
    document.documentElement.style.setProperty('--ui-blur', tpl.uiBlur + 'px');
    
    const sliderBgBlur = el('bg-blur-slider');
    const valBgBlur = el('bg-blur-value');
    if(sliderBgBlur) sliderBgBlur.value = tpl.bgBlur;
    if(valBgBlur) valBgBlur.textContent = tpl.bgBlur + 'px';
    
    const sliderUiBlur = el('ui-blur-slider');
    const valUiBlur = el('ui-blur-value');
    if(sliderUiBlur) sliderUiBlur.value = tpl.uiBlur;
    if(valUiBlur) valUiBlur.textContent = tpl.uiBlur + 'px';
    
    const preview = el('bg-preview');
    if (preview) {
        if (tpl.bgImage) {
            preview.style.backgroundImage = `url('${tpl.bgImage}')`;
            preview.style.display = 'block';
        } else {
            preview.style.display = 'none';
        }
    }

    // Refresh overlay inputs
    const ovPicker = el('overlay-color-picker');
    const ovHex = el('overlay-color-hex');
    const ovSlider = el('overlay-opacity-slider');
    const ovVal = el('overlay-opacity-value');
    if(ovPicker) ovPicker.value = tpl.overlayColor;
    if(ovHex) ovHex.value = tpl.overlayColor;
    if(ovSlider) ovSlider.value = tpl.overlayOpacity;
    if(ovVal) ovVal.textContent = tpl.overlayOpacity + '%';
    
    // Refresh glass inputs
    const glPicker = el('glass-color-picker');
    const glHex = el('glass-color-hex');
    const glSlider = el('glass-opacity-slider');
    const glVal = el('glass-opacity-value');
    if(glPicker) glPicker.value = tpl.glassColor;
    if(glHex) glHex.value = tpl.glassColor;
    if(glSlider) glSlider.value = tpl.glassOpacity;
    if(glVal) glVal.textContent = tpl.glassOpacity + '%';
    
    applyOverlay(tpl.overlayColor, parseInt(tpl.overlayOpacity, 10));
    applyGlassTint(tpl.glassColor, parseInt(tpl.glassOpacity, 10));
    
    applyCustomVars(tpl.vars);
    applyTheme('custom');
}

// ─── Background Image ───
function applyBackground(dataUrl, blur) {
    const bgEl = document.getElementById('app-bg');
    if (!bgEl) return;
    if (dataUrl) {
        bgEl.style.backgroundImage = `url('${dataUrl}')`;
        bgEl.style.filter = `blur(${blur || 0}px)`;
        // Compensate for blur edge bleed
        bgEl.style.inset = blur > 0 ? `-${blur * 2}px` : '0';
        document.body.classList.add('has-bg');
        // Re-apply overlay now that background is active
        const savedColor   = localStorage.getItem('zapret-overlay-color') || '#000000';
        const savedOpacity = parseInt(localStorage.getItem('zapret-overlay-opacity') || '0', 10);
        applyOverlay(savedColor, savedOpacity);

        const savedGlassColor = localStorage.getItem('zapret-glass-color') || '#000000';
        const savedGlassOpac  = parseInt(localStorage.getItem('zapret-glass-opacity') || '20', 10);
        applyGlassTint(savedGlassColor, savedGlassOpac);

        requestAnimationFrame(syncGlassRgb);
    } else {
        bgEl.style.backgroundImage = '';
        bgEl.style.filter = '';
        bgEl.style.inset = '0';
        document.body.classList.remove('has-bg');
        applyOverlay('#000000', 0);
        document.documentElement.style.removeProperty('--glass-rgb');
    }
}

// ─── Glass Overlay ───
function applyOverlay(color, opacity) {
    const overlayEl = document.getElementById('glass-overlay');
    if (!overlayEl) return;
    if (opacity > 0 && document.body.classList.contains('has-bg')) {
        // Convert hex color to rgba with given opacity (0-90 → 0.0-0.9)
        const r = parseInt(color.slice(1,3), 16);
        const g = parseInt(color.slice(3,5), 16);
        const b = parseInt(color.slice(5,7), 16);
        overlayEl.style.background = `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
    } else {
        overlayEl.style.background = 'transparent';
    }
}

function applyGlassTint(color, opacity) {
    if (opacity >= 0) {
        const r = parseInt(color.slice(1,3), 16);
        const g = parseInt(color.slice(3,5), 16);
        const b = parseInt(color.slice(5,7), 16);
        const rgba = `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
        document.documentElement.style.setProperty('--glass-bg', rgba);
    }
}

// Load saved bg on boot (only if custom theme is active)
(function() {
    const savedBg       = localStorage.getItem('zapret-bg-image');
    const savedBlur     = parseInt(localStorage.getItem('zapret-bg-blur') || '0', 10);
    const savedUiBlur   = parseInt(localStorage.getItem('zapret-ui-blur') || '16', 10);
    const savedOvColor  = localStorage.getItem('zapret-overlay-color') || '#000000';
    const savedOvOpac   = parseInt(localStorage.getItem('zapret-overlay-opacity') || '0', 10);
    const savedGlassColor = localStorage.getItem('zapret-glass-color') || '#000000';
    const savedGlassOpac  = parseInt(localStorage.getItem('zapret-glass-opacity') || '20', 10);
    const slider        = document.getElementById('bg-blur-slider');
    const blurVal       = document.getElementById('bg-blur-value');
    const uiSlider      = document.getElementById('ui-blur-slider');
    const uiBlurVal     = document.getElementById('ui-blur-value');
    const preview       = document.getElementById('bg-preview');
    const ovColorPicker = document.getElementById('overlay-color-picker');
    const ovColorHex    = document.getElementById('overlay-color-hex');
    const ovSlider      = document.getElementById('overlay-opacity-slider');
    const ovVal         = document.getElementById('overlay-opacity-value');
    const glassColorPicker = document.getElementById('glass-color-picker');
    const glassColorHex    = document.getElementById('glass-color-hex');
    const glassSlider      = document.getElementById('glass-opacity-slider');
    const glassVal         = document.getElementById('glass-opacity-value');
    if (slider)    slider.value              = savedBlur;
    if (blurVal)   blurVal.textContent       = savedBlur + 'px';
    if (uiSlider)  uiSlider.value            = savedUiBlur;
    if (uiBlurVal) uiBlurVal.textContent     = savedUiBlur + 'px';
    if (ovColorPicker) ovColorPicker.value   = savedOvColor;
    if (ovColorHex)    ovColorHex.value      = savedOvColor;
    if (ovSlider)  ovSlider.value            = savedOvOpac;
    if (ovVal)     ovVal.textContent         = savedOvOpac + '%';
    if (glassColorPicker) glassColorPicker.value = savedGlassColor;
    if (glassColorHex)    glassColorHex.value    = savedGlassColor;
    if (glassSlider)      glassSlider.value      = savedGlassOpac;
    if (glassVal)         glassVal.textContent   = savedGlassOpac + '%';
    document.documentElement.style.setProperty('--ui-blur', savedUiBlur + 'px');
    // Only show background when on custom theme
    const currentTheme = localStorage.getItem('zapret-theme') || 'dark';
    if (savedBg && currentTheme === 'custom') {
        applyBackground(savedBg, savedBlur);
        if (preview) {
            preview.style.backgroundImage = `url('${savedBg}')`;
            preview.style.display = 'block';
        }
    } else if (preview && savedBg) {
        // Show preview thumbnail even if bg not applied (not in custom theme)
        preview.style.backgroundImage = `url('${savedBg}')`;
        preview.style.display = 'block';
    }
})();

setOnClick('btn-bg-upload', () => el('bg-file-input').click());

setOnChange('bg-file-input', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        const blur = parseInt(el('bg-blur-slider')?.value || '0', 10);
        localStorage.setItem('zapret-bg-image', dataUrl);
        applyBackground(dataUrl, blur);
        const preview = el('bg-preview');
        if (preview) {
            preview.style.backgroundImage = `url('${dataUrl}')`;
            preview.style.display = 'block';
        }
        log('✓ Фоновое изображение установлено');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});

setOnClick('btn-bg-remove', () => {
    localStorage.removeItem('zapret-bg-image');
    localStorage.removeItem('zapret-bg-blur');
    localStorage.removeItem('zapret-overlay-color');
    localStorage.removeItem('zapret-overlay-opacity');
    localStorage.removeItem('zapret-glass-color');
    localStorage.removeItem('zapret-glass-opacity');
    applyBackground(null, 0);
    const preview = el('bg-preview');
    if (preview) preview.style.display = 'none';
    const slider = el('bg-blur-slider');
    const blurVal = el('bg-blur-value');
    if (slider) slider.value = 0;
    if (blurVal) blurVal.textContent = '0px';
    // Reset overlay controls
    const ovPicker = el('overlay-color-picker');
    const ovHex    = el('overlay-color-hex');
    const ovSlider = el('overlay-opacity-slider');
    const ovVal    = el('overlay-opacity-value');
    if (ovPicker) ovPicker.value = '#000000';
    if (ovHex)    ovHex.value   = '#000000';
    if (ovSlider) ovSlider.value = 0;
    if (ovVal)    ovVal.textContent = '0%';
    // Reset glass controls
    const gPicker = el('glass-color-picker');
    const gHex    = el('glass-color-hex');
    const gSlider = el('glass-opacity-slider');
    const gVal    = el('glass-opacity-value');
    if (gPicker) gPicker.value = '#000000';
    if (gHex)    gHex.value   = '#000000';
    if (gSlider) gSlider.value = 20;
    if (gVal)    gVal.textContent = '20%';
    log('Фоновое изображение удалено');
});

setOnInput('bg-blur-slider', (e) => {
    const blur = parseInt(e.target.value, 10);
    const valEl = el('bg-blur-value');
    if (valEl) valEl.textContent = blur + 'px';
    localStorage.setItem('zapret-bg-blur', blur);
    const savedBg = localStorage.getItem('zapret-bg-image');
    if (savedBg) applyBackground(savedBg, blur);
});

setOnInput('ui-blur-slider', (e) => {
    const blur = parseInt(e.target.value, 10);
    const valEl = el('ui-blur-value');
    if (valEl) valEl.textContent = blur + 'px';
    localStorage.setItem('zapret-ui-blur', blur);
    document.documentElement.style.setProperty('--ui-blur', blur + 'px');
});

// ─── Overlay Tint Controls ───
setOnInput('overlay-color-picker', (e) => {
    const color = e.target.value;
    const hexEl = el('overlay-color-hex');
    if (hexEl) hexEl.value = color;
    localStorage.setItem('zapret-overlay-color', color);
    const opacity = parseInt(el('overlay-opacity-slider')?.value || '0', 10);
    applyOverlay(color, opacity);
});

setOnInput('overlay-color-hex', (e) => {
    const val = e.target.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(val)) {
        const picker = el('overlay-color-picker');
        if (picker) picker.value = val;
        localStorage.setItem('zapret-overlay-color', val);
        const opacity = parseInt(el('overlay-opacity-slider')?.value || '0', 10);
        applyOverlay(val, opacity);
    }
});

setOnInput('overlay-opacity-slider', (e) => {
    const opacity = parseInt(e.target.value, 10);
    const valEl = el('overlay-opacity-value');
    if (valEl) valEl.textContent = opacity + '%';
    localStorage.setItem('zapret-overlay-opacity', opacity);
    const color = el('overlay-color-picker')?.value || '#000000';
    applyOverlay(color, opacity);
});

// ─── Glass Tint Controls ───
setOnInput('glass-color-picker', (e) => {
    const color = e.target.value;
    if (el('glass-color-hex')) el('glass-color-hex').value = color;
    localStorage.setItem('zapret-glass-color', color);
    const opacity = parseInt(el('glass-opacity-slider')?.value || '20', 10);
    applyGlassTint(color, opacity);
});

setOnInput('glass-color-hex', (e) => {
    const val = e.target.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(val)) {
        if (el('glass-color-picker')) el('glass-color-picker').value = val;
        localStorage.setItem('zapret-glass-color', val);
        const opacity = parseInt(el('glass-opacity-slider')?.value || '20', 10);
        applyGlassTint(val, opacity);
    }
});

setOnInput('glass-opacity-slider', (e) => {
    const opacity = parseInt(e.target.value, 10);
    if (el('glass-opacity-value')) el('glass-opacity-value').textContent = opacity + '%';
    localStorage.setItem('zapret-glass-opacity', opacity);
    const color = el('glass-color-picker')?.value || '#000000';
    applyGlassTint(color, opacity);
});

// ─── Modals & Tools ───
setOnClick('btn-version-manager', () => el('modal-versions').classList.remove('hidden'));
setOnClick('setup-btn-download', () => el('modal-versions').classList.remove('hidden'));
setOnClick('setup-btn-select', handleSelectFolder);
setOnClick('btn-select-folder', handleSelectFolder);
setOnClick('btn-domains-manager', openDomainsManager);
setOnClick('btn-save-domains', async () => {
    if (!currentActiveDomainTab) return;
    const content = el('domains-textarea').value;
    const ok = await api.saveList(currentFolder, currentActiveDomainTab, content);
    if (ok) {
        const btn = el('btn-save-domains');
        btn.innerText = 'Сохранено!';
        setTimeout(() => btn.innerText = 'Сохранить', 2000);
    } else {
        alert("Ошибка сохранения");
    }
});

setOnClick('btn-autostart', async () => {
    const isActive = el('btn-autostart').classList.contains('active');
    await api.toggleAutostart({ enable: !isActive, minimizeOnStart: false });
    checkAutostart();
});

setOnClick('btn-service-manager', async () => {
    if (!currentFolder) return alert('Сначала выберите папку Zapret');
    el('modal-service').classList.remove('hidden');
    await refreshServiceModal();
});

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

setOnClick('btn-app-update', async () => {
    console.log('[UI] Update button clicked');
    // Remove pulse once user opens the modal
    el('btn-app-update').classList.remove('has-update');

    el('modal-app-update').classList.remove('hidden');
    el('update-version-label').textContent = 'Проверка обновлений...';
    el('update-progress-wrap').classList.add('hidden');
    el('btn-app-download-now').classList.add('hidden');
    
    try {
        console.log('[UI] Calling api.checkAppUpdate()...');
        const res = await api.checkAppUpdate();
        console.log('[UI] Update check result:', res);
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
});

// Silent background update check — only lights up button if update exists
async function checkAppUpdateSilent() {
    try {
        const res = await api.checkAppUpdate();
        if (res && res.success && res.hasUpdate) {
            el('btn-app-update').classList.add('has-update');
        }
    } catch (e) {
        // Silently ignore — no network, no problem
    }
}
// Run after a short delay so the app loads first
setTimeout(checkAppUpdateSilent, 3000);

setOnClick('btn-app-download-now', async () => {
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
});

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
// Listeners moved to setOnClick safe wrapper sections

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

setOnClick('btn-connect-main', startSelectedStrategy);
setOnClick('btn-start-strategy', startSelectedStrategy);

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

setOnClick('btn-find-working', async () => {
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
});

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
// Listeners moved to setOnClick safe wrapper sections

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

// Listeners moved to setOnClick safe wrapper sections

// Service Manager
// Listeners moved to setOnClick safe wrapper sections

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

setOnClick('btn-service-install', async () => {
    await api.installService(currentFolder);
    setTimeout(() => refreshServiceModal(), 2000);
});
setOnClick('btn-service-remove', async () => {
    await api.removeService(currentFolder);
    setTimeout(() => refreshServiceModal(), 2000);
});

setOnChange('select-cfg-game', (e) => {
    api.updateServiceConfig(currentFolder, { GAME_FILTER: e.target.value });
    log('Game Filter: ' + e.target.value);
});
setOnChange('select-cfg-auto', (e) => {
    api.updateServiceConfig(currentFolder, { AUTO_UPDATE: e.target.value });
    log('Автообновление: ' + e.target.value);
});
setOnChange('select-cfg-ipset', (e) => {
    api.updateServiceConfig(currentFolder, { IPSET_FILTER: e.target.value });
    log('IPSet Filter: ' + e.target.value);
});

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
// Listeners moved to setOnClick safe wrapper sections

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
setOnInput('search-strategy', (e) => {
    const term = e.target.value.toLowerCase();
    const items = el('strategy-list').children;
    for (let i=0; i<items.length; i++) {
        const text = items[i].innerText.toLowerCase();
        items[i].style.display = text.includes(term) ? 'flex' : 'none';
    }
});

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
