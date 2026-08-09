// Discord Gateway compatibility fix for Render.
// If Message Content Intent is not enabled in the Discord Developer Portal,
// sending it can close the Gateway with 4014 (Disallowed Intents).
// We disable that privileged intent by default so the bot can come online.
// Set ENABLE_MESSAGE_CONTENT=true in Render only after enabling Message Content Intent.

const { Client, GatewayIntentBits } = require('discord.js');

const originalLogin = Client.prototype.login;

Client.prototype.login = function patchedLogin(token) {
    const allowMessageContent = String(process.env.ENABLE_MESSAGE_CONTENT || '').toLowerCase() === 'true';

    try {
        if (!allowMessageContent && this.options?.intents) {
            // MessageContent = 1 << 15. Keep Guilds/GuildMessages and remove only
            // the privileged Message Content intent that commonly causes 4014.
            const before = this.options.intents.bitfield;
            this.options.intents.bitfield &= ~GatewayIntentBits.MessageContent;
            const after = this.options.intents.bitfield;
            if (before !== after) {
                console.log('🛡️ Message Content Intent disabled for Gateway login (ENABLE_MESSAGE_CONTENT is not true).');
            }
        }
    } catch (err) {
        console.warn('⚠️ Could not adjust Discord intents:', err.message);
    }

    this.once('ready', () => {
        console.log(`🟢 Discord Gateway READY: ${this.user.tag} (${this.user.id})`);
    });

    this.on('warn', warning => console.warn('⚠️ Discord.js warning:', warning));
    this.on('error', error => console.error('❌ Discord.js client error:', error));
    this.on('debug', info => {
        if (/gateway|identify|4013|4014|disconnect|connect/i.test(info)) {
            console.log(`🔎 Discord Gateway: ${info}`);
        }
    });
    this.on('shardError', error => console.error('❌ Discord shard error:', error));
    this.on('shardDisconnect', (event, shardId) => {
        console.error(`🔴 Discord shard ${shardId} disconnected: code=${event?.code ?? 'unknown'}`);
    });
    this.on('shardReady', shardId => {
        console.log(`🟢 Discord shard ${shardId} READY`);
    });

    console.log(`🌐 Starting Discord Gateway login (MessageContent=${allowMessageContent ? 'ON' : 'OFF'})...`);

    const loginPromise = originalLogin.call(this, token);
    if (loginPromise?.catch) {
        loginPromise.catch(error => {
            console.error('❌ Discord Gateway login failed:', error?.message || error);
            console.error(error);
        });
    }
    return loginPromise;
};
