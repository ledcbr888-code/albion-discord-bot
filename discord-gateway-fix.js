// Discord Gateway / Discord REST stability patch for Render.
// Loaded before index.js.
// - Retries Discord REST preflight requests when Discord/Cloudflare returns 429.
// - Prevents the custom Gateway watchdog from terminating the Render process.
// - Lets discord.js handle Gateway authentication/reconnect normally.

const { Client } = require('discord.js');
const axios = require('axios');

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

// Discord may temporarily rate-limit the /users/@me preflight request from Render.
// Retry according to Discord's retry_after value instead of immediately exiting.
const originalAxiosGet = axios.get.bind(axios);
axios.get = async function patchedAxiosGet(url, config = {}) {
    const isDiscordMeRequest = /^https:\/\/discord\.com\/api\/v\d+\/users\/@me$/i.test(String(url));
    if (!isDiscordMeRequest) return originalAxiosGet(url, config);

    const maxRetries = 6;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const response = await originalAxiosGet(url, config);

        if (response.status !== 429) return response;

        const retryAfter = Number(response.data?.retry_after) || Number(response.headers?.['retry-after']) || 30;
        const delaySeconds = Math.max(30, Math.ceil(retryAfter));
        originalConsoleError(`⏳ Discord REST rate limited (429). Waiting ${delaySeconds}s before retry ${attempt}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }

    // Return the final response after the retry loop so index.js can report the
    // actual Discord response rather than crashing inside the patch.
    return originalAxiosGet(url, config);
};

// Extra diagnostics for Gateway errors without changing discord.js behavior.
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

originalConsoleError('🛡️ Discord Gateway/REST stability patch loaded.');
