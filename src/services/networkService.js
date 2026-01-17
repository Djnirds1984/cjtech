const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db'); // Import DB
const networkConfigService = require('./networkConfigService');
const execPromise = util.promisify(exec);

class NetworkService {
    constructor() {
        this.interface = 'wlan0'; 
        this.wanInterface = 'eth0'; // Default fallback
        this._activeConnCache = new Set();
        this._activeConnCacheTime = 0;
        this._arpIfaceCache = new Map();
        this._arpIfaceCacheTime = 0;
    }

    async runCommand(command, silent = false) {
        try {
            const { stdout, stderr } = await execPromise(command);
            if (stderr && !silent) console.error(`Command stderr: ${stderr}`);
            return stdout.trim();
        } catch (error) {
            if (!silent) console.error(`Command failed: ${command}`, error);
            // Don't throw for everything, as ARP lookups might fail harmlessly
            return null;
        }
    }

    /**
     * Detect WAN Interface (Default Gateway)
     * Prioritizes DB setting, then auto-detection
     */
    async detectWanInterface() {
        try {
            // 1. Check DB for saved WAN interface
            const savedWan = db.prepare("SELECT value FROM settings WHERE key = 'wan_interface'").get();
            if (savedWan && savedWan.value) {
                this.wanInterface = savedWan.value;
                console.log(`Loaded WAN Interface from DB: ${this.wanInterface}`);
                return this.wanInterface;
            }

            // 2. Auto-detect if no DB setting
            // "ip route show default" typically outputs: "default via 192.168.1.1 dev eth0 proto dhcp ..."
            const output = await this.runCommand('ip route show default');
            if (output) {
                // Regex to find "dev <interface>"
                const match = output.match(/dev\s+(\S+)/);
                if (match && match[1]) {
                    this.wanInterface = match[1];
                    console.log(`Auto-detected WAN Interface: ${this.wanInterface}`);
                    
                    // Save to DB for future persistence
                    this.saveWanInterface(this.wanInterface);
                    
                    return this.wanInterface;
                }
            }
        } catch (e) {
            console.error('Failed to detect WAN interface:', e);
        }
        console.log(`Using fallback WAN Interface: ${this.wanInterface}`);
        return this.wanInterface;
    }

    /**
     * Save WAN Interface to DB
     */
    saveWanInterface(interfaceName) {
        try {
            db.prepare(`
                INSERT INTO settings (key, value, category) 
                VALUES ('wan_interface', ?, 'network')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            `).run(interfaceName);
            console.log(`Saved WAN Interface to DB: ${interfaceName}`);
            this.wanInterface = interfaceName;
        } catch (e) {
            console.error('Failed to save WAN interface to DB:', e);
        }
    }

    /**
     * Detect LAN/WiFi Interface
     */
    async detectLanInterface() {
        try {
            const output = await this.runCommand('ls /sys/class/net/');
            if (output) {
                const interfaces = output.split(/\s+/);
                // Prioritize WiFi interfaces
                for (const iface of interfaces) {
                    if (iface.startsWith('wlan') || iface.startsWith('wlx')) {
                        this.interface = iface;
                        console.log(`Auto-detected LAN/WiFi Interface: ${this.interface}`);
                        return this.interface;
                    }
                }
            }
        } catch (e) {
            console.error('Failed to detect LAN interface:', e);
        }
        console.log('No WiFi interface detected. Assuming Ethernet/Bridge mode.');
        return null;
    }

    /**
     * Snapshot active connections for all IPs (Linux)
     * Caches for 5 seconds to avoid repeated heavy scans
     */
    async getActiveConnectionsSnapshot() {
        const now = Date.now();
        if (now - this._activeConnCacheTime < 5000 && this._activeConnCache && this._activeConnCache.size > 0) {
            return this._activeConnCache;
        }

        const set = new Set();
        try {
            if (process.platform === 'linux') {
                const pathPrimary = '/proc/net/nf_conntrack';
                const pathFallback = '/proc/net/ip_conntrack';
                const targetPath = fs.existsSync(pathPrimary) ? pathPrimary : (fs.existsSync(pathFallback) ? pathFallback : null);
                if (targetPath) {
                    const content = await fs.promises.readFile(targetPath, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        if (!line) continue;
                        // Only consider established TCP or any UDP (activity)
                        if (!(line.includes('ESTABLISHED') || line.includes('udp'))) continue;
                        const m = line.match(/src=([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/);
                        if (m && m[1]) set.add(m[1]);
                    }
                }
            } else if (process.platform === 'win32') {
                // Lightweight fallback: parse netstat once
                const out = await this.runCommand('netstat -n', true);
                if (out) {
                    const lines = out.split('\n');
                    for (const line of lines) {
                        // Foreign Address column often contains IP:PORT
                        const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}):\d+/);
                        if (m && m[1]) set.add(m[1]);
                    }
                }
            }
        } catch (e) {
            // Silent fail, return whatever collected
        }

