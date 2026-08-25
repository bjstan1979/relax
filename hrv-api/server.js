// HRV Real-time Data API + Static File Server + WebSocket + Doctor Control
// 前端每个心跳即时推送 → WebSocket广播 → doctor agent实时订阅
// Doctor控制接口 → WebSocket推送指令 → 前端执行

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// 6666 is blocked by Chrome as an unsafe port; 8787 is browser-safe by default.
const PORT = Number(process.env.PORT || 8787);
const STATIC_DIR = path.resolve(__dirname, '..');

// 最新HRV数据
let latestHRV = {
  heartRate: 0,
  rmssd: 0,
  sdnn: 0,
  hrvLevel: 'none',
  rrCount: 0,
  rrRecent: [],
  timestamp: null,
  connected: false
};

// 历史记录（最近5分钟）
let hrvHistory = [];
const MAX_HISTORY = 300; // 5min, 每秒1条

// WebSocket连接池
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`📡 WS client connected (${clients.size} total)`);
  
  // 立即发送当前最新数据
  ws.send(JSON.stringify({ type: 'hrv', data: latestHRV }));
  
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      // 前端回复控制命令执行结果
      if (parsed.type === 'control_result') {
        console.log(`📋 Control result: ${JSON.stringify(parsed)}`);
        lastControlResult = { ...parsed, timestamp: Date.now() };
      }
    } catch (e) {}
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`📡 WS client disconnected (${clients.size} total)`);
  });
  
  ws.on('error', () => { clients.delete(ws); });
});

// 广播HRV数据到所有WebSocket客户端
function broadcastHRV(data) {
  const msg = JSON.stringify({ type: 'hrv', data });
  for (const ws of clients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(msg);
    }
  }
}

// 广播控制命令到前端
function broadcastControl(command) {
  const msg = JSON.stringify({ type: 'control', command });
  console.log(`🎮 Control: ${JSON.stringify(command)}`);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// 最后一次控制命令结果
let lastControlResult = null;

// MIME
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.webp': 'image/webp',
};

// 读取POST body
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// HRV Session Recording State (must be outside request handler to persist across requests)
let hrvSession = {
  active: false,
  filePath: null,
  sessionStart: null,
  samples: [],
  sampleTimer: null
};
const HRV_SESSIONS_DIR = path.join(STATIC_DIR, 'data', 'hrv-sessions');

