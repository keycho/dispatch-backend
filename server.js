import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import https from 'https';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();

// CORS configuration - allow all origins for now
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Initialize APIs
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Store connected clients
const clients = new Set();

// NYC Traffic Camera database - fetched from NYC DOT API
let cameras = [];

// Fetch cameras from NYC DOT on startup
async function fetchNYCCameras() {
  try {
    const response = await fetch('https://webcams.nyctmc.org/api/cameras');
    const data = await response.json();
    
    // Transform to our format and filter online cameras
    cameras = data
      .filter(cam => cam.isOnline === true || cam.isOnline === "true")
      .map(cam => ({
        id: cam.id,
        location: cam.name,
        lat: cam.latitude,
        lng: cam.longitude,
        area: cam.area || "NYC",
        imageUrl: `https://webcams.nyctmc.org/api/cameras/${cam.id}/image`,
        isOnline: true
      }));
    
    console.log(`Loaded ${cameras.length} NYC traffic cameras`);
  } catch (error) {
    console.error("Failed to fetch NYC cameras:", error);
    // Fallback to some default cameras
    cameras = [
      { id: "07b8616e-373e-4ec9-89cc-11cad7d59fcb", location: "Worth St @ Centre St", lat: 40.715157, lng: -74.00213, area: "Manhattan", imageUrl: "https://webcams.nyctmc.org/api/cameras/07b8616e-373e-4ec9-89cc-11cad7d59fcb/image", isOnline: true },
      { id: "8d2b3ae9-da68-4d37-8ae2-d3bc014f827b", location: "WBB - Bedford Ave & S 5 St", lat: 40.710983, lng: -73.963168, area: "Brooklyn", imageUrl: "https://webcams.nyctmc.org/api/cameras/8d2b3ae9-da68-4d37-8ae2-d3bc014f827b/image", isOnline: true },
    ];
  }
}

// Fetch cameras on startup
fetchNYCCameras();

// ============================================
// Broadcastify Live Scanner - NYPD Feeds
// ============================================

const BROADCASTIFY_USERNAME = 'whitefang123';
const BROADCASTIFY_PASSWORD = process.env.BROADCASTIFY_PASSWORD;

// NYPD Feed IDs - verified active feeds from broadcastify.com/listen/ctid/1855
const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1' },              // Most listeners - all boroughs
  { id: '40185', name: 'NYPD Citywide 2' },
  { id: '40186', name: 'NYPD Citywide 3' },
  { id: '1189', name: 'NYPD Bronx/Manhattan Transit' },  // ESU, Harbor, K-9
  { id: '7392', name: 'Hatzolah EMS Dispatch' },         // EMS backup
];

// Scanner stats for debug endpoint
let scannerStats = {
  currentFeed: null,
  lastChunkTime: null,
  lastChunkSize: 0,
  lastTranscriptTime: null,
  lastTranscript: null,
  totalChunks: 0,
  successfulTranscripts: 0,
  skippedChunks: 0,
  errors: []
};

let currentFeedIndex = 0;
let audioBuffer = [];
let lastProcessTime = Date.now();
const CHUNK_DURATION = 10000; // Process every 10 seconds for fast updates

async function startBroadcastifyStream() {
  if (!BROADCASTIFY_PASSWORD) {
    console.log('BROADCASTIFY_PASSWORD not set - scanner disabled');
    return;
  }

  const feed = NYPD_FEEDS[currentFeedIndex];
  
  console.log(`Connecting to Broadcastify feed: ${feed.name} (${feed.id})`);

  // Use native https module which properly supports auth
  const options = {
    hostname: 'audio.broadcastify.com',
    port: 443,
    path: `/${feed.id}.mp3`,
    method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  };

  const req = https.request(options, (res) => {
    console.log(`Broadcastify response: ${res.statusCode} ${res.statusMessage}`);
    
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.error('Auth failed - check username/password');
      currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
      setTimeout(startBroadcastifyStream, 10000);
      return;
    }
    
    if (res.statusCode !== 200) {
      console.error(`Broadcastify stream error: ${res.statusCode}`);
      currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
      setTimeout(startBroadcastifyStream, 5000);
      return;
    }

    handleStream(res, feed);
  });

  req.on('error', (error) => {
    console.error('Broadcastify connection error:', error.message);
    currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
    setTimeout(startBroadcastifyStream, 10000);
  });

  req.end();
}