        this._activeConnCache = set;
        this._activeConnCacheTime = now;
        return set;
    }

    async getArpInterfacesMap() {
        const now = Date.now();
        if (now - this._arpIfaceCacheTime < 5000 && this._arpIfaceCache && this._arpIfaceCache.size > 0) {
            return this._arpIfaceCache;
        }
        const map = new Map();
        try {
            if (process.platform === 'linux') {
                const p = '/proc/net/arp';
                if (fs.existsSync(p)) {
                    const content = await fs.promises.readFile(p, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 6) {
                            const ip = parts[0];
                            const dev = parts[5];
                            if (ip && dev) map.set(ip, dev);
                        }
                    }
                }
            }
        } catch (e) {}
        this._arpIfaceCache = map;
        this._arpIfaceCacheTime = now;
        return map;
    }

    async getInterfaceForIp(ip) {
        if (!ip) return null;
        if (ip.startsWith('::ffff:')) ip = ip.substring(7);
        try {
            const arpMap = await this.getArpInterfacesMap();
            if (arpMap.has(ip)) return arpMap.get(ip);
            const neigh = await this.runCommand(`ip neigh show ${ip}`, true);
            if (neigh) {
                const m = neigh.match(/dev\s+(\S+)/);
                if (m && m[1]) return m[1];
            }
        } catch (e) {}
        return null;
    }

    formatInterfaceLabel(iface) {
        if (!iface) return '-';
        if (iface.startsWith('br')) return `Bridge (${iface})`;
        if (iface.includes('.')) return `VLAN (${iface})`;
        if (iface.startsWith('wlan') || iface.startsWith('wlx')) return `WiFi (${iface})`;
        if (iface.startsWith('eth')) return `Ethernet (${iface})`;
        if (iface.startsWith('enx')) return `Ethernet (${iface})`;
        return iface;
    }

    /**
     * Initialize Firewall Rules (Walled Garden)
     */
    async init() {
        await this.detectWanInterface();
        await this.detectLanInterface();
        
        console.log('Initializing Network Bridge & Firewall...');
        const netScript = path.join(__dirname, '../scripts/init_network.sh');
        const firewallScript = path.join(__dirname, '../scripts/init_firewall.sh');
        const dnsmasqScript = path.join(__dirname, '../scripts/init_dnsmasq.sh');
        const pppoeScript = path.join(__dirname, '../scripts/init_pppoe.sh');
        const wanRouteScript = path.join(__dirname, '../scripts/setup_wan_routes.sh');
        
        // Ensure scripts are executable and have correct line endings (LF)
        // Fixes "command not found" errors if files were edited on Windows
        // Check if wanRouteScript exists before including it in commands
        let scriptsToFix = `${netScript} ${firewallScript} ${dnsmasqScript} ${pppoeScript}`;
        if (fs.existsSync(wanRouteScript)) {
            scriptsToFix += ` ${wanRouteScript}`;
        }

        await this.runCommand(`sed -i 's/\r$//' ${scriptsToFix}`);
        await this.runCommand(`chmod +x ${scriptsToFix}`);
        
        // Apply Multi-WAN Routing & Monitoring if script exists
        if (fs.existsSync(wanRouteScript)) {
            console.log('Applying Multi-WAN Routing & Monitoring...');
            await this.runCommand(wanRouteScript);
        }

        let firewallWanInterface = this.wanInterface;

        // Handle PPPoE Configuration
        const wanConfig = networkConfigService.getWanConfig();
        
        // Always attempt to stop any previous PPPoE session to ensure clean state
        await this.runCommand(`${pppoeScript} none none none stop`, true);

        if (wanConfig.mode === 'pppoe') {
            const { interface: iface, pppoe } = wanConfig;
            if (iface && pppoe && pppoe.username && pppoe.password) {
                // Check if pppd is installed
                const pppdCheck = await this.runCommand('which pppd', true);
                if (!pppdCheck) {
                    console.error('CRITICAL: pppd is NOT installed. PPPoE will fail.');
                    console.error('The system does not have enough memory to auto-install it while running the app.');
                    console.error('PLEASE RUN THIS COMMAND MANUALLY IN THE TERMINAL:');
                    console.error('sudo apt-get update && sudo apt-get install -y ppp pppoe');
                    // Do not attempt auto-install to avoid OOM crash
                }

                console.log(`Starting PPPoE on ${iface}...`);
                const dns1 = pppoe.dns1 || '';
                const dns2 = pppoe.dns2 || '';
                
                // Run PPPoE script with detailed logging
                try {
                    console.log('Executing PPPoE script...');
                    const result = await this.runCommand(`${pppoeScript} ${iface} "${pppoe.username}" "${pppoe.password}" start "${dns1}" "${dns2}"`);
                    if (result !== null) {
                        console.log('PPPoE script completed successfully.');
                    } else {
                        console.error('PPPoE script failed (returned null/error).');
                    }
                } catch (err) {
                    console.error('PPPoE Script Failed:', err);
                }
                
                // Wait for ppp0 to come up (max 10 seconds)
                // With updetach, it should be up immediately, but we double check
                let retries = 0;
                while (retries < 10) {
                    await new Promise(r => setTimeout(r, 1000));
                    const check = await this.runCommand('ip link show ppp0', true);
                    if (check) {
                        console.log('PPPoE Interface (ppp0) is UP');
                        firewallWanInterface = 'ppp0';
                        this.wanInterface = 'ppp0'; // Update for external consumers (e.g. BandwidthService)
                        break;
                    }
                    retries++;
                }
                if (firewallWanInterface !== 'ppp0') {
                    console.error('PPPoE started but ppp0 interface not found after 10s');
                }
            } else {
                console.error('PPPoE enabled but missing configuration');
            }
        }
        
        // 1. Setup Bridge (br0) and add LAN interfaces
        const bridges = networkConfigService.getBridges();
        const mainBridge = bridges.find(b => b.name === 'br0') || bridges[0];
        const bridgeIp = mainBridge ? mainBridge.ip : '10.0.0.1';
        
        // Ensure we exclude the physical WAN interface from the bridge
        const physicalWanInterface = (wanConfig && wanConfig.interface) ? wanConfig.interface : this.wanInterface;

        await this.runCommand(`${netScript} ${physicalWanInterface} ${bridgeIp}`);
        
        // 2. Setup DNSMasq on br0
        await this.runCommand(`${dnsmasqScript} ${bridgeIp}`);
        
        // 3. Setup Firewall on br0
        // Use logical interface (ppp0) for NAT if PPPoE is active
        await this.runCommand(`${firewallScript} ${firewallWanInterface} ${bridgeIp}`);
    }

    async getMacFromIp(ip) {
        // Clean IP (remove ::ffff: prefix if present)
        if (ip.startsWith('::ffff:')) {
            ip = ip.substring(7);
        }

        // Dev/Localhost handling
        if (ip === '::1' || ip === '127.0.0.1') {
            return '00:00:00:00:00:00';
        }

        // 1. Force ARP update (Ping) to ensure device is in ARP table
        try {
            // Short timeout ping to trigger ARP request
            const pingCmd = process.platform === 'win32' 
                ? `ping -n 1 -w 200 ${ip}` 
                : `ping -c 1 -W 1 ${ip}`;
            await this.runCommand(pingCmd);
        } catch (e) { 
            // Ignore ping failure, device might block ICMP
        }

        // 2. Try reading /proc/net/arp (Linux only, fastest & most reliable)
        if (process.platform === 'linux') {
            try {
                if (fs.existsSync('/proc/net/arp')) {
                    const arpContent = fs.readFileSync('/proc/net/arp', 'utf8');
                    const lines = arpContent.split('\n');
                    for (const line of lines) {
                        // IP address       HW type     Flags       HW address            Mask     Device
                        // 192.168.1.50     0x1         0x2         00:11:22:33:44:55     *        wlan0
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4 && parts[0] === ip) {
                            const mac = parts[3];
                            // Ignore incomplete entries (00:00... or incomplete)
                            if (mac && mac !== '00:00:00:00:00:00' && !mac.includes('incomplete')) {
                                return mac.toUpperCase();
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Failed to read /proc/net/arp:', e.message);
            }
            
            // 3. Try ip neigh (Modern Linux)
            try {
                const stdout = await this.runCommand(`ip neigh show ${ip}`);
                // Output: 10.0.0.5 dev wlan0 lladdr 00:11:22:33:44:55 REACHABLE
                if (stdout) {
                    const match = stdout.match(/lladdr\s+([0-9A-Fa-f:]{17})/);
                    if (match) return match[1].toUpperCase();
                }
            } catch (e) {}
        }

        // 4. Fallback to 'arp' command (Windows/Legacy Linux)
        try {
            const cmd = process.platform === 'win32' ? `arp -a ${ip}` : `arp -n ${ip}`;
            const stdout = await this.runCommand(cmd);
            if (!stdout) return null;
            
            const match = stdout.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
            if (match) {
                return match[0].toUpperCase().replace(/-/g, ':');
            }
        } catch (e) {
            console.error('ARP command failed:', e.message);
        }

        // 5. Fallback to dnsmasq leases (Linux)
        if (process.platform === 'linux') {
            const leasePaths = [
                '/var/lib/misc/dnsmasq.leases',
                '/tmp/dnsmasq.leases',
                '/var/lib/dnsmasq/dnsmasq.leases'
            ];
            for (const p of leasePaths) {
                try {
                    if (fs.existsSync(p)) {
                        const content = fs.readFileSync(p, 'utf8');
                        const lines = content.split('\n');
                        for (const line of lines) {
                            const parts = line.trim().split(/\s+/);
                            // Expected: <timestamp> <mac> <ip> <hostname> <clientid>
                            if (parts.length >= 3 && parts[2] === ip) {
                                const mac = parts[1];
                                if (mac && mac.length === 17) {
                                    return mac.toUpperCase();
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        return null;
    }

    /**
     * Check if a user has active TCP/UDP connections
     * Used for Idle Detection
     * @param {string} ip
     * @returns {Promise<boolean>}
     */
    async hasActiveConnections(ip) {
        if (!ip) return false;
        
        // 1. Linux: Check conntrack table (Best for ROUTED/Internet traffic)
        if (process.platform === 'linux') {
            try {
                // Method 1: Check /proc/net/nf_conntrack (Fastest, no external dependencies)
                const conntrackPath = fs.existsSync('/proc/net/nf_conntrack') ? '/proc/net/nf_conntrack' : 
                                     (fs.existsSync('/proc/net/ip_conntrack') ? '/proc/net/ip_conntrack' : null);

                if (conntrackPath) {
                    // Use grep to avoid reading huge file into memory
                    // -m 1 to stop at first match
                    // Use sudo to ensure we can read the file (permissions often 440 root:netadmin)
                    const cmd = `grep -m 1 "src=${ip}" ${conntrackPath} | grep -E "ESTABLISHED|udp"`;
                    const result = await this.runCommand(cmd, true); // silent=true
                    if (result) return true;
                }
                
                // Method 2: conntrack tool (Fallback)
                // Use sudo
                const result = await this.runCommand(`conntrack -L -s ${ip} 2>/dev/null | grep -E "ESTABLISHED|udp" | head -n 1`, true);
                if (result) return true;

            } catch (e) {
                // Fail silently
            }
            
            // Method 3: Check Neighbor Table (ARP) for REACHABLE state
            // If the device is actively responding to ARP/NDP, it's on the network.
            try {
                 // REACHABLE = Confirmed active recently
                 // DELAY = Sending packet, waiting for confirmation
                 const neighCmd = `ip neigh show ${ip}`;
                 const neighResult = await this.runCommand(neighCmd, true);
                 if (neighResult && (neighResult.includes('REACHABLE') || neighResult.includes('DELAY') || neighResult.includes('PROBE'))) {
                     return true;
                 }
            } catch(e) {}
        }

        // 2. Check Local Sockets (Portal/DNS Traffic) using 'ss' or 'netstat'
        // This detects if the user is talking to the ROUTER itself (e.g. loading portal, keeping tab open)
        try {
            // ss is faster and modern (part of iproute2)
            // dst IP matches the REMOTE peer (the user)
            // Use sudo to see all sockets
            const ssCmd = `ss -n state established dst ${ip} | grep -v "Recv-Q"`;
            const ssResult = await this.runCommand(ssCmd, true);
            if (ssResult) return true;
        } catch (e) {}

        try {
            // Fallback to netstat if ss fails (older systems)
            // grep for the Foreign Address
            const netstatCmd = process.platform === 'win32' 
                ? `netstat -n | findstr "${ip}"` 
                : `netstat -n | grep "${ip}" | grep "ESTABLISHED"`;
            const nsResult = await this.runCommand(netstatCmd, true);
            if (nsResult) return true;
        } catch (e) {}

        return false;
    }

    /**
     * Get all active MAC addresses from ARP/Neighbor table
     * Returns a Map of MAC -> IP
     * Used for auto-resume functionality
     */
    async getActiveMacs() {
        const activeMacs = new Map(); // MAC -> IP

        if (process.platform === 'linux') {
            // 1. Try reading /proc/net/arp (Fastest)
            try {
                if (fs.existsSync('/proc/net/arp')) {
                    const arpContent = fs.readFileSync('/proc/net/arp', 'utf8');
                    const lines = arpContent.split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        // IP, HW Type, Flags, MAC, Mask, Device
                        if (parts.length >= 6) {
                            const ip = parts[0];
                            const mac = parts[3];
                            // Check valid MAC and ensure not incomplete
                            if (mac && mac.length === 17 && mac !== '00:00:00:00:00:00') {
                                activeMacs.set(mac.toUpperCase(), ip);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('Failed to read /proc/net/arp:', e.message);
            }

            // 2. Try ip neigh (More accurate for REACHABLE/STALE status)
            try {
                const stdout = await this.runCommand('ip neigh show');
                if (stdout) {
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        // 10.0.0.5 dev wlan0 lladdr 00:11:22:33:44:55 REACHABLE
                        const match = line.match(/^(\S+)\s+.*lladdr\s+([0-9A-Fa-f:]{17})/);
                        if (match) {
                            activeMacs.set(match[2].toUpperCase(), match[1]);
                        }
                    }
                }
            } catch (e) {}
            
            // 3. Fallback to dnsmasq leases
            try {
                const leasePaths = [
                    '/var/lib/misc/dnsmasq.leases',
                    '/tmp/dnsmasq.leases',
                    '/var/lib/dnsmasq/dnsmasq.leases'
                ];
                for (const p of leasePaths) {
                    if (!fs.existsSync(p)) continue;
                    const content = fs.readFileSync(p, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 3) {
                            const mac = parts[1];
                            const ip = parts[2];
                            if (mac && mac.length === 17 && ip) {
                                activeMacs.set(mac.toUpperCase(), ip);
                            }
                        }
                    }
                }
            } catch (e) {}
        } else {
            // Windows fallback (arp -a)
            try {
                const stdout = await this.runCommand('arp -a');
                if (stdout) {
                    // Interface: 192.168.1.5 --- 0x2
                    //   Internet Address      Physical Address      Type
                    //   192.168.1.1           00-11-22-33-44-55     dynamic
                    const lines = stdout.split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            const ip = parts[0];
                            const macMatch = line.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
                            if (macMatch) {
                                activeMacs.set(macMatch[0].toUpperCase().replace(/-/g, ':'), ip);
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        return activeMacs;
    }

    async checkInternetConnection() {
        try {
            // Ping 8.8.8.8 once with 2 second timeout
            const cmd = process.platform === 'win32' ? 'ping -n 1 -w 2000 8.8.8.8' : 'ping -c 1 -W 2 8.8.8.8';
            const result = await this.runCommand(cmd, true);
            return result !== null;
        } catch (e) {
            return false;
        }
    }

    /**
     * Authorize a user by MAC address
     * Strategy: Add rule to 'internet_users' chain to MARK packets with 99
     * Also adds rules to 'traffic_acct' for data usage tracking if IP is provided
     */
    async allowUser(macAddress, ipAddress = null) {
        // console.log(`Authorizing MAC: ${macAddress} IP: ${ipAddress}`);
        
        // 1. Authorization Rule (Mangle Table)
        const check = await this.runCommand(`iptables -t mangle -C internet_users -m mac --mac-source ${macAddress} -j MARK --set-mark 99`, true);
        if (check === null) {
            await this.runCommand(`iptables -t mangle -A internet_users -m mac --mac-source ${macAddress} -j MARK --set-mark 99`);
        }

        // 1.1 Resolve IP if not provided
        if (!ipAddress) {
            try {
                const activeMacs = await this.getActiveMacs();
                if (activeMacs.has(macAddress.toUpperCase())) {
                    ipAddress = activeMacs.get(macAddress.toUpperCase());
                    console.log(`[Network] Resolved IP for ${macAddress} -> ${ipAddress} for accounting.`);
                }
            } catch (e) {
                console.error('[Network] Error resolving IP for allowUser:', e);
            }
        }

        // 2. Accounting Rules (Filter Table - Forward Chain)
        if (ipAddress) {
            // Upload Rule (Source IP)
            const checkUp = await this.runCommand(`iptables -C traffic_acct -s ${ipAddress} -j RETURN`, true);
            if (checkUp === null) {
                await this.runCommand(`iptables -A traffic_acct -s ${ipAddress} -j RETURN`);
            }

            // Download Rule (Dest IP)
            const checkDown = await this.runCommand(`iptables -C traffic_acct -d ${ipAddress} -j RETURN`, true);
            if (checkDown === null) {
                await this.runCommand(`iptables -A traffic_acct -d ${ipAddress} -j RETURN`);
            }
        }

        return true; 
    }

    /**
     * Block a user
     */
    async blockUser(macAddress, ipAddress = null) {
        console.log(`Blocking MAC: ${macAddress} (IP: ${ipAddress || 'Unknown'})`);
        
        // 1. Remove iptables Mark Rules
        let success = true;
        while(success) {
             const result = await this.runCommand(`iptables -t mangle -D internet_users -m mac --mac-source ${macAddress} -j MARK --set-mark 99`, true);
             if (result === null) success = false;
        }

        // 2. Resolve Current IP from MAC (in case DB is stale or user roamed)
        let resolvedIp = ipAddress;
        if (!resolvedIp) {
            try {
                const activeMacs = await this.getActiveMacs();
                if (activeMacs.has(macAddress.toUpperCase())) {
                    resolvedIp = activeMacs.get(macAddress.toUpperCase());
                    console.log(`Resolved current IP for ${macAddress} -> ${resolvedIp}`);
                }
            } catch (e) {
                console.error('Error resolving IP for block:', e);
            }
        }

        // 3. Remove Accounting Rules
        if (resolvedIp) {
            let acctSuccess = true;
            while(acctSuccess) {
                const r1 = await this.runCommand(`iptables -D traffic_acct -s ${resolvedIp} -j RETURN`, true);
                const r2 = await this.runCommand(`iptables -D traffic_acct -d ${resolvedIp} -j RETURN`, true);
                if (r1 === null && r2 === null) acctSuccess = false;
            }
        }

        // 4. Force Kill Connections (Conntrack)
        const ipsToBlock = new Set();
        if (ipAddress) ipsToBlock.add(ipAddress);
        if (resolvedIp) ipsToBlock.add(resolvedIp);

        for (const ip of ipsToBlock) {
            console.log(`Killing connections for IP: ${ip}`);
            await this.runCommand(`conntrack -D -s ${ip}`, true);
            await this.runCommand(`conntrack -D -d ${ip}`, true);
        }

        return true;
    }

    /**
     * Get Traffic Stats from iptables
     * Returns Map: IP -> { bytes_up: number, bytes_down: number }
     */
    async getTrafficStats() {
        try {
            // -v: verbose (packet/byte counts)
            // -n: numeric (no DNS lookup)
            // -x: exact (no K/M suffixes)
            // -L traffic_acct: list chain
            // silent=true to avoid error logs if chain doesn't exist yet
            const output = await this.runCommand('iptables -v -n -x -L traffic_acct', true);
            if (!output) return new Map();

            const stats = new Map();
            const lines = output.split('\n');
            
            // Example Output:
            // Chain traffic_acct (1 references)
            //     pkts      bytes target     prot opt in     out     source               destination
            //      100    50000 RETURN     all  --  *      *       192.168.1.50         0.0.0.0/0
            //      200   120000 RETURN     all  --  *      *       0.0.0.0/0            192.168.1.50

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                // We need at least: pkts, bytes, target, ..., source, destination
                // Index: 0=pkts, 1=bytes, 2=target, ... 7=source, 8=destination
                if (parts.length >= 9 && parts[2] === 'RETURN') {
                    const bytes = parseInt(parts[1], 10);
                    const source = parts[7];
                    const dest = parts[8];

                    // Check if Source is a specific IP (Upload)
                    if (source !== '0.0.0.0/0' && source !== '::/0') {
                        if (!stats.has(source)) stats.set(source, { bytes_up: 0, bytes_down: 0 });
                        stats.get(source).bytes_up += bytes;
                    }
                    
                    // Check if Dest is a specific IP (Download)
                    if (dest !== '0.0.0.0/0' && dest !== '::/0') {
                        if (!stats.has(dest)) stats.set(dest, { bytes_up: 0, bytes_down: 0 });
                        stats.get(dest).bytes_down += bytes;
                    }
                }
            }
            return stats;
        } catch (e) {
            console.error('Failed to get traffic stats:', e);
            return new Map();
        }
    }

    /**
     * Get list of currently authorized MAC addresses from iptables
     * Parses `iptables -t mangle -L internet_users -v -n`
     */
    async getAuthorizedMacs() {
        try {
            const output = await this.runCommand('iptables -t mangle -L internet_users -v -n');
            const authorizedMacs = new Set();
            if (!output) return authorizedMacs;

            const lines = output.split('\n');
            for (const line of lines) {
                // Example line:
                // 0     0     MARK       all  --  *      *       00:00:00:00:00:00    0.0.0.0/0            MAC 00:00:00:00:00:00 MARK set 0x63
                const match = line.match(/MAC\s+([0-9A-Fa-f:]{17})/);
                if (match) {
                    authorizedMacs.add(match[1].toUpperCase());
                }
            }
            return authorizedMacs;
        } catch (e) {
            console.error('Failed to get authorized MACs:', e);
            return new Set();
        }
    }

    /**
     * ZeroTier Integration
     */
    async getZeroTierStatus() {
        try {
            // Check if installed
            const version = await this.runCommand('zerotier-cli -v', true);
            if (!version) {
                return { installed: false };
            }

            // Get Device Info
            const infoOutput = await this.runCommand('zerotier-cli info -j');
            let info = {};
            try {
                info = JSON.parse(infoOutput);
            } catch (e) {
                // Fallback for non-json output versions
                const parts = infoOutput.split(' ');
                if (parts.length >= 3) {
                    info = { address: parts[2], online: parts[4] === 'ONLINE' };
                }
            }

            // Get Networks
            const netOutput = await this.runCommand('zerotier-cli listnetworks -j');
            let networks = [];
            try {
                networks = JSON.parse(netOutput);
            } catch (e) {
                // Fallback text parsing if needed, but -j is standard now
            }

            return {
                installed: true,
                version: version.trim(),
                deviceId: info.address,
                online: info.online,
                networks: networks.map(n => ({
                    id: n.id,
                    name: n.name,
                    status: n.status,
                    type: n.type,
                    mac: n.mac,
                    ip: n.assignedAddresses ? n.assignedAddresses.join(', ') : ''
                }))
            };

        } catch (e) {
            console.error('ZeroTier Status Error:', e);
            return { installed: false, error: e.message };
        }
    }

    async joinZeroTier(networkId) {
        if (!networkId || networkId.length !== 16) {
            throw new Error("Invalid Network ID");
        }
        const result = await this.runCommand(`zerotier-cli join ${networkId}`);
        return result && result.includes('200 join OK');
    }

    async leaveZeroTier(networkId) {
        if (!networkId) throw new Error("Network ID required");
        const result = await this.runCommand(`zerotier-cli leave ${networkId}`);
        return result && result.includes('200 leave OK');
    }
}

module.exports = new NetworkService();
