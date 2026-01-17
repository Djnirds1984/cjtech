const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

class MonitoringService {
    constructor() {
        this.lastCpuInfo = null;
        this.isOnline = false;
        this.trafficCache = {}; // { id_or_ip: { bytes, timestamp } }
        // Start background polling for internet status
        this.pollInternet();
        setInterval(() => this.pollInternet(), 10000); // Check every 10 seconds
    }
    
    // Background polling to avoid blocking API
    pollInternet() {
        // Ping Google DNS with 1 second timeout
        const cmd = process.platform === 'win32' ? 'ping -n 1 -w 1000 8.8.8.8' : 'ping -c 1 -W 1 8.8.8.8';
        exec(cmd, (err) => {
            this.isOnline = !err;
        });
    }

    // 0. System Usage (CPU %)
    async getCpuUsage() {
        return new Promise(resolve => {
            const cpus = os.cpus();
            
            // Calculate Global Usage
            let user = 0, nice = 0, sys = 0, idle = 0, irq = 0, total = 0;
            for (let cpu of cpus) {
                user += cpu.times.user;
                nice += cpu.times.nice;
                sys += cpu.times.sys;
                idle += cpu.times.idle;
                irq += cpu.times.irq;
            }
            total = user + nice + sys + idle + irq;
            
            let globalUsage = 0;
            if (this.lastCpuInfo) {
                const totalDiff = total - this.lastCpuInfo.total;
                const idleDiff = idle - this.lastCpuInfo.idle;
                if (totalDiff > 0) {
                    globalUsage = 100 - ((idleDiff / totalDiff) * 100);
                }
            }
            this.lastCpuInfo = { total, idle };

            // Calculate Per-Core Usage
            const coresUsage = [];
            if (!this.lastCoresInfo) this.lastCoresInfo = [];

            cpus.forEach((cpu, i) => {
                const t = cpu.times;
                const coreTotal = t.user + t.nice + t.sys + t.idle + t.irq;
                const coreIdle = t.idle;
                
                let corePercent = 0;
                if (this.lastCoresInfo[i]) {
                    const dTotal = coreTotal - this.lastCoresInfo[i].total;
                    const dIdle = coreIdle - this.lastCoresInfo[i].idle;
                    if (dTotal > 0) {
                        corePercent = 100 - ((dIdle / dTotal) * 100);
                    }
                }
                
                this.lastCoresInfo[i] = { total: coreTotal, idle: coreIdle };
                coresUsage.push(parseFloat(corePercent.toFixed(1)));
            });

            resolve({
                avg: parseFloat(globalUsage.toFixed(1)),
                cores: coresUsage
            });
        });
    }

    // 1. Real-time Status (Ping)
    async checkInternet() {
        return this.isOnline;
    }

    // 2. Traffic Stats (RX/TX)
    async getInterfaceStats() {
        // Read /proc/net/dev
        try {
            if (process.platform === 'win32') {
                 // Mock for Windows
                 return [
                     { interface: 'br0', rx_bytes: Math.floor(Math.random() * 5000000), tx_bytes: Math.floor(Math.random() * 2000000) },
                     { interface: 'Ethernet', rx_bytes: Math.floor(Math.random() * 1000000), tx_bytes: Math.floor(Math.random() * 500000) },
                     { interface: 'Wi-Fi', rx_bytes: Math.floor(Math.random() * 2000000), tx_bytes: Math.floor(Math.random() * 1000000) }
                 ];
            }

            const data = await fs.promises.readFile('/proc/net/dev', 'utf8');
            const lines = data.split('\n');
            const stats = [];
            // Parse lines (skipping header)
            for (let i = 2; i < lines.length; i++) {
                let line = lines[i].trim();
                if (!line) continue;
                
                // Fix for formats like "eth0:1234" (no space after colon)
                // Replace first colon with space
                line = line.replace(':', ' ');
                
                const parts = line.split(/\s+/);
                if (parts.length < 2) continue;

                // parts[0] is interface, parts[1] is RX bytes, parts[9] is TX bytes
                stats.push({
                    interface: parts[0],
                    rx_bytes: parseInt(parts[1]),
                    tx_bytes: parseInt(parts[9])
                });
            }
            return stats;
        } catch (e) {
            console.error('Error reading network stats:', e);
            return [];
        }
    }