function handleStream(stream, feed) {
  console.log(`Connected to ${feed.name}! Streaming audio...`);
  scannerStats.currentFeed = feed.name;
  
  let chunks = [];
  
  stream.on('data', (chunk) => {
    chunks.push(chunk);
    
    // Process every CHUNK_DURATION ms
    if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(chunks);
      const bufferSize = fullBuffer.length;
      chunks = [];
      lastProcessTime = Date.now();
      
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.lastChunkSize = bufferSize;
      scannerStats.totalChunks++;
      
      console.log(`[${feed.name}] Audio chunk: ${(bufferSize / 1024).toFixed(1)}KB`);
      
      // Process in background (don't await)
      processAudioFromStream(fullBuffer, feed.name);
    }
  });
  
  stream.on('end', () => {
    console.log('Stream ended, reconnecting...');
    scannerStats.currentFeed = null;
    setTimeout(startBroadcastifyStream, 2000);
  });
  
  stream.on('error', (error) => {
    console.error('Stream error:', error.message);
    scannerStats.errors.push({ time: new Date().toISOString(), error: error.message });
    if (scannerStats.errors.length > 10) scannerStats.errors.shift();
    setTimeout(startBroadcastifyStream, 5000);
  });
}

async function processAudioFromStream(buffer, feedName) {
  // Need at least ~5KB for meaningful audio
  if (buffer.length < 5000) {
    console.log(`[${feedName}] Skipping - buffer too small: ${buffer.length} bytes`);
    scannerStats.skippedChunks++;
    return;
  }
  
  try {
    // Transcribe with Whisper
    console.log(`[${feedName}] Sending ${(buffer.length / 1024).toFixed(1)}KB to Whisper...`);
    const transcript = await transcribeAudio(buffer);
    
    if (!transcript) {
      console.log(`[${feedName}] No transcript returned`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Filter out garbage transcripts (noise, music, repeated words)
    const cleanTranscript = transcript.trim();
    if (cleanTranscript.length < 10) {
      console.log(`[${feedName}] Transcript too short: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Check for repeated word patterns (like "You You You You")
    const words = cleanTranscript.split(/\s+/);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    if (words.length > 3 && uniqueWords.size <= 2) {
      console.log(`[${feedName}] Skipping repetitive noise: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Check for punctuation-only transcripts
    if (/^[\s.,!?-]+$/.test(cleanTranscript)) {
      console.log(`[${feedName}] Skipping punctuation-only: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Check for common Whisper hallucinations on silence/noise
    const hallucinations = [
      'thank you', 'thanks for watching', 'subscribe', 'like and subscribe',
      'you', 'bye', 'music', 'applause', 'silence'
    ];
    const lowerTranscript = cleanTranscript.toLowerCase();
    if (hallucinations.some(h => lowerTranscript === h || lowerTranscript === h + '.')) {
      console.log(`[${feedName}] Skipping likely hallucination: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Filter out transcripts that are mostly "you" repetitions (Whisper artifact)
    const youCount = (lowerTranscript.match(/\byou\b/g) || []).length;
    const wordCount = words.length;
    if (youCount > 3 && youCount / wordCount > 0.3) {
      console.log(`[${feedName}] Skipping you-heavy transcript (${youCount}/${wordCount} words): "${cleanTranscript.substring(0, 50)}..."`);
      scannerStats.skippedChunks++;
      return;
    }
    
    // Success! Track stats
    scannerStats.lastTranscriptTime = new Date().toISOString();
    scannerStats.lastTranscript = cleanTranscript.substring(0, 200);
    scannerStats.successfulTranscripts++;
    
    console.log(`[${feedName}] Transcript:`, transcript);
    
    // Store transcript for new clients
    const transcriptEntry = {
      text: transcript,
      source: feedName,
      timestamp: new Date().toISOString()
    };
    recentTranscripts.unshift(transcriptEntry);
    if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
    
    // Broadcast transcript
    broadcast({
      type: "transcript",
      ...transcriptEntry
    });
    
    // Parse with Claude
    const parsed = await parseTranscript(transcript);
    
    if (parsed.hasIncident) {
      incidentId++;
      const camera = findNearestCamera(parsed.location || "", null, null, parsed.borough);
      
      // Store audio clip
      const audioId = `audio_${incidentId}_${Date.now()}`;
      audioClips.set(audioId, buffer);
      
      // Cleanup old clips
      if (audioClips.size > MAX_AUDIO_CLIPS) {
        const firstKey = audioClips.keys().next().value;
        audioClips.delete(firstKey);
      }
      
      const incident = {
        id: incidentId,
        ...parsed,
        transcript: cleanTranscript,
        audioUrl: `/audio/${audioId}`,
        camera: camera,
        // Add coordinates directly for easier frontend access
        lat: camera?.lat || null,
        lng: camera?.lng || null,
        source: feedName,
        timestamp: new Date().toISOString()
      };
      
      incidents.unshift(incident);
      if (incidents.length > 50) incidents.pop();
      
      // Store for pattern analysis
      recentIncidentsForAnalysis.unshift({
        id: incident.id,
        type: incident.incidentType,
        location: incident.location,
        borough: incident.borough,
        priority: incident.priority,
        timestamp: incident.timestamp,
        lat: incident.lat,
        lng: incident.lng
      });
      if (recentIncidentsForAnalysis.length > MAX_ANALYSIS_INCIDENTS) {
        recentIncidentsForAnalysis.pop();
      }
      
      // Check for linked incidents
      const linkAnalysis = await checkForLinkedIncidents(incident);
      if (linkAnalysis) {
        incident.linkedCase = linkAnalysis;
        broadcast({
          type: "linked_case",
          incident: incident,
          analysis: linkAnalysis,
          timestamp: new Date().toISOString()
        });
      }
      
      broadcast({
        type: "incident",
        incident: incident
      });
      
      if (camera) {
        broadcast({
          type: "camera_switch",
          camera: camera,
          reason: `${parsed.incidentType} at ${parsed.location}`,
          priority: parsed.priority
        });
      }
      
      console.log('Incident detected:', incident.incidentType, '@', incident.location, '- Priority:', incident.priority);
    }
    
    broadcast({
      type: "analysis",
      text: parsed.hasIncident 
        ? `[INCIDENT] ${parsed.incidentType} at ${parsed.location}. Priority: ${parsed.priority}.`
        : `[MONITORING] ${transcript.substring(0, 100)}...`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Audio processing error:', error.message);
  }
}

// Start scanner after a delay
console.log('Starting Broadcastify scanner in 5 seconds...');
setTimeout(startBroadcastifyStream, 5000);

// ============================================
// AI CRIME ANALYST - Pattern Detection
// ============================================

// Store recent incidents for pattern analysis
const recentIncidentsForAnalysis = [];
const MAX_ANALYSIS_INCIDENTS = 100;

// Analyze patterns every 5 minutes
setInterval(analyzePatterns, 5 * 60 * 1000);

async function analyzePatterns() {
  if (recentIncidentsForAnalysis.length < 5) return;
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `You are an NYPD crime analyst AI. Analyze recent incidents for patterns.

Look for:
1. Geographic clusters (multiple incidents in same area)
2. Temporal patterns (same time of day)
3. Similar MO (method of operation)
4. Possible connections between incidents
5. Emerging hotspots

Respond in JSON:
{
  "patterns": [
    {
      "type": "CLUSTER|TEMPORAL|MO_MATCH|LINKED_CASE|HOTSPOT",
      "title": "string",
      "description": "string",
      "incidentIds": [1, 2, 3],
      "confidence": "HIGH|MEDIUM|LOW",
      "recommendation": "string"
    }
  ],
  "hotspots": [
    { "area": "string", "riskLevel": "HIGH|MEDIUM|LOW", "reason": "string" }
  ],
  "summary": "string (1-2 sentence overview)"
}`,
      messages: [{
        role: "user",
        content: `Analyze these ${recentIncidentsForAnalysis.length} recent incidents for patterns:\n\n${JSON.stringify(recentIncidentsForAnalysis.slice(0, 50), null, 2)}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      
      // Broadcast pattern alerts to clients
      if (analysis.patterns && analysis.patterns.length > 0) {
        broadcast({
          type: "pattern_alert",
          analysis: analysis,
          timestamp: new Date().toISOString()
        });
        
        console.log(`[AI Analyst] Found ${analysis.patterns.length} patterns`);
      }
    }
  } catch (error) {
    console.error('[AI Analyst] Pattern analysis error:', error.message);
  }
}

// Link related incidents in real-time
async function checkForLinkedIncidents(newIncident) {
  const recentSimilar = recentIncidentsForAnalysis.filter(inc => {
    const timeDiff = new Date(newIncident.timestamp) - new Date(inc.timestamp);
    const isRecent = timeDiff < 30 * 60 * 1000; // Within 30 minutes
    const sameBorough = inc.borough === newIncident.borough;
    return isRecent && sameBorough && inc.id !== newIncident.id;
  });

  if (recentSimilar.length < 1) return null;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: `You are a crime analyst. Determine if these incidents might be related (same perpetrator, connected events, etc.)

Respond in JSON:
{
  "isLinked": true/false,
  "confidence": "HIGH|MEDIUM|LOW",
  "linkType": "SAME_SUSPECT|PURSUIT|RELATED_CRIMES|UNRELATED",
  "explanation": "string"
}`,
      messages: [{
        role: "user",
        content: `New incident:\n${JSON.stringify(newIncident)}\n\nRecent nearby incidents:\n${JSON.stringify(recentSimilar)}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const linkAnalysis = JSON.parse(jsonMatch[0]);
      
      if (linkAnalysis.isLinked && linkAnalysis.confidence !== 'LOW') {
        return {
          ...linkAnalysis,
          linkedIncidentIds: recentSimilar.map(i => i.id)
        };
      }
    }
  } catch (error) {
    console.error('[AI Analyst] Link check error:', error.message);
  }
  
  return null;
}

// Incident log
const incidents = [];
let incidentId = 0;

// Recent transcripts for new clients
const recentTranscripts = [];
const MAX_TRANSCRIPTS = 20;

// Audio clip storage (for playback)
const audioClips = new Map();
const MAX_AUDIO_CLIPS = 50;

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Find nearest camera to a location using text matching, coordinates, and borough
function findNearestCamera(location, lat = null, lng = null, borough = null) {
  if (cameras.length === 0) {
    return null;
  }
  
  // If we have coordinates, find nearest by distance
  if (lat && lng) {
    let nearest = cameras[0];
    let minDist = Infinity;
    
    for (const cam of cameras) {
      const dist = Math.sqrt(
        Math.pow(cam.lat - lat, 2) + Math.pow(cam.lng - lng, 2)
      );
      if (dist < minDist) {
        minDist = dist;
        nearest = cam;
      }
    }
    return nearest;
  }
  
  // Filter by borough first if available
  let searchCameras = cameras;
  if (borough && borough !== 'Unknown') {
    const boroughCameras = cameras.filter(cam => 
      cam.area && cam.area.toLowerCase().includes(borough.toLowerCase())
    );
    if (boroughCameras.length > 0) {
      searchCameras = boroughCameras;
    }
  }
  
  // Try text matching on location
  const locationLower = location.toLowerCase();
  
  // Extract street numbers and names
  const streetMatch = locationLower.match(/(\d+)(?:st|nd|rd|th)?\s*(street|st|avenue|ave|place|pl|road|rd|boulevard|blvd)/i);
  
  for (const cam of searchCameras) {
    const camLocationLower = cam.location.toLowerCase();
    
    // Check if any part of the location matches
    const locationParts = locationLower.split(/[&@,\s]+/);
    for (const part of locationParts) {
      if (part.length > 2 && camLocationLower.includes(part)) {
        return cam;
      }
    }
  }
  
  // Return random camera from the borough, or any camera
  return searchCameras[Math.floor(Math.random() * searchCameras.length)];
}

// Parse scanner transcript with Claude
async function parseTranscript(transcript) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `You are an expert NYPD radio analyst. Parse radio transmissions and extract structured incident data.

NYPD Radio Terminology:
- K = Acknowledged
- 10-13 = Officer needs assistance (URGENT)
- 10-85 = Officer needs backup
- 10-52/10-53 = Ambulance needed
- 10-34 = Assault in progress
- 10-30 = Robbery in progress
- 10-31 = Crime in progress
- EDP = Emotionally Disturbed Person
- DOA = Dead on Arrival
- RMP = Radio Motor Patrol (police car)
- Aided = Person needing medical help
- Forthwith = Immediately
- Central = Dispatch

Unit Format: [Number]-[Letter] (e.g., "85-David" = 85th precinct, David sector)

Respond ONLY in this JSON format:
{
  "hasIncident": true/false,
  "incidentType": "string (be specific: 'Armed Robbery', 'Vehicle Collision with Injuries', 'Shots Fired', 'Domestic Dispute', 'Medical Emergency', 'Suspicious Person', 'Traffic Stop', etc.)",
  "location": "string (cross streets or address in NYC format)",
  "units": ["array of responding units"],
  "priority": "CRITICAL/HIGH/MEDIUM/LOW",
  "status": "DISPATCHED/EN_ROUTE/ON_SCENE/RESOLVED",
  "summary": "string (dramatic but accurate 1-sentence description)",
  "rawCodes": ["any 10-codes or signals mentioned"],
  "borough": "Manhattan/Brooklyn/Bronx/Queens/Staten Island/Unknown"
}

Priority Guide:
- CRITICAL: Officer down, shots fired, active shooter, pursuit
- HIGH: Robbery in progress, assault, 10-13, 10-85
- MEDIUM: Domestic, EDP, vehicle accident with injuries
- LOW: Traffic stops, noise complaints, aided cases

If no clear incident (just routine radio chatter), set hasIncident to false.`,
      messages: [{
        role: "user",
        content: `Parse this NYPD radio transmission:\n\n"${transcript}"`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { hasIncident: false };
  } catch (error) {
    console.error("Claude parse error:", error);
    return { hasIncident: false };
  }
}

// Transcribe audio with Whisper
async function transcribeAudio(audioBuffer) {
  try {
    // Use OpenAI's toFile utility for Node.js compatibility
    const file = await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' });
    
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
      language: "en",
      prompt: "NYPD police radio dispatch. Units: Central, David, Adam, Boy, Charlie, Edward, Frank, George, Henry, Ida, John, King, Lincoln, Mary, Nora, Ocean, Peter, Queen, Robert, Sam, Tom, Union, Victor, William, X-ray, Young, Zebra. Codes: 10-4, 10-13, 10-85, 10-52, 10-53, 10-34, K, forthwith, precinct, sector, respond, en route, on scene, perp, EDP, aided, DOA, RMP."
    });

    return transcription.text;
  } catch (error) {
    console.error("Whisper transcription error:", error.message);
    return null;
  }
}

// Process incoming audio chunk
async function processAudioChunk(audioBuffer) {
  // Transcribe
  const transcript = await transcribeAudio(audioBuffer);
  if (!transcript || transcript.trim().length < 10) return;

  console.log("Transcript:", transcript);
  
  // Broadcast transcript
  broadcast({
    type: "transcript",
    text: transcript,
    timestamp: new Date().toISOString()
  });

  // Parse with Claude
  const parsed = await parseTranscript(transcript);
  
  if (parsed.hasIncident) {
    incidentId++;
    const camera = findNearestCamera(parsed.location || "");
    
    const incident = {
      id: incidentId,
      ...parsed,
      camera: camera,
      lat: camera?.lat || null,
      lng: camera?.lng || null,
      timestamp: new Date().toISOString(),
      status: "ACTIVE"
    };
    
    incidents.unshift(incident);
    if (incidents.length > 50) incidents.pop();

    // Broadcast incident
    broadcast({
      type: "incident",
      incident: incident
    });

    // Broadcast camera switch
    broadcast({
      type: "camera_switch",
      camera: camera,
      reason: `${parsed.incidentType} at ${parsed.location}`
    });

    console.log("Incident detected:", incident);
  }

  // Broadcast AI analysis
  broadcast({
    type: "analysis",
    text: parsed.hasIncident 
      ? `[INCIDENT] ${parsed.incidentType} detected at ${parsed.location}. Priority: ${parsed.priority}. ${parsed.summary}`
      : `[MONITORING] ${transcript.substring(0, 100)}...`,
    timestamp: new Date().toISOString()
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  // Send current state with recent transcripts
  ws.send(JSON.stringify({
    type: "init",
    incidents: incidents.slice(0, 20),
    cameras: cameras,
    transcripts: recentTranscripts.slice(0, 10),
    currentFeed: NYPD_FEEDS[currentFeedIndex]?.name || 'NYPD Citywide 1'
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handle audio chunks from client
      if (data.type === 'audio_chunk') {
        const audioBuffer = Buffer.from(data.audio, 'base64');
        await processAudioChunk(audioBuffer);
      }
      
      // Handle manual transcript input (for testing)
      if (data.type === 'manual_transcript') {
        broadcast({
          type: "transcript",
          text: data.text,
          timestamp: new Date().toISOString()
        });
        
        const parsed = await parseTranscript(data.text);
        if (parsed.hasIncident) {
          incidentId++;
          const camera = findNearestCamera(parsed.location || "");
          
          const incident = {
            id: incidentId,
            ...parsed,
            camera: camera,
            lat: camera?.lat || null,
            lng: camera?.lng || null,
            timestamp: new Date().toISOString(),
            status: "ACTIVE"
          };
          
          incidents.unshift(incident);
          
          broadcast({
            type: "incident",
            incident: incident
          });
          
          broadcast({
            type: "camera_switch",
            camera: camera,
            reason: `${parsed.incidentType} at ${parsed.location}`
          });
        }
        
        broadcast({
          type: "analysis",
          text: parsed.hasIncident 
            ? `[INCIDENT] ${parsed.incidentType} at ${parsed.location}. Priority: ${parsed.priority}.`
            : `[MONITORING] No incident detected in transmission.`,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error("Message handling error:", error);
    }
  });
});

// REST endpoints
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: "DISPATCH - Police Scanner Intelligence",
    status: "operational",
    connections: clients.size,
    incidents: incidents.length
  });
});

app.get('/cameras', (req, res) => {
  res.json(cameras);
});

// Proxy endpoint for camera images (to avoid CORS issues)
app.get('/camera-image/:id', async (req, res) => {
  try {
    const imageUrl = `https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`;
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch camera image' });
  }
});

// Refresh cameras endpoint
app.get('/refresh-cameras', async (req, res) => {
  await fetchNYCCameras();
  res.json({ count: cameras.length, message: 'Cameras refreshed' });
});

app.get('/incidents', (req, res) => {
  res.json(incidents);
});

// Serve audio clips for playback
app.get('/audio/:id', (req, res) => {
  const audioId = req.params.id;
  const buffer = audioClips.get(audioId);
  
  if (!buffer) {
    return res.status(404).json({ error: 'Audio clip not found or expired' });
  }
  
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', buffer.length);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(buffer);
});

// Live audio stream proxy - bypasses CORS for browser playback
app.get('/stream/live', (req, res) => {
  if (!BROADCASTIFY_PASSWORD) {
    return res.status(503).json({ error: 'Scanner not configured' });
  }

  const feedId = req.query.feed || NYPD_FEEDS[currentFeedIndex]?.id || '40184';
  const feedInfo = NYPD_FEEDS.find(f => f.id === feedId) || { name: 'Unknown Feed' };
  
  console.log(`[Stream Proxy] Client requesting live stream: ${feedInfo.name} (${feedId})`);

  const options = {
    hostname: 'audio.broadcastify.com',
    port: 443,
    path: `/${feedId}.mp3`,
    method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      console.error(`[Stream Proxy] Broadcastify returned ${proxyRes.statusCode}`);
      res.status(proxyRes.statusCode).json({ error: 'Stream unavailable' });
      return;
    }

    console.log(`[Stream Proxy] Connected to ${feedInfo.name}, streaming to client...`);
    
    // Set headers only after successful connection
    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    
    // Pipe the audio stream to the client
    proxyRes.pipe(res);

    proxyRes.on('end', () => {
      console.log(`[Stream Proxy] Stream ended for ${feedInfo.name}`);
    });

    proxyRes.on('error', (err) => {
      console.error(`[Stream Proxy] Stream error:`, err.message);
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Stream Proxy] Connection error:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to connect to stream' });
    }
  });

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[Stream Proxy] Client disconnected from ${feedInfo.name}`);
    proxyReq.destroy();
  });

  proxyReq.end();
});

// Get available feeds list
app.get('/stream/feeds', (req, res) => {
  res.json({
    feeds: NYPD_FEEDS,
    currentFeed: NYPD_FEEDS[currentFeedIndex],
    streamUrl: '/stream/live'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// GAMIFICATION & ANALYSIS ENDPOINTS
// ============================================

// Get AI pattern analysis
app.get('/analysis/patterns', async (req, res) => {
  if (recentIncidentsForAnalysis.length < 3) {
    return res.json({ patterns: [], message: 'Not enough data yet' });
  }
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `Analyze these incidents for crime patterns. Return JSON with patterns, hotspots, and insights.`,
      messages: [{
        role: "user",
        content: `Analyze: ${JSON.stringify(recentIncidentsForAnalysis.slice(0, 30))}`
      }]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { patterns: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get incident statistics
app.get('/stats', (req, res) => {
  const now = new Date();
  const hourAgo = new Date(now - 60 * 60 * 1000);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  
  const lastHour = incidents.filter(i => new Date(i.timestamp) > hourAgo);
  const lastDay = incidents.filter(i => new Date(i.timestamp) > dayAgo);
  
  const byBorough = {};
  const byType = {};
  const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  
  incidents.forEach(inc => {
    byBorough[inc.borough || 'Unknown'] = (byBorough[inc.borough || 'Unknown'] || 0) + 1;
    byType[inc.incidentType || 'Unknown'] = (byType[inc.incidentType || 'Unknown'] || 0) + 1;
    if (inc.priority) byPriority[inc.priority]++;
  });
  
  res.json({
    total: incidents.length,
    lastHour: lastHour.length,
    lastDay: lastDay.length,
    byBorough,
    byType,
    byPriority,
    hottest: Object.entries(byBorough).sort((a, b) => b[1] - a[1])[0],
    mostCommon: Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
  });
});

// Prediction game - submit a prediction
const predictions = new Map();

app.post('/game/predict', express.json(), (req, res) => {
  const { userId, borough, incidentType, timeWindow } = req.body;
  
  if (!userId || !borough) {
    return res.status(400).json({ error: 'userId and borough required' });
  }
  
  const prediction = {
    userId,
    borough,
    incidentType: incidentType || 'any',
    timeWindow: timeWindow || 30, // minutes
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (timeWindow || 30) * 60 * 1000).toISOString(),
    status: 'PENDING'
  };
  
  const predictionId = `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  predictions.set(predictionId, prediction);
  
  res.json({ predictionId, prediction });
});

// Check prediction results
app.get('/game/predictions/:userId', (req, res) => {
  const userPredictions = [];
  predictions.forEach((pred, id) => {
    if (pred.userId === req.params.userId) {
      userPredictions.push({ id, ...pred });
    }
  });
  res.json(userPredictions);
});

// Leaderboard
const userScores = new Map();

app.get('/game/leaderboard', (req, res) => {
  const leaderboard = Array.from(userScores.entries())
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  
  res.json(leaderboard);
});

// Get challenges
app.get('/game/challenges', (req, res) => {
  const challenges = [
    {
      id: 'night_owl',
      name: 'Night Owl',
      description: 'Monitor 10 incidents after midnight',
      points: 100,
      icon: '🦉'
    },
    {
      id: 'eagle_eye', 
      name: 'Eagle Eye',
      description: 'Spot a HIGH priority incident within 30 seconds',
      points: 50,
      icon: '🦅'
    },
    {
      id: 'analyst',
      name: 'Crime Analyst',
      description: 'Correctly predict 5 incident locations',
      points: 200,
      icon: '🔍'
    },
    {
      id: 'manhattan_expert',
      name: 'Manhattan Expert',
      description: 'Track 50 incidents in Manhattan',
      points: 150,
      icon: '🏙️'
    },
    {
      id: 'pattern_spotter',
      name: 'Pattern Spotter',
      description: 'Identify a linked case before the AI',
      points: 500,
      icon: '🧠'
    }
  ];
  
  res.json(challenges);
});

// Debug endpoint for scanner status
app.get('/debug', (req, res) => {
  res.json({
    scanner: {
      ...scannerStats,
      feeds: NYPD_FEEDS,
      currentFeedIndex,
      chunkDuration: CHUNK_DURATION + 'ms',
      password_set: !!BROADCASTIFY_PASSWORD
    },
    connections: clients.size,
    incidents: incidents.length,
    cameras: cameras.length,
    uptime: process.uptime() + 's'
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ========================================================
  
     DISPATCH - Police Scanner Intelligence
     Running on port ${PORT}
  
     WebSocket: ws://localhost:${PORT}
     REST API:  http://localhost:${PORT}
  
  ========================================================
  `);
});
