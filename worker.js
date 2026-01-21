// ============================================
// DISPATCH WORKER - Data Collection Process
// ============================================
// Handles: Broadcastify Calls API, Legacy Streams, OpenMHz, 
// NYC Data Sync, Camera Fetching, Whisper Transcription, Claude Parsing

import https from 'https';
import crypto from 'crypto';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';

import { 
  CITIES, NYPD_FEEDS, MPLS_FEEDS, ALL_FEEDS,
  OPENMHZ_SYSTEMS, OPENMHZ_POLL_INTERVAL,
  BCFY_API_URL, NYC_COUNTY_ID, BCFY_POLL_INTERVAL,
  PRECINCT_TO_BOROUGH, getPrecinctBorough,
  CHUNK_DURATION, MAX_CONCURRENT_STREAMS, MAX_TRANSCRIPTS, MAX_AUDIO_CLIPS, MAX_PROCESSED_CACHE,
  NOISE_PATTERNS, PROMPT_LEAKAGE_PATTERNS, SIGN_OFF_PATTERNS, GARBAGE_PATTERNS,
  REDIS_CHANNELS
} from './shared/constants.js';

import { 
  initPool, getPool, initDatabase,
  saveIncidentToDb, saveScannerArrest, saveArrestToDb, save911CallToDb, saveInmateToDb,
  logDataSync
} from './shared/database.js';

import {
  initRedis, publish,
  publishIncident, publishTranscript, publishCameraSwitch, publishICEAlert,
  updateWorkerStats, updateCityState
} from './shared/redis.js';

dotenv.config();

// ============================================
// INITIALIZE CLIENTS
// ============================================

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================
// STATE MANAGEMENT
// ============================================

// Per-city state
const cityState = {};
Object.keys(CITIES).forEach(cityId => {
  cityState[cityId] = {
    cameras: [],
    incidents: [],
    recentTranscripts: [],
    recentTranscriptHashes: new Set(),
    incidentId: 0,
    activeStreams: new Map(),
    streamState: new Map(),
  };
});

// Global state
const audioClips = new Map();
const processedCallsCache = new Set();
const activeStreams = new Map();
const streamState = new Map();

// Stats
const workerStats = {
  startedAt: new Date().toISOString(),
  scanner: {
    activeFeeds: [],
    lastChunkTime: null,
    lastTranscript: null,
    totalChunks: 0,
    successfulTranscripts: 0,
    filteredNoise: 0,
    filteredPromptLeak: 0,
    filteredSignOff: 0,
    filteredGarbage: 0,
    filteredRepetitive: 0,
    feedStats: {}
  },
  bcfyCalls: {
    enabled: false,
    lastPoll: null,
    callsFetched: 0,
    callsProcessed: 0,
    errors: 0,
    lastError: null,
    groups: []
  },
  openMHz: {},
  dataSync: {
    lastArrestSync: null,
    last911Sync: null,
    lastInmateSync: null
  }
};

// OpenMHz state per city
const openMHzState = {};
Object.keys(OPENMHZ_SYSTEMS).forEach(cityId => {
  openMHzState[cityId] = {
    lastTime: Date.now() - (5 * 60 * 1000),
    stats: { callsFetched: 0, callsProcessed: 0, lastPoll: null, errors: 0, disabled: false, method: null }
  };
  workerStats.openMHz[cityId] = openMHzState[cityId].stats;
});

// ============================================
// BROADCASTIFY CREDENTIALS
// ============================================

const BROADCASTIFY_USERNAME = 'whitefang123';
const BROADCASTIFY_PASSWORD = process.env.BROADCASTIFY_PASSWORD;

// Broadcastify Calls API credentials
const BCFY_KEY_ID = process.env.BCFY_API_KEY_ID;
const BCFY_KEY_SECRET = process.env.BCFY_API_KEY_SECRET;
const BCFY_APP_ID = process.env.BCFY_APP_ID;

// Broadcastify user authentication (for Calls API)
let bcfyUserId = null;
let bcfyUserToken = null;
let bcfyAuthExpires = 0;

workerStats.bcfyCalls.enabled = !!(BCFY_KEY_ID && BCFY_KEY_SECRET && BCFY_APP_ID);

// ============================================
// BROADCASTIFY CALLS API (JWT Auth)
// ============================================

