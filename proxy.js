const fs = require('fs');
const path = require('path');
const net = require('net');

const PROXY_FILE = path.join(__dirname, 'proxy.txt');
const AUTO_FETCH_FREE_PROXIES = String(process.env.AUTO_FREE_PROXY || 'true').toLowerCase() !== 'false';
const FREE_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'
];

let fileProxies = [];
let fetchedFreeProxies = [];
let lastFreeFetchAt = 0;
let roundRobinIndex = 0;
const badProxyExpiry = new Map(); // key -> timestamp until ignored

function parseProxyLine(rawLine) {
  if (!rawLine) return null;
  let line = String(rawLine).trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;

  // Strip inline comments
  const hashIdx = line.indexOf('#');
  if (hashIdx !== -1) line = line.slice(0, hashIdx).trim();
  if (!line) return null;

  let protocol = 'socks5';
  if (line.includes('://')) {
    const parts = line.split('://');
    protocol = parts[0].toLowerCase().trim();
    line = parts[1].trim();
  }

  let username = '';
  let password = '';
  if (line.includes('@')) {
    const atIdx = line.lastIndexOf('@');
    const authPart = line.slice(0, atIdx);
    line = line.slice(atIdx + 1);
    const colonIdx = authPart.indexOf(':');
    if (colonIdx !== -1) {
      username = decodeURIComponent(authPart.slice(0, colonIdx));
      password = decodeURIComponent(authPart.slice(colonIdx + 1));
    } else {
      username = decodeURIComponent(authPart);
    }
  }

  const hostPort = line.split('/')[0].trim();
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon === -1) return null;

  const ip = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, '').trim();
  const port = Number(hostPort.slice(lastColon + 1).trim());
  if (!ip || !port || Number.isNaN(port) || port < 1 || port > 65535) return null;

  const socksType = protocol === 'socks4' ? 4 : 5;
  const key = `${protocol}://${ip}:${port}`;

  return {
    key,
    protocol,
    socksType,
    ip,
    port,
    username: username || undefined,
    password: password || undefined
  };
}

function loadProxiesFromFile() {
  try {
    if (!fs.existsSync(PROXY_FILE)) {
      fileProxies = [];
      return [];
    }
    const content = fs.readFileSync(PROXY_FILE, 'utf8');
    const parsed = [];
    const seen = new Set();
    for (const line of content.split(/\r?\n/)) {
      const p = parseProxyLine(line);
      if (p && !seen.has(p.key)) {
        seen.add(p.key);
        parsed.push(p);
      }
    }
    fileProxies = parsed;
    return parsed;
  } catch (e) {
    fileProxies = [];
    return [];
  }
}

// Initial load & watch for live edits in proxy.txt
loadProxiesFromFile();
try {
  if (fs.existsSync(PROXY_FILE)) {
    fs.watchFile(PROXY_FILE, { interval: 5000 }, () => {
      loadProxiesFromFile();
    });
  }
} catch (e) {}

async function refreshFreePublicProxies(force = false) {
  if (!AUTO_FETCH_FREE_PROXIES) return [];
  const now = Date.now();
  if (!force && fetchedFreeProxies.length > 0 && now - lastFreeFetchAt < 15 * 60 * 1000) {
    return fetchedFreeProxies;
  }
  lastFreeFetchAt = now;

  for (const srcUrl of FREE_PROXY_SOURCES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const resp = await fetch(srcUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const text = await resp.text();
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) continue;

      // Pick a randomized sample of up to 40 proxies so we don't store thousands
      const sampled = [];
      const step = Math.max(1, Math.floor(lines.length / 40));
      for (let i = 0; i < lines.length && sampled.length < 40; i += step) {
        const p = parseProxyLine(lines[i]);
        if (p) sampled.push(p);
      }
      if (sampled.length > 0) {
        fetchedFreeProxies = sampled;
        return fetchedFreeProxies;
      }
    } catch (e) {}
  }
  return fetchedFreeProxies;
}

