const fs = require('fs');
const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

async function start() {
    console.log('=== АВТОМАТИЗАЦИЯ ВЫПУСКА ОБНОВЛЕНИЯ ===');
    
    const newVersion = await ask('Введите новую версию (например, 1.1.0): ');
    const changelog = await ask('Что нового в этой версии?: ');
    
    // 1. Update main.js
    let mainContent = fs.readFileSync('src/main.js', 'utf-8');
    mainContent = mainContent.replace(/const APP_VERSION = '.*?';/, `const APP_VERSION = '${newVersion}';`);
    fs.writeFileSync('src/main.js', mainContent);
    console.log('✓ Версия в src/main.js обновлена');
    
    // 2. Update version.json
    const vJson = JSON.parse(fs.readFileSync('version.json', 'utf-8'));
    vJson.version = newVersion;
    vJson.changelog = changelog;
    fs.writeFileSync('version.json', JSON.stringify(vJson, null, 2));
    console.log('✓ Файл version.json обновлен');
    
    // 3. Git Commit & Push
    try {
        console.log('Отправка данных на GitHub...');
        execSync('git add .');
        execSync(`git commit -m "Release v${newVersion}: ${changelog}"`);
        execSync('git push origin main');
        console.log('✓ Данные успешно отправлены на GitHub!');
    } catch (e) {
        console.error('! Ошибка при работе с Git. Убедитесь, что GitHub Desktop не занят.');
    }
    
    console.log('\n================================================');
    console.log(`ТЕПЕРЬ: Соберите EXE и загрузите его на GitHub в релиз v${newVersion}`);
    console.log('================================================');
    
    rl.close();
}

start();