function generateBcfyJWT(includeUserAuth = false) {
  if (!BCFY_KEY_ID || !BCFY_KEY_SECRET || !BCFY_APP_ID) {
    console.log('[BCFY] Missing credentials - cannot generate JWT');
    return null;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  const header = { alg: 'HS256', typ: 'JWT', kid: BCFY_KEY_ID };
  const payload = { iss: BCFY_APP_ID, iat: now, exp: now + 3600 };
  
  // Add user authentication if available and requested
  if (includeUserAuth && bcfyUserId && bcfyUserToken) {
    payload.sub = bcfyUserId;
    payload.utk = bcfyUserToken;
  }
  
  const base64urlEncode = (obj) => {
    return Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };
  
  const headerEncoded = base64urlEncode(header);
  const payloadEncoded = base64urlEncode(payload);
  const signatureInput = `${headerEncoded}.${payloadEncoded}`;
  
  const signature = crypto
    .createHmac('sha256', BCFY_KEY_SECRET)
    .update(signatureInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  
  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

// Authenticate Broadcastify user to get userId and userToken
async function authenticateBcfyUser() {
  if (!BROADCASTIFY_USERNAME || !BROADCASTIFY_PASSWORD) {
    console.log('[BCFY AUTH] Missing BROADCASTIFY_USERNAME or BROADCASTIFY_PASSWORD');
    return false;
  }
  
  // Check if we already have valid auth
  if (bcfyUserId && bcfyUserToken && Date.now() < bcfyAuthExpires) {
    console.log('[BCFY AUTH] Using cached authentication');
    return true;
  }
  
  console.log('[BCFY AUTH] Authenticating user:', BROADCASTIFY_USERNAME);
  
  try {
    const jwt = generateBcfyJWT(false); // JWT without user auth for the auth endpoint
    if (!jwt) return false;
    
    const response = await fetch(`${BCFY_API_URL}/common/v1/auth`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: BROADCASTIFY_USERNAME,
        password: BROADCASTIFY_PASSWORD
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[BCFY AUTH] Failed:', response.status, errorText);
      return false;
    }
    
    const data = await response.json();
    
    if (data.userId && data.userToken) {
      bcfyUserId = data.userId;
      bcfyUserToken = data.userToken;
      bcfyAuthExpires = Date.now() + (3600 * 1000); // 1 hour
      console.log('[BCFY AUTH] Success! userId:', bcfyUserId);
      return true;
    } else {
      console.error('[BCFY AUTH] No userId/userToken in response:', data);
      return false;
    }
  } catch (error) {
    console.error('[BCFY AUTH] Error:', error.message);
    return false;
  }
}

async function bcfyApiRequest(endpoint, options = {}, requireAuth = true) {
  // Authenticate first if required
  if (requireAuth) {
    const authSuccess = await authenticateBcfyUser();
    if (!authSuccess) {
      throw new Error('Failed to authenticate Broadcastify user');
    }
  }
  
  const jwt = generateBcfyJWT(requireAuth); // Include user auth in JWT
  if (!jwt) throw new Error('Could not generate JWT - missing credentials');
  
  const url = `${BCFY_API_URL}${endpoint}`;
  console.log('[BCFY API] Request:', url);
  
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API ${response.status}: ${errorText}`);
    }
    
    return await response.json();
  } catch (error) {
    workerStats.bcfyCalls.errors++;
    workerStats.bcfyCalls.lastError = error.message;
    throw error;
  }
}

// NYPD System ID on RadioReference (for Broadcastify Calls)
const NYPD_SYSTEM_ID = 7636;

async function fetchNYCGroups() {
  try {
    const data = await bcfyApiRequest(`/calls/v1/groups?sid=${NYPD_SYSTEM_ID}`);
    workerStats.bcfyCalls.groups = data.groups || data || [];
    console.log(`[BCFY CALLS] Found ${workerStats.bcfyCalls.groups.length} groups in NYC`);
    return workerStats.bcfyCalls.groups;
  } catch (error) {
    console.error('[BCFY CALLS] Error fetching NYC groups:', error.message);
    return [];
  }
}

async function fetchLiveCalls() {
  if (!workerStats.bcfyCalls.enabled) return [];
  
  try {
    // Use sid parameter for NYPD system
    const data = await bcfyApiRequest(`/calls/v1/live?sid=${NYPD_SYSTEM_ID}`);
    workerStats.bcfyCalls.lastPoll = new Date().toISOString();
    workerStats.bcfyCalls.callsFetched += (data.calls?.length || 0);
    console.log(`[BCFY CALLS] Fetched ${data.calls?.length || 0} live calls`);
    return data.calls || data || [];
  } catch (error) {
    console.error('[BCFY CALLS] Error fetching live calls:', error.message);
    return [];
  }
}

async function downloadCallAudio(audioUrl) {
  try {
    const response = await fetch(audioUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error('[BCFY CALLS] Audio download error:', error.message);
    return null;
  }
}

async function processBcfyCall(call, cityId = 'nyc') {
  const callKey = `${call.groupId}-${call.ts}`;
  
  if (processedCallsCache.has(callKey)) return null;
  
  processedCallsCache.add(callKey);
  if (processedCallsCache.size > MAX_PROCESSED_CACHE) {
    const firstKey = processedCallsCache.values().next().value;
    processedCallsCache.delete(firstKey);
  }
  
  try {
    let audioUrl = call.audioUrl || call.url;
    if (!audioUrl) {
      const callDetails = await bcfyApiRequest(`/calls/v1/call/${call.groupId}/${call.ts}`);
      audioUrl = callDetails?.audioUrl || callDetails?.url;
    }
    
    if (!audioUrl) {
      console.log(`[BCFY CALLS] No audio URL for call ${callKey}`);
      return null;
    }
    
    const audioBuffer = await downloadCallAudio(audioUrl);
    if (!audioBuffer || audioBuffer.length < 1000) return null;
    
    const transcript = await transcribeAudio(audioBuffer);
    if (!transcript || transcript.trim().length < 5) return null;
    
    console.log(`[BCFY CALLS] Transcribed: "${transcript.substring(0, 100)}..."`);
    
    const parsed = await parseTranscriptForCity(transcript, cityId);
    
    if (!parsed.hasIncident) {
      await publishTranscript({
        text: transcript,
        source: `BCFY Calls: ${call.groupId}`,
        talkgroup: call.tg
      }, cityId);
      return null;
    }
    
    // Create incident
    const state = cityState[cityId];
    state.incidentId++;
    
    const camera = findNearestCameraForCity(parsed.location, parsed.borough, cityId);
    
    const audioId = `bcfy_${cityId}_${state.incidentId}_${Date.now()}`;
    audioClips.set(audioId, audioBuffer);
    if (audioClips.size > MAX_AUDIO_CLIPS) {
      audioClips.delete(audioClips.keys().next().value);
    }
    
    const incident = {
      id: state.incidentId,
      ...parsed,
      transcript,
      audioUrl: `/audio/${audioId}`,
      camera,
      lat: camera?.lat,
      lng: camera?.lng,
      source: `BCFY Calls: ${call.groupId}`,
      talkgroup: call.tg,
      talkgroupName: call.tgName || call.groupName,
      city: cityId,
      timestamp: new Date(call.ts * 1000).toISOString()
    };
    
    state.incidents.unshift(incident);
    if (state.incidents.length > 50) state.incidents.pop();
    
    // Save to database
    await saveIncidentToDb(incident);
    
    // Publish to Redis
    await publishIncident(incident, cityId);
    if (camera) {
      await publishCameraSwitch(camera, `${parsed.incidentType} at ${parsed.location}`, parsed.priority, cityId);
    }
    
    // Log scanner arrest if applicable
    if (parsed.isArrest) {
      await saveScannerArrest(incident, cityId);
    }
    
    workerStats.bcfyCalls.callsProcessed++;
    console.log(`[BCFY CALLS] 🚨 INCIDENT: ${incident.incidentType} @ ${incident.location} (${incident.borough})`);
    
    return incident;
  } catch (error) {
    console.error('[BCFY CALLS] Process error:', error.message);
    return null;
  }
}

async function pollBcfyCalls() {
  if (!workerStats.bcfyCalls.enabled) return;
  
  try {
    const calls = await fetchLiveCalls();
    for (const call of calls) {
      await processBcfyCall(call, 'nyc');
    }
  } catch (error) {
    console.error('[BCFY CALLS] Poll error:', error.message);
  }
}

function startBcfyCallsPolling() {
  if (!workerStats.bcfyCalls.enabled) {
    console.log('[BCFY CALLS] Disabled - missing credentials');
    return;
  }
  
  console.log('[BCFY CALLS] Starting live calls polling...');
  fetchNYCGroups();
  
  setInterval(pollBcfyCalls, BCFY_POLL_INTERVAL);
  setTimeout(pollBcfyCalls, 10000);
}

// ============================================
// LEGACY BROADCASTIFY STREAMS
// ============================================

function connectToFeed(feed) {
  if (!BROADCASTIFY_PASSWORD) return;
  if (activeStreams.has(feed.id)) return;
  
  console.log(`[MULTI-STREAM] Connecting to: ${feed.name} (${feed.id})`);
  
  const options = {
    hostname: 'audio.broadcastify.com', 
    port: 443, 
    path: `/${feed.id}.mp3`, 
    method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };
  
  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      console.log(`[MULTI-STREAM] ${feed.name} returned ${res.statusCode}`);
      activeStreams.delete(feed.id);
      setTimeout(() => startNextAvailableFeed(), 5000);
      return;
    }
    handleMultiStream(res, feed);
  });
  
  req.on('error', (err) => { 
    console.error(`[MULTI-STREAM] ${feed.name} error:`, err.message);
    activeStreams.delete(feed.id);
    setTimeout(() => startNextAvailableFeed(), 5000);
  });
  
  req.end();
  activeStreams.set(feed.id, { feed, req, connectedAt: Date.now() });
}

function handleMultiStream(stream, feed) {
  console.log(`[MULTI-STREAM] ✓ Connected to ${feed.name}`);
  
  streamState.set(feed.id, {
    chunks: [],
    lastDataTime: Date.now(),
    lastProcessTime: Date.now()
  });
  
  workerStats.scanner.activeFeeds = Array.from(activeStreams.keys()).map(id => 
    ALL_FEEDS.find(f => f.id === id)?.name || id
  );
  
  if (!workerStats.scanner.feedStats[feed.id]) {
    workerStats.scanner.feedStats[feed.id] = { name: feed.name, chunks: 0, incidents: 0 };
  }
  
  const heartbeat = setInterval(() => {
    const state = streamState.get(feed.id);
    if (!state) { clearInterval(heartbeat); return; }
    
    const silentTime = Date.now() - state.lastDataTime;
    if (silentTime > 90000) {
      console.log(`[MULTI-STREAM] ${feed.name} silent for ${Math.round(silentTime/1000)}s, reconnecting...`);
      clearInterval(heartbeat);
      stream.destroy();
      activeStreams.delete(feed.id);
      streamState.delete(feed.id);
      setTimeout(() => connectToFeed(feed), 3000);
    }
  }, 30000);
  
  stream.on('data', (chunk) => {
    const state = streamState.get(feed.id);
    if (!state) return;
    
    state.lastDataTime = Date.now();
    state.chunks.push(chunk);
    
    if (Date.now() - state.lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(state.chunks);
      state.chunks = [];
      state.lastProcessTime = Date.now();
      
      workerStats.scanner.lastChunkTime = new Date().toISOString();
      workerStats.scanner.totalChunks++;
      workerStats.scanner.feedStats[feed.id].chunks++;
      
      if (fullBuffer.length > 5000) {
        console.log(`[${feed.name}] Processing chunk (${Math.round(fullBuffer.length/1024)}KB)`);
        processAudioFromStream(fullBuffer, feed.name, feed.id);
      }
    }
  });
  
  stream.on('end', () => { 
    console.log(`[MULTI-STREAM] ${feed.name} ended, reconnecting...`);
    clearInterval(heartbeat);
    activeStreams.delete(feed.id);
    streamState.delete(feed.id);
    setTimeout(() => connectToFeed(feed), 3000);
  });
  
  stream.on('error', (err) => { 
    console.error(`[MULTI-STREAM] ${feed.name} error:`, err.message);
    clearInterval(heartbeat);
    activeStreams.delete(feed.id);
    streamState.delete(feed.id);
    setTimeout(() => connectToFeed(feed), 5000);
  });
}

function startNextAvailableFeed() {
  if (activeStreams.size >= MAX_CONCURRENT_STREAMS) return;
  
  const availableFeeds = ALL_FEEDS.filter(f => !activeStreams.has(f.id));
  if (availableFeeds.length === 0) return;
  
  connectToFeed(availableFeeds[0]);
}

function startMultiStreamBroadcastify() {
  if (!BROADCASTIFY_PASSWORD) { 
    console.log('[MULTI-STREAM] BROADCASTIFY_PASSWORD not set'); 
    return; 
  }
  
  console.log(`[MULTI-STREAM] Starting ${MAX_CONCURRENT_STREAMS} simultaneous feeds...`);
  
  const initialFeeds = [
    ...NYPD_FEEDS.slice(0, 3),
    ...MPLS_FEEDS.slice(0, 1),
  ].slice(0, MAX_CONCURRENT_STREAMS);
  
  initialFeeds.forEach((feed, i) => {
    setTimeout(() => connectToFeed(feed), i * 2000);
  });
}

// ============================================
// OPENMHZ INTEGRATION
// ============================================

async function startOpenMHzPolling() {
  console.log('[OPENMHZ] Starting polling mode for all cities...');
  
  for (const [cityId, config] of Object.entries(OPENMHZ_SYSTEMS)) {
    startCityPolling(cityId, config);
  }
}

async function startCityPolling(cityId, config) {
  let consecutiveErrors = 0;
  const state = openMHzState[cityId];
  
  async function pollCalls() {
    if (state.stats.disabled) return;
    
    try {
      const timeParam = state.lastTime;
      const url = `https://api.openmhz.com/${config.system}/calls/newer?time=${timeParam}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Origin': 'https://openmhz.com',
          'Referer': 'https://openmhz.com/'
        }
      });
      
      if (!response.ok) {
        consecutiveErrors++;
        state.stats.errors++;
        
        if (consecutiveErrors >= 5 && !state.stats.disabled) {
          console.log(`[OPENMHZ-${cityId.toUpperCase()}] API unavailable - disabled`);
          state.stats.disabled = true;
        }
        return;
      }
      
      if (!state.stats.method) {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] ✓ Connected via polling`);
        state.stats.method = 'polling';
      }
      
      consecutiveErrors = 0;
      const data = await response.json();
      state.stats.lastPoll = new Date().toISOString();
      
      const calls = Array.isArray(data.calls || data) ? (data.calls || data) : [];
      
      if (calls.length > 0) {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Processing ${calls.length} calls`);
        state.stats.callsFetched += calls.length;
        
        for (const call of calls.slice(0, 10)) {
          const callTime = new Date(call.time).getTime();
          if (callTime > state.lastTime) state.lastTime = callTime;
          
          if (call.url) processOpenMHzCall(call, cityId);
        }
      }
    } catch (error) {
      consecutiveErrors++;
      state.stats.errors++;
    }
  }
  
  await pollCalls();
  setInterval(pollCalls, OPENMHZ_POLL_INTERVAL);
}

