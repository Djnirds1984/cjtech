const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { db } = require('../database/db');

const CONFIG_PATH = path.join(__dirname, '../../data/network-config.json');

// Ensure data directory exists
const dataDir = path.dirname(CONFIG_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Default Configuration
const DEFAULT_CONFIG = {
    wan: {
        interface: 'eth0',
        mode: 'dynamic', // dynamic, static, pppoe
        static: {
            ip: '',
            netmask: '255.255.255.0',
            gateway: '',
            dns1: '8.8.8.8',
            dns2: '8.8.4.4'
        },
        pppoe: {
            username: '',
            password: '',
            dns1: '8.8.8.8',
            dns2: '8.8.4.4'
        }
    },
    vlans: [],
    dhcp: {
        bitmask: 19,
        maxServers: 128,
        servers: []
    },
    bridges: [
        {
            name: 'br0',
            ip: '10.0.0.1',
            netmask: '255.255.255.0',
            stp: true,
            interfaces: [] // Default bridge with no members initially
        }
    ]
};

class NetworkConfigService {
    constructor() {
        // Initialize with default config safely
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    init() {
        this.config = this.loadConfig();
        // Ensure vlans array exists if loading from old config
        if (!this.config.vlans) this.config.vlans = [];
        // Backfill missing VLAN IP/netmask/ipPool for existing configs
        if (Array.isArray(this.config.vlans)) {
            let changed = false;
            this.config.vlans.forEach(v => {
                if (!v.ip || !v.netmask) {
                    try {
                        const generatedIp = this.generateUniqueVlanIp();
                        v.ip = generatedIp;
                        v.netmask = '255.255.255.0';
                        const ipParts = generatedIp.split('.');
                        const prefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
                        v.ipPool = `${prefix}.10-${prefix}.254`;
                        changed = true;
                    } catch (e) {
                        console.error('Failed to backfill VLAN IP for', v, e);
                    }
                }
            });
            if (changed) {
                this.saveConfig(this.config);
            }
        }
        if (!this.config.dhcp) {
            this.config.dhcp = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dhcp));
        } else if (!Array.isArray(this.config.dhcp.servers)) {
            this.config.dhcp.servers = [];
        }
        // Ensure bridges array exists and has default if empty
        if (!this.config.bridges) {
            this.config.bridges = JSON.parse(JSON.stringify(DEFAULT_CONFIG.bridges));
            this.saveConfig(this.config);
        } else if (this.config.bridges.length === 0) {
            // If exists but empty, ensure default br0 is present
             this.config.bridges = JSON.parse(JSON.stringify(DEFAULT_CONFIG.bridges));
             this.saveConfig(this.config);
        }
    }

    loadConfig() {
        let config = null;

        // 1. Try loading from DB first
        try {
            const row = db.prepare("SELECT value FROM settings WHERE key = 'network_config'").get();
            if (row && row.value) {
                config = JSON.parse(row.value);
                console.log('Network config loaded from Database');
            }
        } catch (dbError) {
            console.error('Warning: Failed to load network config from DB, falling back to file:', dbError.message);
        }

        // 2. Fallback to File if DB failed or was empty
        if (!config && fs.existsSync(CONFIG_PATH)) {
            try {
                const data = fs.readFileSync(CONFIG_PATH, 'utf8');
                config = JSON.parse(data);
                console.log('Network config loaded from File');

                // Attempt to seed DB for next time
                try {
                    db.prepare(`
                        INSERT INTO settings (key, value, type, category, updated_at) 
                        VALUES ('network_config', ?, 'json', 'network', CURRENT_TIMESTAMP)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
                    `).run(JSON.stringify(config));
                } catch (seedError) {
                    console.error('Warning: Failed to seed DB with network config:', seedError.message);
                }
            } catch (fileError) {
                console.error('Error loading network config from file:', fileError);
            }
        }

        // 3. Return Config or Default
        if (config) {
            return { ...DEFAULT_CONFIG, ...config };
        } else {
            return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        }
    }

    saveConfig(newConfig) {
        try {
            this.config = { ...this.config, ...newConfig };
            
            // 1. Save to File (Backup/Legacy)
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));

            // 2. Save to Database (Primary)
            db.prepare(`
                INSERT INTO settings (key, value, type, category, updated_at) 
                VALUES ('network_config', ?, 'json', 'network', CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            `).run(JSON.stringify(this.config));

            return true;
        } catch (error) {
            console.error('Error saving network config:', error);
            return false;
        }
    }

    getWanConfig() {
        return this.config.wan;
    }

    async setWanConfig(wanConfig) {
        this.config.wan = { ...this.config.wan, ...wanConfig };
        this.saveConfig(this.config);
        
        console.log('Applying WAN Config:', wanConfig);

        // Update DB for persistence across reboots (for NetworkService)
        try {
            if (wanConfig.interface) {
                 db.prepare("INSERT INTO settings (key, value, category) VALUES ('wan_interface', ?, 'network') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run(wanConfig.interface);
                 console.log('Updated WAN Interface in DB:', wanConfig.interface);
            }
        } catch (e) {
            console.error("Failed to update WAN interface in DB", e);
        }

        // Force write PPPoE config immediately if mode is pppoe
        if (this.config.wan.mode === 'pppoe') {
            const { interface: iface, pppoe } = this.config.wan;
            if (iface && pppoe && pppoe.username && pppoe.password) {
                 const pppoeScript = path.join(__dirname, '../scripts/init_pppoe.sh');
                 const dns1 = pppoe.dns1 || '';
                 const dns2 = pppoe.dns2 || '';
                 
                 console.log('Forcing PPPoE configuration write...');
                 await new Promise((resolve) => {
                     // Ensure executable
                     exec(`chmod +x ${pppoeScript}`);
                     exec(`${pppoeScript} ${iface} "${pppoe.username}" "${pppoe.password}" configure "${dns1}" "${dns2}"`, (err, stdout, stderr) => {
                         if (err) console.error('Failed to write PPPoE config:', stderr || err.message);
                         else console.log('PPPoE config written successfully.');
                         resolve();
                     });
                 });
            }
        }

        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        
        return true;
    }

    getVlans() {
        return this.config.vlans || [];
    }

    async addVlan(vlan) {
        if (!this.config.vlans) this.config.vlans = [];
        if (!vlan.id) vlan.id = Date.now().toString();

        const newVlan = { ...vlan };

        if (!newVlan.name && newVlan.vlanId) {
            newVlan.name = `vlan.${newVlan.vlanId}`;
        }

        // Always ensure a unique MAC is generated if requested or missing, to satisfy "unique MAC generated" requirement
        if (!newVlan.mac) {
            newVlan.mac = this.generateRandomMac();
        }

        // Auto-generate IP, Netmask, and IP Pool for the VLAN
        // Pattern: 10.0.X.1 with /24 and pool X.10-X.254
        try {
            const generatedIp = this.generateUniqueVlanIp();
            newVlan.ip = generatedIp;
            newVlan.netmask = '255.255.255.0';

            const ipParts = generatedIp.split('.');
            const prefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
            if (!newVlan.ipPool) {
                newVlan.ipPool = `${prefix}.10-${prefix}.254`;
            }
        } catch (error) {
            console.error('Error generating VLAN IP:', error);
            throw new Error('Failed to generate unique VLAN IP configuration');
        }

        this.config.vlans.push(newVlan);
        this.saveConfig(this.config);
        console.log('Added VLAN:', newVlan);
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    getDhcpConfig() {
        if (!this.config.dhcp) {
            this.config.dhcp = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dhcp));
        }
        if (!Array.isArray(this.config.dhcp.servers)) {
            this.config.dhcp.servers = [];
        }
        return this.config.dhcp;
    }

    getDhcpServers() {
        const cfg = this.getDhcpConfig();
        return cfg.servers || [];
    }

    async setDhcpGlobals(globals) {
        const cfg = this.getDhcpConfig();
        if (typeof globals.bitmask !== 'undefined') cfg.bitmask = globals.bitmask;
        if (typeof globals.maxServers !== 'undefined') cfg.maxServers = globals.maxServers;
        this.config.dhcp = cfg;
        this.saveConfig(this.config);
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    async addDhcpServer(server) {
        const cfg = this.getDhcpConfig();
        const newServer = { ...server };
        if (!newServer.id) newServer.id = Date.now().toString();
        if (!Array.isArray(cfg.servers)) cfg.servers = [];

        const iface = newServer.interface;
        if (iface && iface.includes('.')) {
            const parts = iface.split('.');
            let parent = parts[0];
            const vlanId = parts[1];

            // Map eth0 back to end0 for consistency with VLAN config
            if (parent === 'eth0') parent = 'end0';

            if (!this.config.vlans) this.config.vlans = [];
            const hasVlan = this.config.vlans.some(v => v.parent === parent && String(v.vlanId) === String(vlanId));

            if (!hasVlan && newServer.ip) {
                let ipPool;
                if (newServer.poolStart && newServer.poolEnd) {
                    ipPool = `${newServer.poolStart}-${newServer.poolEnd}`;
                } else {
                    const ipParts = newServer.ip.split('.');
                    const prefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
                    ipPool = `${prefix}.10-${prefix}.254`;
                }

                const vlan = {
                    id: Date.now().toString() + '_vlan',
                    parent,
                    vlanId,
                    name: `vlan.${vlanId}`,
                    ip: newServer.ip,
                    netmask: newServer.netmask || '255.255.255.0',
                    ipPool,
                    dns1: newServer.dns1,
                    dns2: newServer.dns2
                };

                this.config.vlans.push(vlan);
            }
        }

        cfg.servers.push(newServer);
        this.config.dhcp = cfg;
        this.saveConfig(this.config);
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    async removeDhcpServer(id) {
        const cfg = this.getDhcpConfig();
        cfg.servers = (cfg.servers || []).filter(s => s.id !== id);
        this.config.dhcp = cfg;
        this.saveConfig(this.config);
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    generateUniqueVlanIp() {
        const usedIps = new Set();
        if (this.config.bridges) this.config.bridges.forEach(b => usedIps.add(b.ip));
        if (this.config.vlans) this.config.vlans.forEach(v => usedIps.add(v.ip));

        let ip;
        let attempts = 0;
        do {
            // Generate random 3rd octet between 1 and 254 (avoiding 0 if possible, though 10.0.0.1 is usually taken)
            // Let's use range 10-250 to be safe and distinct from main network often at .0 or .1
            const thirdOctet = Math.floor(Math.random() * (250 - 2 + 1)) + 2; 
            ip = `10.0.${thirdOctet}.1`;
            attempts++;
        } while (usedIps.has(ip) && attempts < 100);

        if (attempts >= 100) throw new Error("Unable to find free IP subnet in 10.0.X.1 range");
        return ip;
    }

    generateRandomMac() {
        const bytes = [];
        for (let i = 0; i < 6; i++) {
            bytes.push(Math.floor(Math.random() * 256));
        }
        bytes[0] = (bytes[0] | 2) & 254;
        return bytes.map(b => b.toString(16).padStart(2, '0')).join(':');
    }

    async removeVlan(vlanId) {
        if (!this.config.vlans) return false;

        const vlan = this.config.vlans.find(v => v.id === vlanId);
        if (!vlan) return false;

        const ifaceName = `${vlan.parent}.${vlan.vlanId}`;

        const dhcpCfg = this.getDhcpConfig();
        dhcpCfg.servers = (dhcpCfg.servers || []).filter(s => s.interface !== ifaceName);
        this.config.dhcp = dhcpCfg;

        this.config.vlans = this.config.vlans.filter(v => v.id !== vlanId);
        this.saveConfig(this.config);
        console.log('Removed VLAN:', vlanId, 'and cleaned DHCP/interface for', ifaceName);

        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    async addBridge(bridge) {
        if (!this.config.bridges) this.config.bridges = [];
        if (this.config.bridges.find(b => b.name === bridge.name)) {
            throw new Error(`Bridge ${bridge.name} already exists`);
        }
        
        bridge.stp = bridge.stp !== undefined ? !!bridge.stp : true;
        bridge.interfaces = bridge.interfaces || [];
        
        this.config.bridges.push(bridge);
        this.saveConfig(this.config);
        console.log('Added Bridge:', bridge);
        
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    async removeBridge(name) {
        if (!this.config.bridges) return false;
        
        const initialLength = this.config.bridges.length;
        this.config.bridges = this.config.bridges.filter(b => b.name !== name);
        
        if (this.config.bridges.length === initialLength) {
            throw new Error("Bridge not found");
        }
        
        this.saveConfig(this.config);
        console.log('Removed Bridge:', name);
        
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    async updateBridge(name, newConfig) {
        if (!this.config.bridges) return false;
        
        const index = this.config.bridges.findIndex(b => b.name === name);
        if (index === -1) {
            throw new Error("Bridge not found");
        }
        
        const bridge = this.config.bridges[index];
        bridge.ip = newConfig.ip;
        bridge.netmask = newConfig.netmask;
        bridge.stp = !!newConfig.stp;
        bridge.interfaces = newConfig.interfaces || [];
        
        // Handle name change if needed (careful with existing references)
        if (newConfig.name && newConfig.name !== name) {
            if (this.config.bridges.find(b => b.name === newConfig.name)) {
                throw new Error(`Bridge ${newConfig.name} already exists`);
            }
            bridge.name = newConfig.name;
        }

        this.config.bridges[index] = bridge;
        this.saveConfig(this.config);
        console.log('Updated Bridge:', bridge);
        
        try {
            await this.applyNetworkChanges();
        } catch (e) {
            console.error("Failed to apply changes", e);
        }
        return true;
    }

    getBridges() {
        if (!this.config.bridges || this.config.bridges.length === 0) {
             // Fallback to default if missing (should be handled in constructor, but double check)
             return [{
                name: 'br0',
                ip: '10.0.0.1',
                netmask: '255.255.255.0',
                stp: true,
                interfaces: []
            }];
        }
        return this.config.bridges;
    }

    async applyNetworkChanges() {
        if (os.platform() === 'win32') {
            console.log('Windows detected: Skipping actual network application.');
            console.log('Generated Netplan Config:\n', this.generateNetplanConfig());
            return;
        }

        try {
            const netplanConfig = this.generateNetplanConfig();
            const netplanPath = '/etc/netplan/01-pisowifi.yaml';
            
            // Write Netplan file
            fs.writeFileSync(netplanPath, netplanConfig);
            
            // Write Routing Script (Policy Routing for Multi-WAN)
            const routeScriptPath = path.join(__dirname, '../scripts/setup_wan_routes.sh');
            const routeScriptContent = this.generateRoutingScript();
            fs.writeFileSync(routeScriptPath, routeScriptContent);
            fs.chmodSync(routeScriptPath, '755');

            const vlanDhcpDir = '/etc/dnsmasq.d';
            const vlanDhcpPath = path.join(vlanDhcpDir, 'pisowifi-dhcp.conf');
            try {
                fs.mkdirSync(vlanDhcpDir, { recursive: true });
            } catch (e) {}

            const dhcpCfg = this.getDhcpConfig();
            const servers = dhcpCfg.servers || [];
            let dhcpConf = '';
            let portalIp = '10.0.0.1';
            const bridges = this.config.bridges || [];
            if (bridges.length > 0) {
                const br0 = bridges.find(b => b.name === 'br0') || bridges[0];
                if (br0 && br0.ip) portalIp = br0.ip;
            }

            servers.forEach(s => {
                if (!s || !s.interface || !s.ip || !s.poolStart || !s.poolEnd) return;

                const iface = s.interface;
                const gateway = s.ip;
                const start = s.poolStart;
                const end = s.poolEnd;
                const netmask = s.netmask || '255.255.255.0';
                dhcpConf += `dhcp-range=interface:${iface},${start},${end},${netmask},12h\n`;
                dhcpConf += `dhcp-option=interface:${iface},3,${gateway}\n`;
                dhcpConf += `dhcp-option=interface:${iface},6,${portalIp}\n`;
                dhcpConf += `dhcp-option=interface:${iface},114,http://${portalIp}/portal\n`;
            });

            const definedIfaces = new Set(servers.map(s => {
                if (!s || !s.interface) return '';
                return s.interface;
            }).filter(Boolean));
            const vlansFallback = this.config.vlans || [];
            vlansFallback.forEach(v => {
                if (!v || !v.parent || !v.vlanId || !v.ip) return;
                const iface = `${v.parent}.${v.vlanId}`;
                if (definedIfaces.has(iface)) return;
                const netmask = v.netmask || '255.255.255.0';
                let poolStart = null, poolEnd = null;
                if (v.ipPool && typeof v.ipPool === 'string' && v.ipPool.includes('-')) {
                    const parts = v.ipPool.split('-');
                    poolStart = parts[0];
                    poolEnd = parts[1];
                } else {
                    const ipParts = v.ip.split('.');
                    const prefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
                    poolStart = `${prefix}.10`;
                    poolEnd = `${prefix}.254`;
                }
                const gateway = v.ip;
                dhcpConf += `dhcp-range=interface:${iface},${poolStart},${poolEnd},${netmask},12h\n`;
                dhcpConf += `dhcp-option=interface:${iface},3,${gateway}\n`;
                dhcpConf += `dhcp-option=interface:${iface},6,${portalIp}\n`;
                dhcpConf += `dhcp-option=interface:${iface},114,http://${portalIp}/portal\n`;
            });

            if (dhcpConf) {
                fs.writeFileSync(vlanDhcpPath, dhcpConf);
            } else if (fs.existsSync(vlanDhcpPath)) {
                fs.unlinkSync(vlanDhcpPath);
            }

            try {
                const vlans = this.config.vlans || [];
                const commands = ['modprobe 8021q || true'];

                if (vlans.length === 0) {
                    commands.push(
                        "for dev in $(ip -o link show type vlan | awk -F': ' '{print $2}' | cut -d'@' -f1); do ip link delete \"$dev\" || true; done"
                    );
                } else {
                    const keepNames = new Set();
                    vlans.forEach(v => {
                        if (!v.parent || !v.vlanId) return;
                        const vlanName = `${v.parent}.${v.vlanId}`;
                        keepNames.add(vlanName);
                    });

                    const keepList = Array.from(keepNames).join(' ');
                    if (keepList) {
                        commands.push(
                            `for dev in $(ip -o link show type vlan | awk -F': ' '{print $2}' | cut -d'@' -f1); do keep=0; for k in ${keepList}; do [ "$dev" = "$k" ] && keep=1 && break; done; [ "$keep" -eq 0 ] && ip link delete "$dev" || true; done`
                        );
                    }

                    vlans.forEach(v => {
                        if (!v.parent || !v.vlanId || !v.ip || !v.netmask) return;
                        const vlanName = `${v.parent}.${v.vlanId}`;
                        const cidr = this.netmaskToCidr(v.netmask);
                        commands.push(
                            `ip link show ${vlanName} >/dev/null 2>&1 || ip link add link ${v.parent} name ${vlanName} type vlan id ${v.vlanId}`,
                            v.mac ? `ip link set dev ${vlanName} address ${v.mac} || true` : '',
                            `ip addr flush dev ${vlanName} || true`,
                            `ip addr add ${v.ip}/${cidr} dev ${vlanName} || true`,
                            `ip link set ${vlanName} up || true`
                        );
                    });
                }

                if (commands.length > 1) {
                    const vlanCmd = commands.join(' && ');
                    exec(vlanCmd, (error, stdout, stderr) => {
                        if (error) {
                            console.error('Failed to apply VLAN runtime config:', error);
                            if (stderr) console.error('VLAN stderr:', stderr);
                        } else if (stdout) {
                            console.log('VLAN runtime config output:', stdout);
                        }
                    });
                }
            } catch (e) {
                console.error('Error preparing VLAN runtime config:', e);
            }

            console.log('Netplan config written. Scheduling apply...');

            setTimeout(() => {
                console.log('Executing: netplan apply');
                const firewallScriptPath = path.join(__dirname, '../scripts/init_firewall.sh');
                let portalIp = '10.0.0.1';
                const bridges = this.config.bridges || [];
                if (bridges.length > 0) {
                    const br0 = bridges.find(b => b.name === 'br0') || bridges[0];
                    if (br0 && br0.ip) portalIp = br0.ip;
                }
                let wanIf = 'eth0';
                try {
                    const row = db.prepare("SELECT value FROM settings WHERE key = 'wan_interface'").get();
                    if (row && row.value) wanIf = row.value;
                } catch (e) {}
                if (this.config.wan && this.config.wan.mode === 'pppoe') {
                    wanIf = 'ppp0';
                }
                const cmd = `netplan apply && (systemctl restart dnsmasq || /etc/init.d/dnsmasq restart) && ${firewallScriptPath} ${wanIf} ${portalIp} && ${routeScriptPath} && npm start`;
                exec(cmd, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Command error: ${error}`);
                        console.error(`Stderr: ${stderr}`);
                    } else {
                        console.log('Network changes applied and system started.');
                    }
                });
            }, 5000); // 5 second delay
            
            return true;
        } catch (error) {
            console.error('Failed to prepare network changes:', error);
            throw error;
        }
    }

    generateRoutingScript() {
        const wan = this.config.wan;
        let wanItems = [];
        let strategy = 'failover'; // Default

        if (wan.mode === 'dual_wan' && wan.dual_wan) {
             strategy = wan.dual_wan.strategy || 'failover';
             if (wan.dual_wan.wan1 && wan.dual_wan.wan1.interface) wanItems.push({ ...wan.dual_wan.wan1, id: 1, weight: 1 });
             if (wan.dual_wan.wan2 && wan.dual_wan.wan2.interface) wanItems.push({ ...wan.dual_wan.wan2, id: 2, weight: 1 });
        } else if (wan.mode === 'multi_wan' && Array.isArray(wan.multi_wan)) {
             strategy = 'balance-rr'; // Multi-WAN defaults to balancing usually
             wanItems = wan.multi_wan.filter(w => w.interface).map((w, i) => ({ ...w, id: i + 1, weight: w.weight || 1 }));
        }

        if (wanItems.length <= 1) return '#!/bin/bash\n# Single WAN - No special routing needed\nexit 0';

        // Script Header
        let script = `#!/bin/bash
# Auto-generated routing script for Multi-WAN
# Ensures return traffic goes out the correct interface (Policy Routing)
# AND starts the Active Health Check Monitor

MONITOR_SCRIPT="/usr/local/bin/pisowifi-wan-monitor.sh"
LOG_FILE="/var/log/pisowifi/wan-monitor.log"
mkdir -p /var/log/pisowifi

# Wait for interfaces to be up
sleep 5

# Enable IP Forwarding
sysctl -w net.ipv4.ip_forward=1

# --- 1. Static Policy Routing Setup (Tables & Rules) ---
# Flush existing custom tables to avoid duplicates
`;

        // Flush tables loop
        wanItems.forEach(item => {
            script += `ip rule flush table ${100 + item.id}\n`;
            script += `ip route flush table ${100 + item.id}\n`;
        });

        script += `\n# Configure per-interface routing tables\n`;

        wanItems.forEach(item => {
            const tableId = 100 + item.id;
            const iface = item.interface;
            
            script += `\n# --- WAN ${item.id}: ${iface} ---\n`;
            script += `IP_${item.id}=$(ip -4 addr show ${iface} | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | head -n 1)\n`;
            // Try to get dynamic gateway first
            script += `GW_${item.id}=$(ip route show dev ${iface} | grep default | awk '{print $3}' | head -n 1)\n`;
            
            // Override if static
            if (item.mode === 'static' && item.static && item.static.gateway) {
                 script += `GW_${item.id}="${item.static.gateway}"\n`;
            }

            script += `if [ -n "$IP_${item.id}" ] && [ -n "$GW_${item.id}" ]; then\n`;
            script += `  echo "Configuring Table ${tableId} for ${iface} ($IP_${item.id} -> $GW_${item.id})"\n`;
            script += `  ip route add default via $GW_${item.id} dev ${iface} table ${tableId}\n`;
            script += `  ip rule add from $IP_${item.id} table ${tableId}\n`;
            script += `fi\n`;
        });

        // --- 2. Generate Monitor Script ---
        script += `\n# --- 2. Generate & Start Active Health Monitor ---\n`;
        script += `cat << 'EOF' > $MONITOR_SCRIPT
#!/bin/bash
# Multi-WAN Active Health Monitor
# Generated by PisoWifi

CHECK_TARGET="8.8.8.8"
CHECK_TARGET_2="1.1.1.1"
INTERVAL=5
STRATEGY="${strategy}"

# Function to check connectivity
check_iface() {
    local iface=$1
    # Try primary target, fallback to secondary
    ping -I $iface -c 1 -W 2 $CHECK_TARGET > /dev/null 2>&1 || ping -I $iface -c 1 -W 2 $CHECK_TARGET_2 > /dev/null 2>&1
    return $?
}

while true; do
    CMD="ip route replace default scope global"
    VALID_COUNT=0
    
    # Check each interface
`;

        // Inject interface checks
        wanItems.forEach(item => {
            script += `    # Check ${item.interface} (Weight: ${item.weight})\n`;
            script += `    IP_${item.id}=$(ip -4 addr show ${item.interface} | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | head -n 1)\n`;
            script += `    GW_${item.id}=$(ip route show dev ${item.interface} | grep default | awk '{print $3}' | head -n 1)\n`;
            // Static Gateway Override in Monitor (need to inject value if static)
            if (item.mode === 'static' && item.static && item.static.gateway) {
                script += `    GW_${item.id}="${item.static.gateway}"\n`;
            }
            
            // We ping using the Source IP to trigger Policy Routing (Table 10x) which has the gateway
            script += `    if [ -n "$IP_${item.id}" ] && [ -n "$GW_${item.id}" ] && check_iface $IP_${item.id}; then\n`;
            script += `        STATUS_${item.id}="UP"\n`;
            script += `    else\n`;
            script += `        STATUS_${item.id}="DOWN"\n`;
            script += `    fi\n\n`;
        });

        // Route Construction Logic based on Strategy
        script += `    # Construct Route Command based on Strategy\n`;
        
        if (strategy === 'failover') {
            script += `    # FAILOVER: Pick first UP interface\n`;
            script += `    SELECTED=0\n`;
            
            wanItems.forEach(item => {
                script += `    if [ "$SELECTED" -eq 0 ] && [ "$STATUS_${item.id}" == "UP" ]; then\n`;
                script += `        CMD="$CMD nexthop via $GW_${item.id} dev ${item.interface} weight 1"\n`;
                script += `        SELECTED=1\n`;
                script += `        VALID_COUNT=1\n`;
                script += `    fi\n`;
            });
            
        } else {
            // Load Balancing (Weighted Round Robin)
            script += `    # LOAD BALANCING: Add all UP interfaces\n`;
            
            wanItems.forEach(item => {
                script += `    if [ "$STATUS_${item.id}" == "UP" ]; then\n`;
                script += `        CMD="$CMD nexthop via $GW_${item.id} dev ${item.interface} weight ${item.weight}"\n`;
                script += `        VALID_COUNT=$((VALID_COUNT+1))\n`;
                script += `    fi\n`;
            });
        }

        script += `
    # Apply Routes if we have valid gateways
    if [ "$VALID_COUNT" -gt 0 ]; then
        # We only apply if something changed? For now, re-applying ensures correctness
        # echo "Applying: $CMD"
        eval $CMD
    else
        echo "ALL WAN INTERFACES DOWN!"
    fi

    sleep $INTERVAL
done
EOF
`;

        script += `\n# --- 3. Launch Monitor ---\n`;
        script += `chmod +x $MONITOR_SCRIPT\n`;
        script += `pkill -f "pisowifi-wan-monitor.sh"\n`; // Kill old instance
        script += `nohup $MONITOR_SCRIPT > /dev/null 2>&1 &\n`;
        script += `echo "Monitor started in background."\n`;

        return script;
    }

    generateNetplanConfig() {
        const wan = this.config.wan;
        const vlans = this.config.vlans || [];
        const bridges = this.config.bridges || [];
        
        const config = {
            network: {
                version: 2,
                renderer: 'networkd',
                ethernets: {},
                vlans: {},
                bridges: {}
            }
        };

        // Helper to check if interface is used in a bridge
        const isBridged = (ifaceName) => {
            return bridges.some(b => b.interfaces.includes(ifaceName));
        };

        // Collect WAN interfaces to configure
        let wanItems = [];
        let strategy = 'failover'; // Default for Dual WAN

        if (wan.mode === 'dual_wan' && wan.dual_wan) {
             strategy = wan.dual_wan.strategy || 'failover';
             if (wan.dual_wan.wan1 && wan.dual_wan.wan1.interface) wanItems.push({ ...wan.dual_wan.wan1, role: 'wan1' });
             if (wan.dual_wan.wan2 && wan.dual_wan.wan2.interface) wanItems.push({ ...wan.dual_wan.wan2, role: 'wan2' });
        } else if (wan.mode === 'multi_wan' && Array.isArray(wan.multi_wan)) {
             // Multi-WAN defaults to balancing
             strategy = 'balance-rr';
             wanItems = wan.multi_wan.filter(w => w.interface);
        } else if (wan.interface) {
             wanItems.push({ ...wan, role: 'single' });
        }

        // 1. Configure WAN Interfaces (Physical)
        wanItems.forEach((item, index) => {
            const ifaceName = item.interface;
            const isVlan = ifaceName.includes('.');
            
            // Calculate Metric
            let metric = 100; // Default
            if (strategy === 'failover') {
                // Wan1=100, Wan2=200, etc.
                metric = 100 + (index * 100); 
            } else {
                // Balance-RR / Load Balancing: All 100 (ECMP)
                // Unless "Weight" is implemented via script, we keep ECMP here
                metric = 100;
            }

            const ifaceConfig = this.getInterfaceConfig(item, metric);

            if (isVlan) {
                const parent = ifaceName.split('.')[0];
                // Ensure parent exists if not bridged
                if (!isBridged(parent) && !config.network.ethernets[parent]) {
                     config.network.ethernets[parent] = { dhcp4: false, dhcp6: false };
                }
            } else {
                // Physical Interface
                if (!isBridged(ifaceName)) {
                    config.network.ethernets[ifaceName] = ifaceConfig;
                } else {
                    // Bridged interface must be manual
                    config.network.ethernets[ifaceName] = { dhcp4: false, dhcp6: false };
                }
            }
        });

        // 2. Configure VLANs
        vlans.forEach(v => {
            const vlanName = `${v.parent}.${v.vlanId}`;
            const normalizedParent = v.parent;
            if (!config.network.ethernets[normalizedParent]) {
                config.network.ethernets[normalizedParent] = { dhcp4: false, dhcp6: false };
            }

            let vlanConfig = {
                id: parseInt(v.vlanId),
                link: normalizedParent
            };

            if (v.mac) {
                vlanConfig.macaddress = v.mac;
            }

            // Assign static address for non-WAN VLANs based on stored IP/netmask
            if (v.ip && v.netmask) {
                const cidr = this.netmaskToCidr(v.netmask);
                vlanConfig.addresses = [`${v.ip}/${cidr}`];
                if (v.dns1 || v.dns2) {
                    vlanConfig.nameservers = {
                        addresses: [v.dns1, v.dns2].filter(Boolean)
                    };
                }
            }
            
            const wanItem = wanItems.find(w => w.interface === vlanName);
            if (wanItem) {
                const index = wanItems.indexOf(wanItem);
                let metric = 100;
                if (strategy === 'failover') metric = 100 + (index * 100);
                
                const wanCfg = this.getInterfaceConfig(wanItem, metric);
                vlanConfig = { ...vlanConfig, ...wanCfg };
                vlanConfig.id = parseInt(v.vlanId);
                vlanConfig.link = normalizedParent;
                if (v.mac) {
                    vlanConfig.macaddress = v.mac;
                }
                // Ensure VLAN keeps its configured IP if present
                if (v.ip && v.netmask) {
                    const cidr = this.netmaskToCidr(v.netmask);
                    vlanConfig.addresses = [`${v.ip}/${cidr}`];
                }
            }

            config.network.vlans[vlanName] = vlanConfig;
        });

        // 3. Configure Bridges
        bridges.forEach(b => {
            // Ensure all member interfaces are defined in ethernets
            b.interfaces.forEach(iface => {
                if (!config.network.ethernets[iface]) {
                    config.network.ethernets[iface] = { dhcp4: false, dhcp6: false };
                } else {
                    config.network.ethernets[iface] = { dhcp4: false, dhcp6: false };
                }
            });

            const bridgeConfig = {
                interfaces: b.interfaces,
                parameters: {
                    stp: !!b.stp,
                    'forward-delay': 4
                }
            };

            if (b.ip && b.netmask) {
                bridgeConfig.addresses = [`${b.ip}/${this.netmaskToCidr(b.netmask)}`];
                bridgeConfig.dhcp4 = false;
            } else {
                bridgeConfig.dhcp4 = false;
            }

            config.network.bridges[b.name] = bridgeConfig;
        });

        // Clean up empty objects
        if (Object.keys(config.network.vlans).length === 0) delete config.network.vlans;
        if (Object.keys(config.network.bridges).length === 0) delete config.network.bridges;

        return this.jsonToYaml(config);
    }

    getInterfaceConfig(settings, metric = 100) {
        const mode = settings.mode || settings.type || 'dynamic';
        
        if (mode === 'dynamic') {
            return { 
                dhcp4: true,
                'dhcp4-overrides': {
                    'route-metric': metric
                }
            };
        } else if (mode === 'static') {
            if (!settings.static) return { dhcp4: true };
            const cidr = this.netmaskToCidr(settings.static.netmask || '255.255.255.0');
            const cfg = {
                dhcp4: false,
                addresses: [`${settings.static.ip || '0.0.0.0'}/${cidr}`]
            };
            
            // Use routes list instead of gateway4 to support metric
            if (settings.static.gateway) {
                cfg.routes = [{
                    to: '0.0.0.0/0',
                    via: settings.static.gateway,
                    metric: metric
                }];
            }

            if (settings.static.dns1 || settings.static.dns2) {
                const dns = [];
                if (settings.static.dns1) dns.push(settings.static.dns1);
                if (settings.static.dns2) dns.push(settings.static.dns2);
                if (settings.static.dns) dns.push(settings.static.dns); 
                
                if (dns.length > 0) {
                    cfg.nameservers = { addresses: dns };
                }
            }
            return cfg;
        } else if (mode === 'pppoe') {
             // For PPPoE, physical interface is unconfigured
             return { dhcp4: false, dhcp6: false, optional: true };
        }
        return { dhcp4: true };
    }

    netmaskToCidr(netmask) {
        return (netmask.split('.').map(Number)
          .map(part => (part >>> 0).toString(2))
          .join('')).split('1').length - 1;
    }

    jsonToYaml(obj, indent = 0) {
        let yaml = '';
        const spaces = ' '.repeat(indent);
        
        for (const key in obj) {
            const value = obj[key];
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                yaml += `${spaces}${key}:\n${this.jsonToYaml(value, indent + 2)}`;
            } else if (Array.isArray(value)) {
                yaml += `${spaces}${key}: [${value.join(', ')}]\n`;
            } else {
                yaml += `${spaces}${key}: ${value}\n`;
            }
        }
        return yaml;
    }
}

module.exports = new NetworkConfigService();
