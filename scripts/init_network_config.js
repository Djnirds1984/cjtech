const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/network-config.json');
const DATA_DIR = path.dirname(CONFIG_PATH);

const DEFAULT_CONFIG = {
    wan: {
        interface: 'eth0',
        mode: 'dynamic',
        static: {
            ip: '',
            netmask: '255.255.255.0',
            gateway: '',
            dns1: '8.8.8.8',
            dns2: '8.8.4.4'
        },
        pppoe: {
            username: '',
            password: ''
        }
    },
    vlans: [],
    bridges: [
        {
            name: 'br0',
            ip: '10.0.0.1',
            netmask: '255.255.255.0',
            stp: false,
            interfaces: []
        }
    ]
};

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

let config = DEFAULT_CONFIG;
if (fs.existsSync(CONFIG_PATH)) {
    try {
        const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        config = { ...DEFAULT_CONFIG, ...existing };
        if (!config.bridges || config.bridges.length === 0) {
            config.bridges = DEFAULT_CONFIG.bridges;
        }
    } catch (e) {
        console.error("Error reading existing config, overwriting with default");
    }
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log("Network configuration initialized with br0 at", CONFIG_PATH);
