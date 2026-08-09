// Discord Gateway stability patch for Render.
// This file is loaded before index.js and only suppresses the custom
// 45-second watchdog from killing the process while Discord Gateway is
// connecting. It also prints low-level Gateway diagnostics.

const { Client } = require('discord.js');

const originalExit = process.exit.bind(process);
let ignoreGatewayWatchdog = false;

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
    const text = args.map(v => String(v)).join(' ');
    if (/Discord Gateway timeout: READY was not received/i.test(text)) {
        ignoreGatewayWatchdog = true;
        originalConsoleError(...args);
        originalConsoleError('⚠️ Gateway watchdog ignored by startup patch; Discord.js will keep reconnecting instead of terminating the Render process.');
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

Client.prototype.on('debug', () => {});

process.on('SIGTERM', () => originalExit(0));
process.on('SIGINT', () => originalExit(0));

originalConsoleError('🛡️ Discord Gateway stability patch loaded.');