async function processOpenMHzCall(call, cityId = 'nyc') {
  try {
    const audioResponse = await fetch(call.url);
    if (!audioResponse.ok) return;
    
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const transcript = await transcribeAudio(audioBuffer);
    if (!transcript || transcript.length < 10) return;
    
    const clean = transcript.trim();
    const lower = clean.toLowerCase();
    
    if (lower.length < 15 || lower.includes('fema.gov') || lower.includes('broadcastify')) return;
    
    openMHzState[cityId].stats.callsProcessed++;
    
    const state = cityState[cityId];
    const transcriptHash = clean.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (state.recentTranscriptHashes.has(transcriptHash)) return;
    
    state.recentTranscriptHashes.add(transcriptHash);
    if (state.recentTranscriptHashes.size > 100) {
      const hashArray = Array.from(state.recentTranscriptHashes);
      state.recentTranscriptHashes = new Set(hashArray.slice(-50));
    }
    
    const talkgroupName = call.talkgroupDescription || call.talkgroupTag || `TG ${call.talkgroupNum}`;
    console.log(`[OPENMHZ-${cityId.toUpperCase()}] (${talkgroupName}): "${clean.substring(0, 80)}..."`);
    
    const transcriptEntry = { 
      text: clean, 
      source: `OpenMHz: ${talkgroupName}`,
      talkgroup: call.talkgroupNum,
      city: cityId,
      timestamp: call.time || new Date().toISOString()
    };
    
    state.recentTranscripts.unshift(transcriptEntry);
    if (state.recentTranscripts.length > MAX_TRANSCRIPTS) state.recentTranscripts.pop();
    
    await publishTranscript(transcriptEntry, cityId);
    
    const parsed = await parseTranscriptForCity(clean, cityId);
    
    if (parsed.hasIncident) {
      state.incidentId++;
      const camera = findNearestCameraForCity(parsed.location, parsed.borough, cityId);
      
      const incident = {
        id: state.incidentId, 
        ...parsed, 
        transcript: clean,
        source: `OpenMHz: ${talkgroupName}`, 
        camera,
        lat: camera?.lat, 
        lng: camera?.lng,
        city: cityId,
        timestamp: call.time || new Date().toISOString()
      };
      
      state.incidents.unshift(incident);
      if (state.incidents.length > 50) state.incidents.pop();
      
      await saveIncidentToDb(incident);
      await publishIncident(incident, cityId);
      
      if (camera) {
        await publishCameraSwitch(camera, `${parsed.incidentType} at ${parsed.location}`, parsed.priority, cityId);
      }
      
      if (parsed.isArrest) {
        await saveScannerArrest(incident, cityId);
      }
      
      console.log(`[OPENMHZ-${cityId.toUpperCase()} INCIDENT]`, incident.incidentType, '@', incident.location, `(${incident.borough})`);
    }
  } catch (error) { /* silent */ }
}

