// Discord Gateway compatibility fix for Render.
// The bot only needs Guilds/GuildMessages for slash commands.
// GuildMembers and MessageContent are privileged intents and can cause
// Gateway close code 4014 if they are not enabled for the application.
// MessageContent can be enabled later with ENABLE_MESSAGE_CONTENT=true.

const { Client, GatewayIntentBits } = require('discord.js');

const originalLogin = Client.prototype.login;

Client.prototype.login = function patchedLogin(token) {
    const allowMessageContent = /^(true|1|yes)$/i.test(
        String(process.env.ENABLE_MESSAGE_CONTENT || '').trim()
    );

    try {
        if (this.options?.intents) {
            const before = this.options.intents.bitfield;

            // Always remove GuildMembers: this bot does not use member events/cache.
            this.options.intents.bitfield &= ~GatewayIntentBits.GuildMembers;

            // Remove MessageContent unless explicitly enabled in Render.
            if (!allowMessageContent) {
                this.options.intents.bitfield &= ~GatewayIntentBits.MessageContent;
            }

            const after = this.options.intents.bitfield;
            if (before !== after) {
                console.log(
                    `🛡️ Gateway intents adjusted: GuildMembers=OFF, MessageContent=${allowMessageContent ? 'ON' : 'OFF'}`
                );
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

    console.log(`🌐 Starting Discord Gateway login (MessageContent=${allowMessageContent ? 'ON' : 'OFF'})...`);

    // Let discord.js handle authentication/reconnects normally.
    return originalLogin.call(this, token);
};
