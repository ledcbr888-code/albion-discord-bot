// Discord Gateway compatibility fix for Render.
// Use ONLY the non-privileged Guilds intent for the initial Gateway connection.
// This avoids 4013/4014 when privileged intents are not enabled in Discord.
// Slash commands do not require Message Content or Guild Members intents.
//
// If you later enable Message Content Intent in the Discord Developer Portal,
// set ENABLE_MESSAGE_CONTENT=true in Render to restore message-content handling.

const { Client, GatewayIntentBits, IntentsBitField } = require('discord.js');

const originalLogin = Client.prototype.login;

Client.prototype.login = function patchedLogin(token) {
    const allowMessageContent = /^(true|1|yes)$/i.test(
        String(process.env.ENABLE_MESSAGE_CONTENT || '').trim()
    );

    // IMPORTANT: replace the complete intent object instead of trying to mutate
    // its internal bitfield. This guarantees privileged intents are really removed.
    // Guilds is sufficient for slash-command interactions and READY.
    const intents = [GatewayIntentBits.Guilds];

    // MessageCreate is intentionally disabled until the privileged intent is
    // explicitly enabled in Discord Developer Portal and Render.
    if (allowMessageContent) {
        intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    }

    try {
        this.options.intents = new IntentsBitField(intents);
        console.log(
            `🛡️ Gateway intents forced: Guilds=ON, GuildMembers=OFF, MessageContent=${allowMessageContent ? 'ON' : 'OFF'}`
        );
    } catch (err) {
        console.error('❌ Failed to configure Discord Gateway intents:', err.message);
    }

    this.once('ready', () => {
        console.log(`🟢 Discord Gateway READY: ${this.user.tag} (${this.user.id})`);
        console.log(`🏠 Connected guilds: ${this.guilds.cache.size}`);
    });

    this.on('warn', warning => console.warn('⚠️ Discord.js warning:', warning));
    this.on('error', error => console.error('❌ Discord.js client error:', error));
    this.on('debug', info => {
        if (/gateway|identify|4013|4014|disconnect|connect|heartbeat/i.test(info)) {
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

    console.log(`🌐 Starting Discord Gateway login (privileged intents disabled)...`);

    // Let discord.js handle Gateway authentication and reconnects normally.
    return originalLogin.call(this, token);
};