    // 2.1 Per-Client Traffic Stats
    async getClientTraffic(iface = 'br0') {
        if (process.platform === 'win32') {
            // Mock for Windows
            return {
                downloads: { '10': { bytes: 1000000, rate: 5.5 } }, // ID 10 -> 5.5 Mbps
                uploads: { '10.0.0.10': { bytes: 500000, rate: 1.2 } } // IP 10.0.0.10 -> 1.2 Mbps
            };
        }

        const stats = { downloads: {}, uploads: {} };
        const now = Date.now();

        // 1. Download (Class Stats)
        // Parse `tc -s class show dev br0`
        try {
            const classOutput = await new Promise(resolve => exec(`tc -s class show dev ${iface}`, (err, stdout) => resolve(stdout || '')));
            // Match: class htb 1:10 ... Sent 12345 bytes
            // Regex to capture ID and Bytes
            // Note: `tc` output is multi-line.
            // class htb 1:10 ...
            //  Sent 1234 bytes ...
            const classRegex = /class htb 1:(\d+)[\s\S]*?Sent (\d+) bytes/g;
            let match;
            while ((match = classRegex.exec(classOutput)) !== null) {
                const id = match[1];
                const bytes = parseInt(match[2]);
                
                // Calculate Rate
                let rate = 0;
                const cacheKey = `dl_${id}`;
                
                if (!this.trafficCache[cacheKey]) {
                    this.trafficCache[cacheKey] = { bytes, timestamp: now, lastActive: now };
                }
                const prev = this.trafficCache[cacheKey];

                const timeDiff = (now - prev.timestamp) / 1000; // seconds
                let bytesDiff = bytes - prev.bytes;
                if (bytesDiff < 0) bytesDiff = bytes;
                if (bytesDiff > 0) prev.lastActive = now;

                if (timeDiff > 0) {
                    rate = (bytesDiff * 8) / (1000000 * timeDiff); // Mbps
                }
                
                prev.bytes = bytes;
                prev.timestamp = now;
                
                const idle = Math.floor((now - prev.lastActive) / 1000); // seconds
                
                stats.downloads[id] = { bytes, rate: parseFloat(rate.toFixed(2)), idle };
            }
        } catch (e) {
            console.error('Error fetching download stats:', e);
        }

        // 2. Upload (Filter Stats)
        // Parse `tc -s filter show dev br0 parent ffff:`
        try {
            const filterOutput = await new Promise(resolve => exec(`tc -s filter show dev ${iface} parent ffff:`, (err, stdout) => resolve(stdout || '')));
            // Match: match 0a00000a/ffffffff ... Sent 1234 bytes
            // Hex IP: 0a00000a -> 10.0.0.10
            const filterRegex = /match ([0-9a-fA-F]{8})\/ffffffff[\s\S]*?Sent (\d+) bytes/g;
            let match;
            while ((match = filterRegex.exec(filterOutput)) !== null) {
                const hexIp = match[1];
                const bytes = parseInt(match[2]);
                
                // Convert Hex to IP
                const ip = [
                    parseInt(hexIp.substring(0, 2), 16),
                    parseInt(hexIp.substring(2, 4), 16),
                    parseInt(hexIp.substring(4, 6), 16),
                    parseInt(hexIp.substring(6, 8), 16)
                ].join('.');

                // Calculate Rate
                let rate = 0;
                const cacheKey = `ul_${ip}`;
                
                if (!this.trafficCache[cacheKey]) {
                    this.trafficCache[cacheKey] = { bytes, timestamp: now, lastActive: now };
                }
                const prev = this.trafficCache[cacheKey];

                const timeDiff = (now - prev.timestamp) / 1000;
                let bytesDiff = bytes - prev.bytes;
                if (bytesDiff < 0) bytesDiff = bytes;
                if (bytesDiff > 0) prev.lastActive = now;

                if (timeDiff > 0) {
                    rate = (bytesDiff * 8) / (1000000 * timeDiff); // Mbps
                }
                
                prev.bytes = bytes;
                prev.timestamp = now;

                const idle = Math.floor((now - prev.lastActive) / 1000);

                stats.uploads[ip] = { bytes, rate: parseFloat(rate.toFixed(2)), idle };
            }
        } catch (e) {
            console.error('Error fetching upload stats:', e);
        }

        return stats;
    }

