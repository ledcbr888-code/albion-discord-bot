// Render/Node network compatibility fix for Discord Gateway.
// Force IPv4 first because some hosting environments can stall on IPv6
// connections to Discord's WebSocket gateway.
const dns = require('node:dns');
try {
    dns.setDefaultResultOrder('ipv4first');
    console.log('🌐 Network fix: DNS result order forced to IPv4 first.');
} catch (err) {
    console.warn('⚠️ Network fix: could not set IPv4-first DNS order:', err.message);
}

// Give Node's HTTP/WebSocket stack a little more visibility without
// changing Discord.js authentication or Gateway behavior.
process.on('warning', warning => {
    console.warn('⚠️ Node warning:', warning.name, warning.message);
});
