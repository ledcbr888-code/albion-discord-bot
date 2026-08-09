// Discord Gateway stability patch for Render.
// Loaded before index.js to keep the Render process alive while Discord
// Gateway is reconnecting instead of terminating on the custom watchdog.

const { Client } = require('discord.js');

const originalExit = process.exit.bind(process);
let ignoreGatewayWatchdog = false;

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
    const text = args.map(v => String(v)).join(' ');
    if (/Discord Gateway timeout: READY was not received/i.test(text)) {
        ignoreGatewayWatchdog = true;
        originalConsoleError(...args);
        originalConsoleError('⚠️ Gateway watchdog ignored; Discord.js will keep the process alive for reconnects.');
        return;
    }
    originalConsoleError(...args);
};

process.exit = (code = 0) => {
    if (ignoreGatewayWatchdog && Number(code) !== 0) {
        originalConsoleError('⚠️ Prevented process exit caused by the custom Discord Gateway watchdog.');
        return;
    }
    return originalExit(code);
};

const originalLogin = Client.prototype.login;
Client.prototype.login = function patchedLogin(token) {
    const client = this;
    let attempts = 0;
    const maxAttempts = 8;

    const tryLogin = async () => {
        attempts += 1;
        try {
            originalConsoleError(`🔁 Discord Gateway login attempt ${attempts}/${maxAttempts}...`);
            return await originalLogin.call(client, token);
        } catch (err) {
            originalConsoleError(`❌ Discord login attempt ${attempts} failed: ${err?.message || err}`);
            if (attempts >= maxAttempts) throw err;
            const delay = Math.min(30000, 5000 * attempts);
            originalConsoleError(`⏳ Retrying Discord login in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            try { client.destroy(); } catch (_) {}
            return tryLogin();
        }
    };

    return tryLogin();
};

process.on('SIGTERM', () => originalExit(0));
process.on('SIGINT', () => originalExit(0));

originalConsoleError('🛡️ Discord Gateway stability patch loaded.');