// ============================================
// AUDIO PROCESSING & TRANSCRIPTION
// ============================================

async function transcribeAudio(audioBuffer) {
  try {
    const file = await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' });
    const transcription = await openai.audio.transcriptions.create({
      file, model: "whisper-1", language: "en",
      prompt: "NYPD police radio dispatch with locations. 10-4, 10-13, 10-85, K, forthwith, precinct, sector, central, responding. Addresses like 123 Main Street, intersections like 42nd and Lex, landmarks like Times Square, Penn Station."
    });
    return transcription.text;
  } catch (error) { 
    return null; 
  }
}

async function processAudioFromStream(buffer, feedName, feedId = null) {
  if (buffer.length < 5000) return;
  
  const transcript = await transcribeAudio(buffer);
  if (!transcript) return;
  if (transcript.trim().length < 10) return;
  
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  
  // Filter prompt leakage
  if (PROMPT_LEAKAGE_PATTERNS.some(p => lower.includes(p))) {
    workerStats.scanner.filteredPromptLeak++;
    return;
  }
  
  // Filter noise
  if (NOISE_PATTERNS.includes(lower) || NOISE_PATTERNS.includes(lower.replace(/[.,!?]/g, ''))) {
    workerStats.scanner.filteredNoise++;
    return;
  }
  
  // Filter sign-offs
  if (SIGN_OFF_PATTERNS.some(pattern => lower.includes(pattern)) && lower.length < 50) {
    workerStats.scanner.filteredSignOff++;
    return;
  }
  
  // Filter ads
  if ((lower.includes('broadcastify') && lower.includes('premium')) || 
      lower.includes('fema.gov') || 
      lower.includes('support this feed')) {
    return;
  }
  
  // Filter garbage
  if (GARBAGE_PATTERNS.some(pattern => lower.includes(pattern))) {
    workerStats.scanner.filteredGarbage++;
    if (feedId && activeStreams.has(feedId)) {
      const streamInfo = activeStreams.get(feedId);
      if (streamInfo.req) streamInfo.req.destroy();
      activeStreams.delete(feedId);
      streamState.delete(feedId);
      setTimeout(() => startNextAvailableFeed(), 3000);
    }
    return;
  }
  
  // Filter repetitive content
  const words = lower.split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 20 && uniqueWords.size < words.length * 0.3) {
    workerStats.scanner.filteredRepetitive++;
    if (feedId && activeStreams.has(feedId)) {
      const streamInfo = activeStreams.get(feedId);
      if (streamInfo.req) streamInfo.req.destroy();
      activeStreams.delete(feedId);
      streamState.delete(feedId);
      setTimeout(() => startNextAvailableFeed(), 3000);
    }
    return;
  }
  
  console.log(`[${feedName}] ✓ "${clean.substring(0, 100)}..."`);
  workerStats.scanner.lastTranscript = clean.substring(0, 200);
  workerStats.scanner.successfulTranscripts++;
  
  // Determine city
  const feed = ALL_FEEDS.find(f => f.id === feedId);
  const cityId = feed?.city || 'nyc';
  const state = cityState[cityId];
  
  // Duplicate detection
  const transcriptHash = clean.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (state.recentTranscriptHashes.has(transcriptHash)) return;
  state.recentTranscriptHashes.add(transcriptHash);
  if (state.recentTranscriptHashes.size > 100) {
    const hashArray = Array.from(state.recentTranscriptHashes);
    state.recentTranscriptHashes = new Set(hashArray.slice(-50));
  }
  
  const transcriptEntry = { text: clean, source: feedName, timestamp: new Date().toISOString() };
  state.recentTranscripts.unshift(transcriptEntry);
  if (state.recentTranscripts.length > MAX_TRANSCRIPTS) state.recentTranscripts.pop();
  
  await publishTranscript(transcriptEntry, cityId);
  
  const parsed = await parseTranscriptForCity(clean, cityId);
  
  if (parsed.hasIncident) {
    state.incidentId++;
    const camera = findNearestCameraForCity(parsed.location, parsed.borough, cityId);
    
    const audioId = `audio_${cityId}_${state.incidentId}_${Date.now()}`;
    audioClips.set(audioId, buffer);
    if (audioClips.size > MAX_AUDIO_CLIPS) audioClips.delete(audioClips.keys().next().value);
    
    const incident = {
      id: state.incidentId, ...parsed, transcript: clean,
      audioUrl: `/audio/${audioId}`, camera,
      lat: camera?.lat, lng: camera?.lng,
      source: feedName, city: cityId,
      timestamp: new Date().toISOString()
    };
    
    state.incidents.unshift(incident);
    if (state.incidents.length > 50) state.incidents.pop();
    
    await saveIncidentToDb(incident);
    await publishIncident(incident, cityId);
    
    if (camera) {
      await publishCameraSwitch(camera, `${parsed.incidentType} at ${parsed.location}`, parsed.priority, cityId);
    }
    
    if (parsed.isArrest) {
      await saveScannerArrest(incident, cityId);
    }
    
    workerStats.scanner.feedStats[feedId].incidents++;
    console.log(`[INCIDENT]`, incident.incidentType, '@', incident.location, `(${incident.borough})`);
  }
}

