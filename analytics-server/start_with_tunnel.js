const { spawn } = require('child_process');
const localtunnel = require('localtunnel');

const PORT = 8080;
// We try to grab a unique but permanent subdomain based on username
// You can change 'zapret-stats' to anything unique if this one is taken
const SUBDOMAIN = 'zapret-admin-murzikov-stats'; 

console.log('Запуск локального сервера...');
const server = spawn('node', ['server.js'], { stdio: 'inherit' });

setTimeout(async () => {
    console.log('Подключение к туннелю (LocalTunnel)...');
    try {
        const tunnel = await localtunnel({ 
            port: PORT, 
            subdomain: SUBDOMAIN,
            // To bypass localtunnel's anti-abuse warning page for websockets
            local_host: 'localhost',
            bypass_warning: true 
        });

        console.log('\n======================================================');
        console.log('✅ ТУННЕЛЬ УСПЕШНО СОЗДАН!');
        console.log(`🔗 ССЫЛКА ДЛЯ ПРОГРАММЫ: ${tunnel.url.replace('https://', 'wss://')}`);
        console.log('======================================================\n');
        console.log('-> Скопируйте эту wss:// ссылку.');
        console.log('-> Вставьте её в программе (кнопка Админ) в поле "Адрес сервера".');
        console.log('-> ИЛИ пропишите её в app.js по умолчанию, скомпилируйте EXE и скиньте друзьям.');
        console.log('======================================================\n');

        tunnel.on('close', () => {
            console.log('Туннель закрыт.');
            server.kill();
        });

        tunnel.on('error', (err) => {
            console.error('Ошибка туннеля:', err);
        });

    } catch (e) {
        console.error('Не удалось запустить туннель:', e.message);
        console.log('Попробуйте перезапустить скрипт или сменить SUBDOMAIN в start_with_tunnel.js');
    }
}, 2000); // give the server 2 seconds to start
