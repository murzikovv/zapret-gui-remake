const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');
const os = require('os');

// Ensure UTF-8 console output on Windows so cyrillic prompts render correctly
if (process.platform === 'win32') {
    try { execSync('chcp 65001 >NUL', { stdio: 'ignore' }); } catch (e) {}
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function run(cmd, opts = {}) {
    console.log('   $', cmd);
    execSync(cmd, { stdio: 'inherit', ...opts });
}

function safeRead(p) { return fs.readFileSync(p, 'utf-8'); }
function safeWrite(p, c) { fs.writeFileSync(p, c, 'utf-8'); }

async function start() {
    console.log('=== АВТОМАТИЗАЦИЯ ВЫПУСКА ОБНОВЛЕНИЯ ===\n');

    const pkgPath  = path.resolve('package.json');
    const mainPath = path.resolve('src/main.js');
    const verPath  = path.resolve('version.json');

    const pkg = JSON.parse(safeRead(pkgPath));
    console.log(`Текущая версия: ${pkg.version}\n`);

    let newVersion = (await ask('Введите новую версию (например, 1.3.0): ')).trim();
    if (!newVersion) { console.error('Версия обязательна.'); rl.close(); return; }
    newVersion = newVersion.replace(/^v/i, '');

    const changelog = (await ask('Что нового в этой версии?: ')).trim() || 'Улучшения и исправления';

    const buildNow = (await ask('Собрать exe сразу после пуша? (y/n) [y]: ')).toLowerCase();
    const doBuild = buildNow !== 'n' && buildNow !== 'no' && buildNow !== 'нет';

    const doPush = (await ask('Запушить в git? (y/n) [y]: ')).toLowerCase();
    const willPush = doPush !== 'n' && doPush !== 'no' && doPush !== 'нет';

    // 1. package.json
    pkg.version = newVersion;
    safeWrite(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('✓ package.json обновлён');

    // 2. src/main.js
    let mainContent = safeRead(mainPath);
    const before = mainContent;
    mainContent = mainContent.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${newVersion}';`);
    if (mainContent === before) {
        console.warn('⚠ Не нашёл APP_VERSION в src/main.js — проверь вручную');
    } else {
        safeWrite(mainPath, mainContent);
        console.log('✓ src/main.js обновлён');
    }

    // 3. version.json
    const vJson = JSON.parse(safeRead(verPath));
    vJson.version = newVersion;
    vJson.changelog = changelog;
    vJson.url = vJson.url || 'https://github.com/murzikovv/zapret-gui-remake/releases/latest/download/ZapretGUISetup.exe';
    safeWrite(verPath, JSON.stringify(vJson, null, 2) + '\n');
    console.log('✓ version.json обновлён');

    // 4. Git — pass commit message via a temp file so cyrillic+special chars survive the shell.
    let pushedOk = false;
    if (willPush) {
        const msgFile = path.join(os.tmpdir(), `zapret-commit-${Date.now()}.txt`);
        try {
            safeWrite(msgFile, `Release v${newVersion}: ${changelog}\n`);
            console.log('\n→ git add/commit');
            run('git add package.json src/main.js version.json');
            try { run(`git commit -F "${msgFile}"`); }
            catch (e) {
                console.log('• Нечего коммитить (возможно версии уже актуальны)');
            }

            // Pull remote changes first — avoids "rejected: fetch first" if someone else
            // (or you from another machine) pushed in the meantime.
            console.log('→ git pull --rebase (синхронизация с remote)');
            try { run('git pull --rebase origin main'); }
            catch (e) {
                console.error('! Конфликт при pull --rebase. Запусти `git rebase --abort` и разреши руками.');
                throw e;
            }

            console.log('→ git push');
            run('git push origin main');
            pushedOk = true;
            console.log('✓ Данные отправлены на GitHub');
        } catch (e) {
            console.error('! Ошибка git — продолжаю без пуша. Проверь руками.');
        } finally {
            try { fs.unlinkSync(msgFile); } catch (e) {}
        }
    } else {
        console.log('• Git-пуш пропущен по запросу');
    }

    // 5. Build
    let exePath = path.resolve('dist', 'ZapretGUISetup.exe');
    let buildOk = false;
    if (doBuild) {
        console.log('\n→ npm run build');
        const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { stdio: 'inherit' });
        if (r.status === 0 && fs.existsSync(exePath)) {
            buildOk = true;
            console.log(`\n✓ Готов установщик: ${exePath}`);
        } else if (r.status === 0) {
            console.log('\n⚠ Сборка прошла, но ZapretGUISetup.exe не найден в dist/. Проверь имя.');
        } else {
            console.error('! Сборка завершилась с ошибкой');
        }
    } else {
        console.log('• Сборка пропущена. Запусти 2_СБОРКА_В_EXE.bat вручную.');
    }

    // 6. Optional: create GitHub Release via gh CLI
    if (pushedOk && buildOk) {
        const ghAvailable = (() => {
            try {
                execSync(process.platform === 'win32' ? 'where gh' : 'which gh', { stdio: 'ignore' });
                return true;
            } catch (e) { return false; }
        })();
        if (ghAvailable) {
            const doRelease = (await ask('\nСоздать GitHub Release через gh CLI? (y/n) [y]: ')).toLowerCase();
            const willRelease = doRelease !== 'n' && doRelease !== 'no' && doRelease !== 'нет';
            if (willRelease) {
                try {
                    const notesFile = path.join(os.tmpdir(), `zapret-notes-${Date.now()}.txt`);
                    safeWrite(notesFile, changelog);
                    run(`gh release create v${newVersion} "${exePath}" --title "v${newVersion}" --notes-file "${notesFile}"`);
                    try { fs.unlinkSync(notesFile); } catch (e) {}
                    console.log(`✓ Release v${newVersion} создан на GitHub`);
                } catch (e) {
                    console.error('! Не получилось создать release через gh. Загрузи руками: https://github.com/murzikovv/zapret-gui-remake/releases/new');
                }
            }
        } else {
            console.log('\n• gh CLI не установлен — загрузи exe вручную:');
            console.log('  https://github.com/murzikovv/zapret-gui-remake/releases/new');
            console.log(`  Tag: v${newVersion}`);
            console.log(`  File: ${exePath}`);
        }
    }

    console.log('\n================================================');
    console.log(`Версия v${newVersion} готова.`);
    if (!pushedOk) console.log('⚠ Не запушено в git — сделай вручную');
    if (!buildOk) console.log('⚠ Не собрано — запусти 2_СБОРКА_В_EXE.bat');
    console.log('================================================');

    rl.close();
}

start().catch(e => { console.error(e); rl.close(); process.exit(1); });