function testTcpReachable(ip, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

function markProxyBad(proxyKey, cooldownMs = 10 * 60 * 1000) {
  if (!proxyKey) return;
  badProxyExpiry.set(proxyKey, Date.now() + cooldownMs);
}

function isProxyHealthy(proxyKey) {
  const exp = badProxyExpiry.get(proxyKey);
  if (!exp) return true;
  if (Date.now() > exp) {
    badProxyExpiry.delete(proxyKey);
    return true;
  }
  return false;
}

/**
 * Returns a GramJS-ready proxy object:
 * { ip, port, socksType, timeout, username?, password? }
 * Or null if no working proxy is available (so server falls back cleanly to direct connection).
 */
async function getTelegramProxyConfig() {
  // 1. Check explicit env proxy first if provided
  if (process.env.TG_PROXY_URL) {
    const envProxy = parseProxyLine(process.env.TG_PROXY_URL);
    if (envProxy && isProxyHealthy(envProxy.key)) {
      const ok = await testTcpReachable(envProxy.ip, envProxy.port, 2200);
      if (ok) {
        return {
          _key: envProxy.key,
          ip: envProxy.ip,
          port: envProxy.port,
          socksType: envProxy.socksType,
          timeout: 5,
          ...(envProxy.username ? { username: envProxy.username } : {}),
          ...(envProxy.password ? { password: envProxy.password } : {})
        };
      }
      markProxyBad(envProxy.key);
    }
  }

  // 2. Check custom proxies from proxy.txt
  const customList = loadProxiesFromFile().filter((p) => isProxyHealthy(p.key));
  if (customList.length > 0) {
    for (let i = 0; i < Math.min(customList.length, 5); i++) {
      const candidate = customList[(roundRobinIndex + i) % customList.length];
      const ok = await testTcpReachable(candidate.ip, candidate.port, 2000);
      if (ok) {
        roundRobinIndex = (roundRobinIndex + i + 1) % customList.length;
        return {
          _key: candidate.key,
          ip: candidate.ip,
          port: candidate.port,
          socksType: candidate.socksType,
          timeout: 5,
          ...(candidate.username ? { username: candidate.username } : {}),
          ...(candidate.password ? { password: candidate.password } : {})
        };
      }
      markProxyBad(candidate.key);
    }
  }

  // 3. If proxy.txt has no custom proxies, try free public SOCKS5 pool (only if explicitly enabled via proxy.txt or env)
  if (String(process.env.USE_PUBLIC_FREE_PROXY || 'false').toLowerCase() === 'true') {
    const freeList = (await refreshFreePublicProxies()).filter((p) => isProxyHealthy(p.key));
    for (let i = 0; i < Math.min(freeList.length, 4); i++) {
      const candidate = freeList[(roundRobinIndex + i) % freeList.length];
      const ok = await testTcpReachable(candidate.ip, candidate.port, 1600);
      if (ok) {
        roundRobinIndex = (roundRobinIndex + i + 1) % freeList.length;
        return {
          _key: candidate.key,
          ip: candidate.ip,
          port: candidate.port,
          socksType: candidate.socksType,
          timeout: 4
        };
      }
      markProxyBad(candidate.key);
    }
  }

  return null;
}

function getProxyStats() {
  const custom = loadProxiesFromFile();
  return {
    proxyFileExists: fs.existsSync(PROXY_FILE),
    customProxiesLoaded: custom.length,
    healthyCustomProxies: custom.filter((p) => isProxyHealthy(p.key)).length,
    freePoolCached: fetchedFreeProxies.length,
    badProxiesCoolingDown: badProxyExpiry.size
  };
}

module.exports = {
  loadProxiesFromFile,
  getTelegramProxyConfig,
  markProxyBad,
  getProxyStats,
  refreshFreePublicProxies
};