    // Get System Network Interfaces (IP, MAC, etc.)
    async getNetworkInterfaces() {
        const osInterfaces = os.networkInterfaces();
        let allNames = Object.keys(osInterfaces);
        let winMacMap = {};

        // Windows: Get all interfaces using wmic (includes disconnected ones)
        if (process.platform === 'win32') {
            try {
                const wmicPromise = new Promise(resolve => {
                    exec('wmic nic get NetConnectionID,MACAddress', (err, stdout) => {
                        if (err) return resolve([]);
                        const lines = stdout.split('\n');
                        const wmicInterfaces = [];
                        lines.forEach(line => {
                            // Skip headers and empty lines
                            if (line.includes('NetConnectionID') || !line.trim()) return;
                            
                            // Split by 2+ spaces
                            const parts = line.trim().split(/\s{2,}/);
                            if (parts.length >= 2) {
                                // MACAddress         NetConnectionID
                                const mac = parts[0].trim();
                                const name = parts[1].trim();
                                if (mac && name) {
                                    wmicInterfaces.push({ name, mac });
                                }
                            }
                        });
                        resolve(wmicInterfaces);
                    });
                });
                
                const winInterfaces = await wmicPromise;
                // Merge names
                const winNames = winInterfaces.map(i => i.name);
                allNames = [...new Set([...allNames, ...winNames])];
                
                // Map names to MACs for fallback
                winMacMap = winInterfaces.reduce((acc, curr) => {
                    acc[curr.name] = curr.mac;
                    return acc;
                }, {});
            } catch (e) {
                console.error("Error fetching Windows interfaces:", e);
            }
        }
        
        // On Linux, get ALL interfaces from /sys/class/net to include those without IP
        if (process.platform === 'linux') {
            // 1. Try /sys/class/net (Existing)
            try {
                const sysNames = fs.readdirSync('/sys/class/net');
                // Merge unique names
                allNames = [...new Set([...allNames, ...sysNames])];
            } catch (e) {
                console.error("Error reading /sys/class/net", e);
            }

            // 2. Try 'ip link show' (New: robust fallback)
            try {
                const ipLinkPromise = new Promise(resolve => {
                    exec('ip link show', (err, stdout) => {
                        if (err) return resolve([]);
                        
                        const lines = stdout.split('\n');
                        const interfaces = [];
                        let currentIface = null;
                        
                        lines.forEach(line => {
                            // Match interface start line: "1: eth0: <..."
                            const ifaceMatch = line.match(/^\d+: ([^:]+):/);
                            if (ifaceMatch) {
                                let name = ifaceMatch[1].trim();
                                // Strip @ suffix if present (e.g. eth0.300@end0 -> eth0.300)
                                if (name.includes('@')) {
                                    name = name.split('@')[0];
                                }
                                currentIface = { name: name, mac: null };
                                interfaces.push(currentIface);
                            }
                            // Match MAC line: "    link/ether aa:bb:cc:dd:ee:ff"
                            const macMatch = line.trim().match(/^link\/ether\s([0-9a-f:]{17})/);
                            if (currentIface && macMatch) {
                                currentIface.mac = macMatch[1];
                            }
                        });
                        resolve(interfaces);
                    });
                });
                
                const ipInterfaces = await ipLinkPromise;
                // Merge
                ipInterfaces.forEach(iface => {
                    if (!allNames.includes(iface.name)) allNames.push(iface.name);
                    // Reuse winMacMap as a generic mac fallback map
                    winMacMap[iface.name] = iface.mac;
                });
            } catch(e) {
                console.error("Error running ip link:", e);
            }
        }

        const result = allNames.map(name => {
            const details = osInterfaces[name];
            
            // Default values
            let mac = 'Unknown';
            let ip = 'No IP';
            let netmask = '';
            let family = '';
            let internal = false;

            // Try to get from OS module
            if (details) {
                const ipv4 = details.find(d => d.family === 'IPv4' || d.family === 4);
                const ipv6 = details.find(d => d.family === 'IPv6' || d.family === 6);
                
                if (ipv4) {
                    mac = ipv4.mac;
                    ip = ipv4.address;
                    netmask = ipv4.netmask;
                    family = 'IPv4';
                    internal = ipv4.internal;
                } else if (ipv6) {
                    mac = ipv6.mac;
                    ip = ipv6.address;
                    family = 'IPv6';
                    internal = ipv6.internal;
                }
            }

            // Windows/Linux Fallback: Use wmic/ip link MAC if available and OS module didn't provide it
            if ((!mac || mac === 'Unknown') && winMacMap[name]) {
                mac = winMacMap[name];
            }

            // Linux File Fallback: If MAC is still unknown, try reading from /sys/class/net
            if ((!mac || mac === 'Unknown') && process.platform === 'linux') {
                try {
                    mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim();
                } catch (e) {}
            }

            return { name, mac, ip, netmask, family, internal };
        });

        // Find a valid server MAC (fallback) from physical interfaces
        let serverMac = null;
        for (const iface of result) {
            if (iface.name !== 'lo' && !iface.name.startsWith('ppp') && iface.mac && iface.mac !== 'Unknown' && iface.mac !== '00:00:00:00:00:00') {
                serverMac = iface.mac;
                break;
            }
        }

        // Apply fallback MAC to PPP interfaces
        if (serverMac) {
            result.forEach(iface => {
                if (iface.name.startsWith('ppp') && (!iface.mac || iface.mac === 'Unknown' || iface.mac === '00:00:00:00:00:00')) {
                    iface.mac = serverMac;
                }
            });
        }

        return result;
    }

