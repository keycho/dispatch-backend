import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// WEBSOCKET CLIENTS
// ============================================

const clients = new Set();

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);
  
  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    incidents: incidentStore.getAll(),
    cameras: cameraStore.cameras,
    stats: getStats()
  }));
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'manual_transcript') {
        await processTranscript(data.text, 'manual');
      }
    } catch (error) {
      console.error('[WS] Message error:', error.message);
    }
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

// ============================================
// NYC CONFIGURATION
// ============================================

const NYC_BOUNDS = {
  lowerLatitude: 40.4774,
  upperLatitude: 40.9176,
  lowerLongitude: -74.2591,
  upperLongitude: -73.7004
};

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];

const PRECINCT_TO_BOROUGH = {
  '1': 'Manhattan', '5': 'Manhattan', '6': 'Manhattan', '7': 'Manhattan', '9': 'Manhattan',
  '10': 'Manhattan', '13': 'Manhattan', '14': 'Manhattan', '17': 'Manhattan', '18': 'Manhattan',
  '19': 'Manhattan', '20': 'Manhattan', '22': 'Manhattan', '23': 'Manhattan', '24': 'Manhattan',
  '25': 'Manhattan', '26': 'Manhattan', '28': 'Manhattan', '30': 'Manhattan', '32': 'Manhattan',
  '33': 'Manhattan', '34': 'Manhattan',
  '40': 'Bronx', '41': 'Bronx', '42': 'Bronx', '43': 'Bronx', '44': 'Bronx',
  '45': 'Bronx', '46': 'Bronx', '47': 'Bronx', '48': 'Bronx', '49': 'Bronx',
  '50': 'Bronx', '52': 'Bronx',
  '60': 'Brooklyn', '61': 'Brooklyn', '62': 'Brooklyn', '63': 'Brooklyn', '66': 'Brooklyn',
  '67': 'Brooklyn', '68': 'Brooklyn', '69': 'Brooklyn', '70': 'Brooklyn', '71': 'Brooklyn',
  '72': 'Brooklyn', '73': 'Brooklyn', '75': 'Brooklyn', '76': 'Brooklyn', '77': 'Brooklyn',
  '78': 'Brooklyn', '79': 'Brooklyn', '81': 'Brooklyn', '83': 'Brooklyn', '84': 'Brooklyn',
  '88': 'Brooklyn', '90': 'Brooklyn', '94': 'Brooklyn',
  '100': 'Queens', '101': 'Queens', '102': 'Queens', '103': 'Queens', '104': 'Queens',
  '105': 'Queens', '106': 'Queens', '107': 'Queens', '108': 'Queens', '109': 'Queens',
  '110': 'Queens', '111': 'Queens', '112': 'Queens', '113': 'Queens', '114': 'Queens', '115': 'Queens',
  '120': 'Staten Island', '121': 'Staten Island', '122': 'Staten Island', '123': 'Staten Island'
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Haversine formula - distance in meters
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + 
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Radius to bounding box
function radiusToBbox(lat, lng, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta
  };
}

// Infer severity from incident type
function inferSeverity(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('shots fired') || t.includes('shooting') || t.includes('homicide') || t.includes('stabbing')) return 'critical';
  if (t.includes('assault') || t.includes('robbery') || t.includes('pursuit') || t.includes('fire')) return 'high';
  if (t.includes('burglary') || t.includes('theft') || t.includes('accident')) return 'medium';
  return 'low';
}

// Get borough from precinct number
function getPrecinctBorough(precinctNum) {
  const num = precinctNum.toString().replace(/\D/g, '');
  return PRECINCT_TO_BOROUGH[num] || null;
}

// ============================================
// INCIDENT STORE
// ============================================