const server = http.createServer(async (req, res) => {
  // 请求日志
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

// Ensure sessions directory exists
try {
  fs.mkdirSync(HRV_SESSIONS_DIR, { recursive: true });
  console.log(`   HRV sessions dir: ${HRV_SESSIONS_DIR}`);
} catch (e) {
  console.error('Failed to create HRV sessions dir:', e);
}

// ===== HRV 数据端点 =====

  // GET /api/hrv
  if (req.method === 'GET' && req.url === '/api/hrv') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestHRV, null, 2));
    return;
  }

  // GET /api/hrv/history
  if (req.method === 'GET' && req.url === '/api/hrv/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ history: hrvHistory, count: hrvHistory.length }, null, 2));
    return;
  }

  // POST /api/hrv — 前端推送（每个心跳即时推送）
  if (req.method === 'POST' && req.url === '/api/hrv') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      latestHRV = {
        heartRate: data.heartRate ?? 0,
        rmssd: data.rmssd ?? 0,
        sdnn: data.sdnn ?? 0,
        hrvLevel: data.hrvLevel ?? 'none',
        rrCount: data.rrCount ?? 0,
        rrRecent: data.rrRecent ?? [],
        timestamp: new Date().toISOString(),
        connected: data.connected ?? false
      };

      hrvHistory.push({ ...latestHRV });
      if (hrvHistory.length > MAX_HISTORY) {
        hrvHistory = hrvHistory.slice(-MAX_HISTORY);
      }

      fs.writeFileSync('/tmp/hrv-latest.json', JSON.stringify(latestHRV, null, 2));
      broadcastHRV(latestHRV);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // ===== HRV Session Recording Endpoints =====

  // POST /api/hrv-session/start — 开始记录
  if (req.method === 'POST' && req.url === '/api/hrv-session/start') {
    if (hrvSession.active) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session already active', sessionStart: hrvSession.sessionStart }));
      return;
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `session-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
    console.log('[HRV-SESSION] START called, setting active=true');
    hrvSession = {
      active: true,
      filePath: path.join(HRV_SESSIONS_DIR, filename),
      sessionStart: now.toISOString(),
      samples: [],
      sampleTimer: null
    };
    console.log('[HRV-SESSION] START done, hrvSession.active =', hrvSession.active);
    fs.writeFileSync('/tmp/hrv-session-started.json', JSON.stringify({ active: hrvSession.active, time: new Date().toISOString() }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessionStart: hrvSession.sessionStart, filename }));
    return;
  }

  // POST /api/hrv-session/stop — 结束记录（含练习报告）
  if (req.method === 'POST' && req.url === '/api/hrv-session/stop') {
    if (!hrvSession.active) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session' }));
      return;
    }
    const sessionEnd = new Date().toISOString();
    const samples = hrvSession.samples;
    
    // Generate practice report
    let report = null;
    if (samples.length >= 2) {
      const rmssdValues = samples.map(s => s.rmssd).filter(v => v > 0);
      const hrValues = samples.map(s => s.heartRate).filter(v => v > 0);
      
      if (rmssdValues.length >= 2) {
        const firstThird = Math.max(1, Math.floor(rmssdValues.length * 0.2));
        const lastThird = Math.max(1, Math.floor(rmssdValues.length * 0.2));
        const rmssdBefore = rmssdValues.slice(0, firstThird).reduce((a, b) => a + b, 0) / firstThird;
        const rmssdAfter = rmssdValues.slice(-lastThird).reduce((a, b) => a + b, 0) / lastThird;
        const rmssdMax = Math.max(...rmssdValues);
        const hrRange = hrValues.length >= 2 ? Math.max(...hrValues) - Math.min(...hrValues) : 0;
        
        // Calculate duration
        const startMs = new Date(hrvSession.sessionStart).getTime();
        const endMs = new Date(sessionEnd).getTime();
        const durationMin = Math.round((endMs - startMs) / 60000);
        const durationStr = durationMin >= 60 
          ? Math.floor(durationMin / 60) + '时' + (durationMin % 60) + '分' 
          : durationMin + '分钟';
        
        report = {
          rmssdBefore: Math.round(rmssdBefore * 10) / 10,
          rmssdAfter: Math.round(rmssdAfter * 10) / 10,
          rmssdMax: Math.round(rmssdMax * 10) / 10,
          hrRange: Math.round(hrRange * 10) / 10,
          duration: durationStr
        };
      }
    }
    
    const sessionData = {
      sessionStart: hrvSession.sessionStart,
      sessionEnd,
      type: 'baseline',
      samples,
      report
    };
    try {
      fs.writeFileSync(hrvSession.filePath, JSON.stringify(sessionData, null, 2));
    } catch (e) {
      console.error('Failed to write session file:', e);
    }
    console.log('[HRV-SESSION] STOP called, was active:', hrvSession.active);
    hrvSession = { active: false, filePath: null, sessionStart: null, samples: [], sampleTimer: null };
    console.log('[HRV-SESSION] STOP done');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessionEnd, sampleCount: sessionData.samples.length, report }));
    return;
  }

  // GET /api/hrv-session/current — 获取当前记录状态
  if (req.method === 'GET' && req.url === '/api/hrv-session/current') {
    console.log('[HRV-SESSION] CURRENT called, hrvSession.active =', hrvSession.active, 'hrvSession keys:', Object.keys(hrvSession));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      active: hrvSession.active,
      sessionStart: hrvSession.sessionStart,
      sampleCount: hrvSession.samples.length
    }, null, 2));
    return;
  }

  // POST /api/hrv-session/sample — 推送一条采样数据
  if (req.method === 'POST' && req.url === '/api/hrv-session/sample') {
    if (!hrvSession.active) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session' }));
      return;
    }
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const sample = {
        timestamp: new Date().toISOString(),
        heartRate: data.heartRate ?? 0,
        rmssd: data.rmssd ?? 0,
        sdnn: data.sdnn ?? 0,
        hrvLevel: data.hrvLevel ?? 'none'
      };
      hrvSession.samples.push(sample);
      // Append to file each sample for durability
      const sessionData = {
        sessionStart: hrvSession.sessionStart,
        sessionEnd: null,
        type: 'baseline',
        samples: hrvSession.samples
      };
      try {
        fs.writeFileSync(hrvSession.filePath, JSON.stringify(sessionData, null, 2));
      } catch (e) {
        console.error('Failed to append sample to file:', e);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sampleCount: hrvSession.samples.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // ===== Resonance Test & Trend Endpoints =====

  // POST /api/hrv-session/resonance-test — 保存共振频率测定报告
  if (req.method === 'POST' && req.url === '/api/hrv-session/resonance-test') {
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `resonance-test-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
      const filePath = path.join(HRV_SESSIONS_DIR, filename);
      const reportData = {
        type: 'resonance-test',
        timestamp: data.timestamp || now.toISOString(),
        results: data.results,
        recommendedFreq: data.recommendedFreq,
        recommendedSDNN: data.recommendedSDNN,
        recommendedHROsc: data.recommendedHROsc
      };
      fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2));
      console.log(`[RESONANCE-TEST] Report saved: ${filename}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // GET /api/hrv-session/trend — 周度RMSSD趋势数据
  if (req.method === 'GET' && req.url === '/api/hrv-session/trend') {
    try {
      // Read all session files from the sessions directory
      const files = fs.readdirSync(HRV_SESSIONS_DIR).filter(f => f.startsWith('session-') && f.endsWith('.json'));
      
      // Group by date, compute daily average baseline RMSSD
      const dailyRMSSD = {};
      
      for (const file of files) {
        try {
          const filePath = path.join(HRV_SESSIONS_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const session = JSON.parse(content);
          
          if (!session.samples || session.samples.length < 2) continue;
          
          // Get date from session start
          const startDate = session.sessionStart ? session.sessionStart.slice(0, 10) : null;
          if (!startDate) continue;
          
          // Calculate average RMSSD for this session (baseline = first 20%)
          const rmssdValues = session.samples.map(s => s.rmssd).filter(v => v > 0);
          if (rmssdValues.length < 2) continue;
          
          const firstThird = Math.max(1, Math.floor(rmssdValues.length * 0.2));
          const baselineRMSSD = rmssdValues.slice(0, firstThird).reduce((a, b) => a + b, 0) / firstThird;
          
          if (!dailyRMSSD[startDate]) {
            dailyRMSSD[startDate] = [];
          }
          dailyRMSSD[startDate].push(Math.round(baselineRMSSD * 10) / 10);
        } catch (e) {
          // Skip invalid files
        }
      }
      
      // Compute daily averages and sort by date
      const trendData = Object.entries(dailyRMSSD)
        .map(([date, values]) => ({
          date,
          avgRMSSD: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
          sessionCount: values.length
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-7); // Last 7 days
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trendData));
    } catch (e) {
      console.error('Failed to generate trend data:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate trend data' }));
    }
    return;
  }

  // ===== Doctor 控制端点 =====

  // POST /api/control/preset — 切换预设
  // body: { "preset": "meditate" | "sleep" | "focus" | "nature" | "healing" }
  if (req.method === 'POST' && req.url === '/api/control/preset') {
    const body = await readBody(req);
    try {
      const { preset } = JSON.parse(body);
      const validPresets = ['meditate', 'sleep', 'focus', 'nature', 'healing'];
      if (!validPresets.includes(preset)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid preset. Valid: ${validPresets.join(', ')}` }));
        return;
      }
      broadcastControl({ action: 'preset', preset });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'preset', preset }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /api/control/breath — 切换呼吸模式
  // body: { "mode": "478" | "resonance", "active": true|false }
  if (req.method === 'POST' && req.url === '/api/control/breath') {
    const body = await readBody(req);
    try {
      const { mode, active } = JSON.parse(body);
      const validModes = ['478', 'resonance'];
      if (mode && !validModes.includes(mode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid mode. Valid: ${validModes.join(', ')}` }));
        return;
      }
      broadcastControl({ action: 'breath', mode: mode || '478', active: active !== false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'breath', mode, active }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /api/control/volume — 调整音量
  // body: { "sound": "theta"|"bowl"|..., "volume": 0.0-1.0 } 或 { "all": true, "volume": 0.0-1.0 }
  if (req.method === 'POST' && req.url === '/api/control/volume') {
    const body = await readBody(req);
    try {
      const { sound, volume, all } = JSON.parse(body);
      const vol = Math.max(0, Math.min(1, volume));
      if (all) {
        broadcastControl({ action: 'volume_all', volume: vol });
      } else if (sound) {
        broadcastControl({ action: 'volume', sound, volume: vol });
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Specify "sound" or "all": true' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: all ? 'volume_all' : 'volume', sound, volume: vol }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /api/control/smart — 开关智能推荐
  // body: { "active": true|false }
  if (req.method === 'POST' && req.url === '/api/control/smart') {
    const body = await readBody(req);
    try {
      const { active } = JSON.parse(body);
      broadcastControl({ action: 'smart', active: !!active });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'smart', active: !!active }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /api/control/sound — 开关单个声音
  // body: { "sound": "theta"|"bowl"|..., "active": true|false }
  if (req.method === 'POST' && req.url === '/api/control/sound') {
    const body = await readBody(req);
    try {
      const { sound, active } = JSON.parse(body);
      if (!sound) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "sound"' }));
        return;
      }
      broadcastControl({ action: 'sound', sound, active: active !== false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'sound', sound, active: active !== false }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // POST /api/control/stop — 停止所有声音
  if (req.method === 'POST' && req.url === '/api/control/stop') {
    broadcastControl({ action: 'stop_all' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action: 'stop_all' }));
    return;
  }

  // GET /api/control/status — 获取当前控制状态
  if (req.method === 'GET' && req.url === '/api/control/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      lastControlResult,
      wsClients: clients.size,
      hrv: latestHRV
    }, null, 2));
    return;
  }

  // Static files
  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.join(STATIC_DIR, filePath);
  const ext = path.extname(fullPath).toLowerCase();

  if (!fullPath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket升级处理
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/hrv') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`🫀 HRV Real-time Server running on http://localhost:${PORT}`);
  console.log(`   Static files: ${STATIC_DIR}`);
  console.log(`   HRV Data:`);
  console.log(`     GET  /api/hrv         — latest HRV data`);
  console.log(`     GET  /api/hrv/history — 5min HRV history`);
  console.log(`     POST /api/hrv         — push HRV data (each heartbeat)`);
  console.log(`     WS   ws://localhost:${PORT}/ws/hrv — real-time stream`);
  console.log(`   Doctor Control:`);
  console.log(`     POST /api/control/preset  — switch preset {preset: "meditate|sleep|focus|nature|healing"}`);
  console.log(`     POST /api/control/breath  — breathing {mode: "478|resonance", active: bool}`);
  console.log(`     POST /api/control/volume  — adjust volume {sound: "id", volume: 0-1} or {all: true, volume: 0-1}`);
  console.log(`     POST /api/control/sound   — toggle sound {sound: "id", active: bool}`);
  console.log(`     POST /api/control/smart   — smart mode {active: bool}`);
  console.log(`     POST /api/control/stop    — stop all sounds`);
  console.log(`     GET  /api/control/status  — control status`);
  console.log(`   HRV Session Recording:`);
  console.log(`     POST /api/hrv-session/start           — start recording session`);
  console.log(`     POST /api/hrv-session/stop            — stop recording session (returns practice report)`);
  console.log(`     GET  /api/hrv-session/current         — get current session status`);
  console.log(`     POST /api/hrv-session/sample          — push a sample (every 10s)`);
  console.log(`     POST /api/hrv-session/resonance-test  — save resonance test report`);
  console.log(`     GET  /api/hrv-session/trend           — weekly RMSSD trend data`);
  console.log(`   File backup: /tmp/hrv-latest.json`);
});