    // 3. DHCP Leases & ARP
    async getConnectedDevices() {
        // Parse ARP table
        const arpPromise = new Promise(resolve => {
            exec('arp -a', (err, stdout) => {
                if (err) return resolve([]);
                const devices = [];
                // Example: ? (192.168.1.10) at 00:11:22:33:44:55 [ether] on wlan0
                const lines = stdout.split('\n');
                lines.forEach(line => {
                    // Flexible regex for Linux arp output
                    const match = line.match(/\((.*?)\) at (.*?) \[.*\] on (.*)/) || 
                                  line.match(/(\d+\.\d+\.\d+\.\d+)\s+.*\s+(..:..:..:..:..:..)/); 
                    
                    if (match) {
                        // If it matched the second pattern (simple IP MAC)
                        if (!match[3]) {
                            devices.push({ ip: match[1], mac: match[2], interface: 'unknown' });
                        } else {
                            devices.push({ ip: match[1], mac: match[2], interface: match[3] });
                        }
                    }
                });
                resolve(devices);
            });
        });

        // Parse DNSMasq Leases
        const leasePath = '/var/lib/misc/dnsmasq.leases';
        let leases = [];
        try {
            if (fs.existsSync(leasePath)) {
                const data = fs.readFileSync(leasePath, 'utf8');
                leases = data.split('\n').filter(l => l).map(line => {
                    const parts = line.split(' ');
                    // Format: timestamp mac ip hostname client-id
                    if (parts.length >= 4) {
                        return { timestamp: parts[0], mac: parts[1], ip: parts[2], hostname: parts[3] };
                    }
                    return null;
                }).filter(l => l);
            }
        } catch (e) {}

        const arp = await arpPromise;
        
        // Merge data: ARP is ground truth for connectivity, Leases give hostnames
        // Also include leases that might not be in ARP (recently disconnected but valid lease)
        const combined = [...arp];

        leases.forEach(lease => {
            const existing = combined.find(d => d.mac === lease.mac);
            if (existing) {
                existing.hostname = lease.hostname;
            } else {
                combined.push({
                    ip: lease.ip,
                    mac: lease.mac,
                    interface: 'wlan0', // Assumed
                    hostname: lease.hostname,
                    status: 'offline' // Not in ARP cache
                });
            }
        });

        return combined;
    }

    // 4. Storage Usage
    async getDiskUsage() {
        return new Promise(resolve => {
            if (process.platform === 'win32') {
                exec('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /Value', (err, stdout) => {
                    if (err) return resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    
                    const sizeMatch = stdout.match(/Size=(\d+)/);
                    const freeMatch = stdout.match(/FreeSpace=(\d+)/);
                    
                    if (sizeMatch && freeMatch) {
                        const total = parseInt(sizeMatch[1]);
                        const free = parseInt(freeMatch[1]);
                        const used = total - free;
                        const percent = Math.round((used / total) * 100);
                        resolve({ total, free, used, percent });
                    } else {
                        resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    }
                });
            } else {
                // Linux: Check root partition
                exec('df -B1 / | tail -n 1', (err, stdout) => {
                    if (err) return resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    
                    const parts = stdout.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        const total = parseInt(parts[1]);
                        const used = parseInt(parts[2]);
                        const free = parseInt(parts[3]);
                        const percent = parseInt(parts[4].replace('%', ''));
                        resolve({ total, free, used, percent });
                    } else {
                        resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    }
                });
            }
        });
    }
    // 5. System Stats (CPU, Memory, Uptime)
    async getSystemStats() {
        const cpu = await this.getCpuUsage();
        const memTotal = os.totalmem();
        const memFree = os.freemem();
        const uptime = os.uptime();
        
        return {
            cpu: cpu,
            memory: {
                total: memTotal,
                free: memFree,
                used: memTotal - memFree,
                percent: parseFloat(((memTotal - memFree) / memTotal * 100).toFixed(1))
            },
            uptime: uptime
        };
    }
}

module.exports = new MonitoringService();