const incidentStore = {
  scanner: [],      // From police scanner
  citizen: [],      // From Citizen API
  merged: [],       // Deduplicated combined
  maxAge: 2 * 60 * 60 * 1000, // 2 hours
  
  addScanner(incident) {
    incident.source = 'scanner';
    incident.sourceIcon = '🔴';
    this.scanner.unshift(incident);
    this.cleanup();
    this.deduplicate();
    return incident;
  },
  
  addCitizen(incidents) {
    this.citizen = incidents.map(inc => ({
      ...inc,
      source: 'citizen',
      sourceIcon: '🟡'
    }));
    this.deduplicate();
  },
  
  deduplicate() {
    const now = Date.now();
    const DISTANCE_THRESHOLD = 300; // meters
    const TIME_THRESHOLD = 15 * 60 * 1000; // 15 minutes
    
    const merged = [];
    const usedCitizen = new Set();
    
    // Start with scanner incidents (they're faster/more authoritative)
    for (const scanner of this.scanner) {
      const scannerTime = new Date(scanner.timestamp).getTime();
      
      // Find matching citizen incident
      let match = null;
      for (let i = 0; i < this.citizen.length; i++) {
        if (usedCitizen.has(i)) continue;
        
        const citizen = this.citizen[i];
        const citizenTime = new Date(citizen.timestamp).getTime();
        const timeDiff = Math.abs(scannerTime - citizenTime);
        
        if (timeDiff > TIME_THRESHOLD) continue;
        
        // Check distance if both have coordinates
        if (scanner.latitude && scanner.longitude && citizen.latitude && citizen.longitude) {
          const distance = haversine(
            scanner.latitude, scanner.longitude,
            citizen.latitude, citizen.longitude
          );
          
          if (distance <= DISTANCE_THRESHOLD) {
            match = { index: i, citizen };
            break;
          }
        }
        
        // Fallback: fuzzy location match
        if (scanner.location && citizen.location) {
          const scannerLoc = scanner.location.toLowerCase();
          const citizenLoc = citizen.location.toLowerCase();
          if (scannerLoc.includes(citizenLoc) || citizenLoc.includes(scannerLoc)) {
            match = { index: i, citizen };
            break;
          }
        }
      }
      
      if (match) {
        // Merge - scanner is primary, enhance with citizen data
        usedCitizen.add(match.index);
        merged.push({
          ...scanner,
          source: 'both',
          sourceIcon: '🟢',
          citizenId: match.citizen.id,
          citizenTitle: match.citizen.title,
          mediaUrl: match.citizen.mediaUrl || null,
          updates: match.citizen.updates || []
        });
      } else {
        merged.push(scanner);
      }
    }
    
    // Add unmatched citizen incidents
    for (let i = 0; i < this.citizen.length; i++) {
      if (!usedCitizen.has(i)) {
        merged.push(this.citizen[i]);
      }
    }
    
    // Sort by timestamp (newest first)
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    this.merged = merged;
  },
  
  cleanup() {
    const cutoff = Date.now() - this.maxAge;
    this.scanner = this.scanner.filter(inc => new Date(inc.timestamp).getTime() > cutoff);
  },
  
  getAll() {
    return this.merged;
  },
  
  getBySource(source) {
    if (source === 'scanner') return this.scanner;
    if (source === 'citizen') return this.citizen;
    return this.merged;
  }
};

// ============================================
// CITIZEN API FETCHER
// ============================================