// ============================================
// TRANSCRIPT PARSING
// ============================================

async function parseTranscriptForCity(transcript, cityId) {
  if (cityId === 'mpls') return parseTranscriptMPLS(transcript);
  return parseTranscriptNYC(transcript);
}

async function parseTranscriptNYC(transcript) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `You are an expert NYPD radio parser. Your PRIMARY job is to extract LOCATION information.

LOCATION EXTRACTION RULES:
1. Look for street addresses: "123 West 45th Street" → location: "123 W 45th St"
2. Look for intersections: "42nd and Lexington", "at the corner of Broadway and 125th" → location: "42nd St & Lexington Ave"
3. Look for landmarks: "Times Square", "Penn Station", "Grand Central", "Port Authority" → use landmark name
4. Look for precinct references: "the 7-5", "75 precinct", "seven-five" → location: "75th Precinct", borough: "Brooklyn"
5. Look for sector/Adam/Boy/Charlie designations with location context
6. Look for highways: "FDR at 96th", "BQE", "Cross Bronx" → use highway location

PRECINCT TO BOROUGH MAPPING:
- 1-34: Manhattan
- 40-52: Bronx  
- 60-94: Brooklyn
- 100-115: Queens
- 120-123: Staten Island

If NO location can be determined, set location to null (not "Unknown").

ARREST DETECTION:
Look for keywords: "under arrest", "in custody", "collar", "perp", "prisoner", "apprehended", "cuffed"
Set isArrest: true if arrest-related

Respond ONLY with valid JSON:
{
  "hasIncident": boolean,
  "incidentType": "string describing incident",
  "location": "specific location or null if none found",
  "borough": "Manhattan/Brooklyn/Bronx/Queens/Staten Island/Unknown",
  "units": ["unit IDs mentioned"],
  "priority": "CRITICAL/HIGH/MEDIUM/LOW",
  "summary": "brief summary",
  "rawCodes": ["any 10-codes heard"],
  "precinctMentioned": "number or null",
  "isArrest": boolean
}`,
      messages: [{ role: "user", content: `Parse this NYPD radio transmission:\n\n"${transcript}"` }]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      if (parsed.precinctMentioned && (!parsed.borough || parsed.borough === 'Unknown')) {
        const boroughFromPrecinct = getPrecinctBorough(parsed.precinctMentioned);
        if (boroughFromPrecinct) {
          parsed.borough = boroughFromPrecinct;
          if (!parsed.location || parsed.location === 'Unknown') {
            parsed.location = `${parsed.precinctMentioned}th Precinct area`;
          }
        }
      }
      
      if (parsed.location === null) parsed.location = 'Unknown';
      return parsed;
    }
    return { hasIncident: false };
  } catch (error) {
    console.error('[PARSE] Error:', error.message);
    return { hasIncident: false };
  }
}

async function parseTranscriptMPLS(transcript) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `You are an expert Minneapolis/Hennepin County police radio parser. Your PRIMARY job is to extract LOCATION information.

MINNEAPOLIS LOCATION EXTRACTION RULES:
1. Look for street addresses: "123 Lake Street" → location: "123 Lake St"
2. Look for intersections: "Hennepin and Lake", "Franklin and Lyndale" → location: "Hennepin Ave & Lake St"
3. Look for landmarks: "Target Center", "US Bank Stadium", "Mall of America", "Nicollet Mall"
4. Look for highways: "I-35W", "I-94", "I-494", "Highway 55"
5. Look for neighborhoods: Uptown, Downtown, North Minneapolis, Northeast, Phillips, Powderhorn

MINNEAPOLIS PRECINCTS:
- 1st Precinct: Downtown, North Loop
- 2nd Precinct: Northeast Minneapolis  
- 3rd Precinct: South Minneapolis (Lake St, Powderhorn, Longfellow)
- 4th Precinct: North Minneapolis
- 5th Precinct: Southwest Minneapolis (Uptown, Calhoun, Lyndale)

If NO location can be determined, set location to null.

Respond ONLY with valid JSON:
{
  "hasIncident": boolean,
  "incidentType": "string describing incident",
  "location": "specific location or null if none found",
  "borough": "Downtown/North/Northeast/South/Southwest/Uptown/Unknown",
  "units": ["unit IDs mentioned"],
  "priority": "CRITICAL/HIGH/MEDIUM/LOW",
  "summary": "brief summary",
  "precinctMentioned": "number or null",
  "isArrest": boolean
}`,
      messages: [{ role: "user", content: `Parse this Minneapolis police radio transmission:\n\n"${transcript}"` }]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.location === null) parsed.location = 'Unknown';
      return parsed;
    }
    return { hasIncident: false };
  } catch (error) {
    console.error('[PARSE-MPLS] Error:', error.message);
    return { hasIncident: false };
  }
}