class CitizenFetcher {
  constructor() {
    this.cache = { data: null, timestamp: 0 };
    this.cacheTTL = 30000; // 30 seconds
    this.lastFetch = 0;
    this.minInterval = 5000; // 5 second rate limit
    this.backoffMs = 1000;
    this.maxBackoff = 60000;
    this.consecutiveErrors = 0;
    this.userAgents = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    ];
  }
  
  async fetch() {
    const now = Date.now();
    
    // Return cache if valid
    if (this.cache.data && (now - this.cache.timestamp) < this.cacheTTL) {
      return { data: this.cache.data, fromCache: true };
    }
    
    // Rate limiting
    const timeSinceLastFetch = now - this.lastFetch;
    if (timeSinceLastFetch < this.minInterval) {
      if (this.cache.data) {
        return { data: this.cache.data, fromCache: true };
      }
      await new Promise(r => setTimeout(r, this.minInterval - timeSinceLastFetch));
    }
    
    // Exponential backoff on errors
    if (this.consecutiveErrors > 0) {
      const backoff = Math.min(this.backoffMs * Math.pow(2, this.consecutiveErrors - 1), this.maxBackoff);
      await new Promise(r => setTimeout(r, backoff));
    }
    
    this.lastFetch = Date.now();
    
    try {
      const url = new URL('https://citizen.com/api/incident/trending');
      url.searchParams.set('lowerLatitude', NYC_BOUNDS.lowerLatitude);
      url.searchParams.set('lowerLongitude', NYC_BOUNDS.lowerLongitude);
      url.searchParams.set('upperLatitude', NYC_BOUNDS.upperLatitude);
      url.searchParams.set('upperLongitude', NYC_BOUNDS.upperLongitude);
      url.searchParams.set('fullResponse', 'true');
      url.searchParams.set('limit', '200');
      
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': this.userAgents[Math.floor(Math.random() * this.userAgents.length)],
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 10000
      });
      
      if (!response.ok) {
        throw new Error(`Citizen API ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const incidents = this.normalize(data.results || data || []);
      
      this.cache = { data: incidents, timestamp: Date.now() };
      this.consecutiveErrors = 0;
      this.backoffMs = 1000;
      
      console.log(`[CITIZEN] Fetched ${incidents.length} incidents`);
      return { data: incidents, fromCache: false };
      
    } catch (error) {
      this.consecutiveErrors++;
      console.error(`[CITIZEN] Fetch error (attempt ${this.consecutiveErrors}):`, error.message);
      
      // Return stale cache on error
      if (this.cache.data) {
        return { data: this.cache.data, fromCache: true, stale: true };
      }
      
      return { data: [], error: error.message };
    }
  }
  
  normalize(raw) {
    if (!Array.isArray(raw)) return [];
    
    return raw.map(inc => {
      const created = inc.created || inc.ts || Date.now();
      
      return {
        id: `citizen_${inc.key || inc.id || created}`,
        title: inc.title || 'Unknown Incident',
        incidentType: this.categorize(inc.title, inc.category),
        location: inc.address || inc.location || 'NYC',
        borough: this.inferBorough(inc),
        latitude: inc.latitude || inc.lat,
        longitude: inc.longitude || inc.lng,
        timestamp: new Date(created).toISOString(),
        severity: inferSeverity(inc.title),
        updates: (inc.updates || []).map(u => ({
          text: u.text,
          timestamp: new Date(u.created || u.ts).toISOString()
        })),
        raw: inc.raw || null,
        mediaUrl: inc.mediaURL || inc.videoURL || null,
        source: 'citizen',
        sourceIcon: '🟡'
      };
    }).filter(inc => inc.latitude && inc.longitude);
  }
  
  categorize(title, category) {
    const t = (title || '').toLowerCase();
    if (t.includes('shooting') || t.includes('shots fired') || t.includes('shot')) return 'Shots Fired';
    if (t.includes('stabbing') || t.includes('stabbed')) return 'Stabbing';
    if (t.includes('robbery') || t.includes('robbed')) return 'Robbery';
    if (t.includes('assault') || t.includes('attacked')) return 'Assault';
    if (t.includes('fire') || t.includes('burning')) return 'Fire';
    if (t.includes('accident') || t.includes('crash') || t.includes('collision')) return 'Vehicle Accident';
    if (t.includes('pursuit') || t.includes('chase')) return 'Pursuit';
    if (t.includes('suspicious')) return 'Suspicious Activity';
    return category || 'Other';
  }
  
  inferBorough(inc) {
    const addr = (inc.address || inc.location || '').toLowerCase();
    if (addr.includes('manhattan') || addr.includes('midtown') || addr.includes('harlem')) return 'Manhattan';
    if (addr.includes('brooklyn') || addr.includes('bushwick') || addr.includes('bedstuy')) return 'Brooklyn';
    if (addr.includes('bronx')) return 'Bronx';
    if (addr.includes('queens') || addr.includes('jamaica') || addr.includes('flushing')) return 'Queens';
    if (addr.includes('staten island')) return 'Staten Island';
    
    // Infer from coordinates
    if (inc.latitude && inc.longitude) {
      const lat = inc.latitude;
      const lng = inc.longitude;
      if (lat > 40.7 && lat < 40.83 && lng > -74.02 && lng < -73.93) return 'Manhattan';
      if (lat > 40.57 && lat < 40.74 && lng > -74.04 && lng < -73.83) return 'Brooklyn';
      if (lat > 40.78 && lng > -73.93) return 'Bronx';
      if (lat > 40.54 && lat < 40.8 && lng > -73.96 && lng < -73.7) return 'Queens';
      if (lng < -74.05) return 'Staten Island';
    }
    
    return 'Unknown';
  }
}

const citizenFetcher = new CitizenFetcher();

// Poll Citizen API every 30 seconds
setInterval(async () => {
  const { data, fromCache } = await citizenFetcher.fetch();
  if (data.length > 0 && !fromCache) {
    incidentStore.addCitizen(data);
    broadcast({
      type: 'citizen_update',
      count: data.length,
      incidents: incidentStore.merged.slice(0, 50)
    });
  }
}, 30000);

// Initial fetch
setTimeout(() => citizenFetcher.fetch().then(({ data }) => {
  if (data.length > 0) incidentStore.addCitizen(data);
}), 2000);

// ============================================
// CAMERA STORE
// ============================================

const cameraStore = {
  cameras: [],
  lastFetch: 0,
  
  async fetch() {
    try {
      const response = await fetch('https://webcams.nyctmc.org/api/cameras', {
        timeout: 15000
      });
      
      if (!response.ok) throw new Error(`Camera API ${response.status}`);
      
      const data = await response.json();
      this.cameras = (data || []).map(cam => ({
        id: cam.id || cam.cameraId,
        name: cam.name || cam.cameraName,
        latitude: cam.latitude || cam.lat,
        longitude: cam.longitude || cam.lng,
        url: cam.url || cam.streamUrl,
        borough: this.inferBorough(cam)
      })).filter(cam => cam.latitude && cam.longitude);
      
      this.lastFetch = Date.now();
      console.log(`[CAMERAS] Loaded ${this.cameras.length} cameras`);
      return this.cameras;
      
    } catch (error) {
      console.error('[CAMERAS] Fetch error:', error.message);
      return this.cameras;
    }
  },
  
  inferBorough(cam) {
    const name = (cam.name || '').toLowerCase();
    if (name.includes('manhattan') || name.includes('fdr') || name.includes('west side')) return 'Manhattan';
    if (name.includes('brooklyn') || name.includes('bqe')) return 'Brooklyn';
    if (name.includes('bronx') || name.includes('cross bronx')) return 'Bronx';
    if (name.includes('queens') || name.includes('lie') || name.includes('lga')) return 'Queens';
    if (name.includes('staten') || name.includes('si ')) return 'Staten Island';
    return 'Unknown';
  },
  
  getNearby(lat, lng, radiusMeters = 500) {
    return this.cameras.filter(cam => {
      const distance = haversine(lat, lng, cam.latitude, cam.longitude);
      return distance <= radiusMeters;
    }).map(cam => ({
      ...cam,
      distance: Math.round(haversine(lat, lng, cam.latitude, cam.longitude))
    })).sort((a, b) => a.distance - b.distance);
  },
  
  getInBbox(minLat, maxLat, minLng, maxLng) {
    return this.cameras.filter(cam => 
      cam.latitude >= minLat && cam.latitude <= maxLat &&
      cam.longitude >= minLng && cam.longitude <= maxLng
    );
  }
};

// Load cameras on startup
cameraStore.fetch();
setInterval(() => cameraStore.fetch(), 5 * 60 * 1000); // Refresh every 5 minutes

// ============================================
// SCANNER TRANSCRIPTION
// ============================================

let incidentId = 0;

async function processTranscript(text, feedName = 'unknown') {
  if (!text || text.length < 10) return null;
  
  console.log(`[SCANNER] Processing: "${text.substring(0, 80)}..."`);
  
  broadcast({
    type: 'transcript',
    text,
    feedName,
    timestamp: new Date().toISOString()
  });
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: `You are an NYPD radio dispatcher analyst. Extract incident details from police radio transmissions.
      
Respond in JSON only:
{
  "isIncident": true/false,
  "incidentType": "string (e.g., Shots Fired, Robbery, Assault, Vehicle Accident, Pursuit)",
  "location": "street address or intersection",
  "borough": "Manhattan/Brooklyn/Bronx/Queens/Staten Island",
  "precinct": "number if mentioned",
  "units": ["unit IDs responding"],
  "summary": "brief description",
  "severity": "critical/high/medium/low"
}

If it's just chatter/acknowledgment with no actionable incident, return {"isIncident": false}.`,
      messages: [{
        role: 'user',
        content: `Analyze this NYPD radio transmission:\n\n"${text}"`
      }]
    });
    
    const content = response.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) return null;
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!parsed.isIncident) {
      console.log('[SCANNER] Not an incident, skipping');
      return null;
    }
    
    // Try to get borough from precinct if not provided
    if (!parsed.borough && parsed.precinct) {
      parsed.borough = getPrecinctBorough(parsed.precinct) || 'Unknown';
    }
    
    const incident = {
      id: ++incidentId,
      ...parsed,
      timestamp: new Date().toISOString(),
      feedName,
      source: 'scanner',
      sourceIcon: '🔴',
      latitude: null,
      longitude: null
    };
    
    // TODO: Geocode location to get lat/lng
    
    incidentStore.addScanner(incident);
    
    broadcast({
      type: 'incident',
      incident
    });
    
    console.log(`[SCANNER] New incident #${incident.id}: ${incident.incidentType} @ ${incident.location}`);
    
    return incident;
    
  } catch (error) {
    console.error('[SCANNER] Analysis error:', error.message);
    return null;
  }
}