// ============================================
// CAMERA FUNCTIONS
// ============================================

async function fetchCamerasForCity(cityId) {
  const city = CITIES[cityId];
  if (!city) return;
  
  try {
    if (cityId === 'nyc') {
      const response = await fetch('https://webcams.nyctmc.org/api/cameras');
      const data = await response.json();
      cityState[cityId].cameras = data.filter(cam => cam.isOnline === true || cam.isOnline === "true").map(cam => ({
        id: cam.id, location: cam.name, lat: cam.latitude, lng: cam.longitude, area: cam.area || "NYC",
        imageUrl: `https://webcams.nyctmc.org/api/cameras/${cam.id}/image`, isOnline: true, city: 'nyc'
      }));
      console.log(`[${city.shortName}] Loaded ${cityState[cityId].cameras.length} traffic cameras`);
    } 
    else if (cityId === 'mpls') {
      // Fallback cameras for Minneapolis
      cityState[cityId].cameras = [
        { id: 'C856', location: 'I-394 at Penn Ave', lat: 44.9697, lng: -93.3100, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C856' },
        { id: 'C852', location: 'I-394 at Dunwoody', lat: 44.9680, lng: -93.2898, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C852' },
        { id: 'C107', location: 'I-94 at Hennepin Ave', lat: 44.9738, lng: -93.2780, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C107' },
        { id: 'C620', location: 'I-35W at Washington Ave', lat: 44.9738, lng: -93.2590, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C620' },
        { id: 'C633', location: 'I-35W at Lake St', lat: 44.9486, lng: -93.2505, area: 'South', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C633' },
      ];
      console.log(`[${city.shortName}] Loaded ${cityState[cityId].cameras.length} fallback cameras`);
    }
  } catch (error) {
    console.error(`[${city?.shortName || cityId}] Camera fetch error:`, error.message);
  }
}

function findNearestCameraForCity(location, borough, cityId) {
  const cameras = cityState[cityId]?.cameras || [];
  if (cameras.length === 0) return null;
  
  let searchCameras = cameras;
  
  if (borough && borough !== 'Unknown') {
    const boroughCameras = cameras.filter(cam => 
      cam.area?.toLowerCase().includes(borough.toLowerCase())
    );
    if (boroughCameras.length > 0) searchCameras = boroughCameras;
  }
  
  if (location && location !== 'Unknown') {
    const locationLower = location.toLowerCase();
    const matchingCameras = searchCameras.filter(cam => {
      const camLocation = cam.location?.toLowerCase() || '';
      const locationWords = locationLower.split(/[\s&@]+/).filter(w => w.length > 2);
      return locationWords.some(word => camLocation.includes(word));
    });
    
    if (matchingCameras.length > 0) {
      return matchingCameras[Math.floor(Math.random() * matchingCameras.length)];
    }
  }
  
  return searchCameras[Math.floor(Math.random() * searchCameras.length)];
}

// ============================================
// NYC DATA SYNC FUNCTIONS
// ============================================

async function fetchNYCArrestData() {
  const pool = getPool();
  if (!pool) return;
  console.log('[DATA SYNC] Fetching NYC arrests...');
  
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const historicUrl = `https://data.cityofnewyork.us/resource/8h9b-rp9u.json?$where=arrest_date>='${thirtyDaysAgo}'&$limit=2000&$order=arrest_date DESC`;
    const ytdUrl = `https://data.cityofnewyork.us/resource/uip8-fykc.json?$where=arrest_date>='${thirtyDaysAgo}'&$limit=2000&$order=arrest_date DESC`;
    
    let allData = [];
    
    try {
      const historicRes = await fetch(historicUrl, {
        headers: { 'X-App-Token': process.env.NYC_OPEN_DATA_TOKEN || '' }
      });
      if (historicRes.ok) {
        const historicData = await historicRes.json();
        allData = allData.concat(historicData);
        console.log(`[DATA SYNC] Historic arrests: ${historicData.length} fetched`);
      }
    } catch (e) { console.log('[DATA SYNC] Historic fetch error:', e.message); }
    
    try {
      const ytdRes = await fetch(ytdUrl, {
        headers: { 'X-App-Token': process.env.NYC_OPEN_DATA_TOKEN || '' }
      });
      if (ytdRes.ok) {
        const ytdData = await ytdRes.json();
        allData = allData.concat(ytdData);
        console.log(`[DATA SYNC] YTD arrests: ${ytdData.length} fetched`);
      }
    } catch (e) { console.log('[DATA SYNC] YTD fetch error:', e.message); }
    
    const seen = new Set();
    const deduped = allData.filter(a => {
      if (seen.has(a.arrest_key)) return false;
      seen.add(a.arrest_key);
      return true;
    });
    
    let inserted = 0;
    for (const arrest of deduped) {
      const id = await saveArrestToDb(arrest, 'nyc');
      if (id) inserted++;
    }
    
    await logDataSync('nyc_arrests', 'nyc', deduped.length, inserted, 'success');
    workerStats.dataSync.lastArrestSync = new Date().toISOString();
    console.log(`[DATA SYNC] NYC arrests: ${inserted}/${deduped.length} inserted`);
  } catch (error) {
    console.error('[DATA SYNC] NYC arrests error:', error.message);
    await logDataSync('nyc_arrests', 'nyc', 0, 0, 'error', error.message);
  }
}

async function fetchNYC911Data() {
  const pool = getPool();
  if (!pool) return;
  console.log('[DATA SYNC] Fetching NYC 911 calls...');
  
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$where=created_date>='${oneDayAgo}' AND agency='NYPD'&$limit=1000&$order=created_date DESC`;
    
    const response = await fetch(url, {
      headers: { 'X-App-Token': process.env.NYC_OPEN_DATA_TOKEN || '' }
    });
    
    if (!response.ok) return;
    const data = await response.json();
    
    let inserted = 0;
    for (const call of data) {
      const id = await save911CallToDb(call);
      if (id) inserted++;
    }
    
    await logDataSync('nyc_911', 'nyc', data.length, inserted, 'success');
    workerStats.dataSync.last911Sync = new Date().toISOString();
    console.log(`[DATA SYNC] NYC 911 calls: ${inserted}/${data.length} inserted`);
  } catch (error) {
    console.error('[DATA SYNC] NYC 911 error:', error.message);
    await logDataSync('nyc_911', 'nyc', 0, 0, 'error', error.message);
  }
}

async function fetchNYCInmateData() {
  const pool = getPool();
  if (!pool) return;
  console.log('[DATA SYNC] Fetching NYC inmates...');
  
  try {
    const url = `https://data.cityofnewyork.us/resource/7479-ugqb.json?$limit=5000`;
    const response = await fetch(url, {
      headers: { 'X-App-Token': process.env.NYC_OPEN_DATA_TOKEN || '' }
    });
    
    if (!response.ok) return;
    const data = await response.json();
    
    let inserted = 0;
    for (const inmate of data) {
      const id = await saveInmateToDb(inmate);
      if (id) inserted++;
    }
    
    await logDataSync('nyc_inmates', 'nyc', data.length, inserted, 'success');
    workerStats.dataSync.lastInmateSync = new Date().toISOString();
    console.log(`[DATA SYNC] NYC inmates: ${inserted}/${data.length} inserted`);
  } catch (error) {
    console.error('[DATA SYNC] NYC inmates error:', error.message);
  }
}

function startDataSyncScheduler() {
  const pool = getPool();
  if (!pool) {
    console.log('[DATA SYNC] Skipping - no database configured');
    return;
  }
  
  // NYC arrests - every 6 hours
  setInterval(fetchNYCArrestData, 6 * 60 * 60 * 1000);
  
  // NYC inmates - every 4 hours  
  setInterval(fetchNYCInmateData, 4 * 60 * 60 * 1000);
  
  // NYC 911 calls - every hour
  setInterval(fetchNYC911Data, 60 * 60 * 1000);
  
  // Initial sync after startup
  setTimeout(fetchNYCArrestData, 15000);
  setTimeout(fetchNYCInmateData, 45000);
  setTimeout(fetchNYC911Data, 30000);
  
  console.log('[DATA SYNC] Scheduler started');
}

// ============================================
// STATS UPDATE LOOP
// ============================================

async function updateStats() {
  workerStats.scanner.activeFeeds = Array.from(activeStreams.keys()).map(id => 
    ALL_FEEDS.find(f => f.id === id)?.name || id
  );
  
  await updateWorkerStats(workerStats);
  
  // Update city states
  for (const [cityId, state] of Object.entries(cityState)) {
    await updateCityState(cityId, {
      cameras: state.cameras,
      incidents: state.incidents.slice(0, 20),
      recentTranscripts: state.recentTranscripts.slice(0, 10),
      incidentId: state.incidentId
    });
  }
}

// ============================================
// STARTUP
// ============================================

async function main() {
  console.log(`
=====================================================
  DISPATCH WORKER - Data Collection Process
  Started: ${new Date().toISOString()}
=====================================================
  `);
  
  // Initialize database
  initPool();
  await initDatabase();
  
  // Initialize Redis
  await initRedis();
  
  // Fetch cameras for all cities
  for (const cityId of Object.keys(CITIES)) {
    await fetchCamerasForCity(cityId);
  }
  
  // Start data sources
  startBcfyCallsPolling();
  setTimeout(startMultiStreamBroadcastify, 5000);
  setTimeout(startOpenMHzPolling, 3000);
  startDataSyncScheduler();
  
  // Stats update loop
  setInterval(updateStats, 10000);
  
  console.log('[WORKER] All data sources started');
}

main().catch(console.error);

// Export for testing
export { cityState, workerStats, audioClips };