// ============================================
// STATS
// ============================================

function getStats() {
  const incidents = incidentStore.merged;
  const last24h = incidents.filter(inc => 
    Date.now() - new Date(inc.timestamp).getTime() < 24 * 60 * 60 * 1000
  );
  
  const byBorough = {};
  const byType = {};
  const bySource = { scanner: 0, citizen: 0, both: 0 };
  
  for (const inc of last24h) {
    byBorough[inc.borough] = (byBorough[inc.borough] || 0) + 1;
    byType[inc.incidentType] = (byType[inc.incidentType] || 0) + 1;
    bySource[inc.source] = (bySource[inc.source] || 0) + 1;
  }
  
  return {
    total: incidents.length,
    last24h: last24h.length,
    byBorough,
    byType,
    bySource,
    cameras: cameraStore.cameras.length,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/', (req, res) => {
  res.json({
    name: 'DISPATCH NYC',
    version: '2.0.0',
    status: 'operational',
    endpoints: [
      '/health',
      '/incidents',
      '/incidents/scanner',
      '/incidents/citizen',
      '/incidents/merged',
      '/cameras',
      '/cameras/focus',
      '/stats'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// All merged incidents
app.get('/incidents', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({
    incidents: incidentStore.merged.slice(0, limit),
    total: incidentStore.merged.length
  });
});

// Scanner-only incidents
app.get('/incidents/scanner', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({
    incidents: incidentStore.scanner.slice(0, limit),
    total: incidentStore.scanner.length,
    source: 'scanner'
  });
});

// Citizen-only incidents
app.get('/incidents/citizen', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({
    incidents: incidentStore.citizen.slice(0, limit),
    total: incidentStore.citizen.length,
    source: 'citizen'
  });
});

// Merged/deduplicated incidents
app.get('/incidents/merged', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const borough = req.query.borough;
  
  let incidents = incidentStore.merged;
  
  if (borough) {
    incidents = incidents.filter(inc => 
      inc.borough?.toLowerCase() === borough.toLowerCase()
    );
  }
  
  res.json({
    incidents: incidents.slice(0, limit),
    total: incidents.length,
    deduplication: {
      scannerCount: incidentStore.scanner.length,
      citizenCount: incidentStore.citizen.length,
      mergedCount: incidentStore.merged.length
    }
  });
});

// All cameras
app.get('/cameras', (req, res) => {
  res.json({
    cameras: cameraStore.cameras,
    total: cameraStore.cameras.length
  });
});

// Focus mode - cameras near a point
app.get('/cameras/focus', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseInt(req.query.radius) || 500; // meters
  
  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng required' });
  }
  
  const cameras = cameraStore.getNearby(lat, lng, radius);
  
  res.json({
    cameras,
    total: cameras.length,
    center: { lat, lng },
    radius
  });
});

// Cameras in bounding box
app.get('/cameras/bbox', (req, res) => {
  const minLat = parseFloat(req.query.minLat);
  const maxLat = parseFloat(req.query.maxLat);
  const minLng = parseFloat(req.query.minLng);
  const maxLng = parseFloat(req.query.maxLng);
  
  if (!minLat || !maxLat || !minLng || !maxLng) {
    return res.status(400).json({ error: 'minLat, maxLat, minLng, maxLng required' });
  }
  
  const cameras = cameraStore.getInBbox(minLat, maxLat, minLng, maxLng);
  
  res.json({
    cameras,
    total: cameras.length,
    bbox: { minLat, maxLat, minLng, maxLng }
  });
});

// Stats
app.get('/stats', (req, res) => {
  res.json(getStats());
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         DISPATCH NYC v2.0.0              ║
║         Police Scanner + Citizen         ║
╠══════════════════════════════════════════╣
║  HTTP: http://localhost:${PORT}              ║
║  WS:   ws://localhost:${PORT}                ║
╚══════════════════════════════════════════╝
  `);
});
