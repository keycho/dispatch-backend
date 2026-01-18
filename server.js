import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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

// NYPD Feed IDs
const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1' },
  { id: '1189', name: 'NYPD Special Operations' },
  { id: '36689', name: 'NYPD Manhattan 19, 23' },
];

let currentFeedIndex = 0;
let audioBuffer = [];
let lastProcessTime = Date.now();
const CHUNK_DURATION = 15000; // Process every 15 seconds

async function startBroadcastifyStream() {
  if (!BROADCASTIFY_PASSWORD) {
    console.log('BROADCASTIFY_PASSWORD not set - scanner disabled');
    return;
  }

  const feed = NYPD_FEEDS[currentFeedIndex];
  const streamUrl = `https://audio.broadcastify.com/${feed.id}.mp3`;
  
  // Create Basic Auth header
  const authString = Buffer.from(`${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`).toString('base64');
  
  console.log(`Connecting to Broadcastify feed: ${feed.name} (${feed.id})`);

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'Authorization': `Basic ${authString}`
      }
    });
    
    if (!response.ok) {
      console.error(`Broadcastify stream error: ${response.status}`);
      // Try next feed
      currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
      setTimeout(startBroadcastifyStream, 5000);
      return;
    }

    console.log(`Connected to ${feed.name}! Streaming audio...`);
    const reader = response.body.getReader();
    
    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            console.log('Stream ended, reconnecting...');
            setTimeout(startBroadcastifyStream, 2000);
            return;
          }
          
          // Accumulate audio data
          audioBuffer.push(value);
          
          // Process every CHUNK_DURATION ms
          if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
            const fullBuffer = Buffer.concat(audioBuffer);
            audioBuffer = [];
            lastProcessTime = Date.now();
            
            // Process in background
            processAudioFromStream(fullBuffer, feed.name);
          }
        }
      } catch (error) {
        console.error('Stream read error:', error.message);
        setTimeout(startBroadcastifyStream, 5000);
      }
    };

    processStream();
    
  } catch (error) {
    console.error('Broadcastify connection error:', error.message);
    setTimeout(startBroadcastifyStream, 10000);
  }
}

async function processAudioFromStream(buffer, feedName) {
  if (buffer.length < 5000) {
    // Too small, probably silence
    return;
  }
  
  try {
    // Transcribe with Whisper
    const transcript = await transcribeAudio(buffer);
    
    if (!transcript || transcript.trim().length < 10) {
      return;
    }
    
    console.log(`[${feedName}] Transcript:`, transcript);
    
    // Broadcast transcript
    broadcast({
      type: "transcript",
      text: transcript,
      source: feedName,
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
        source: feedName,
        timestamp: new Date().toISOString(),
        status: "ACTIVE"
      };
      
      incidents.unshift(incident);
      if (incidents.length > 50) incidents.pop();
      
      broadcast({
        type: "incident",
        incident: incident
      });
      
      if (camera) {
        broadcast({
          type: "camera_switch",
          camera: camera,
          reason: `${parsed.incidentType} at ${parsed.location}`
        });
      }
      
      console.log('Incident detected:', incident);
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

// Incident log
const incidents = [];
let incidentId = 0;

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Find nearest camera to a location using text matching and coordinates
function findNearestCamera(location, lat = null, lng = null) {
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
  
  // Otherwise try text matching
  const locationLower = location.toLowerCase();
  
  for (const cam of cameras) {
    const camLocationLower = cam.location.toLowerCase();
    // Check if any part of the location matches
    const locationParts = locationLower.split(/[&@,\s]+/);
    for (const part of locationParts) {
      if (part.length > 2 && camLocationLower.includes(part)) {
        return cam;
      }
    }
  }
  
  // Default to a random camera if no match
  return cameras[Math.floor(Math.random() * cameras.length)];
}

// Parse scanner transcript with Claude
async function parseTranscript(transcript) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `You are a police scanner analyst. Extract incident information from radio transcripts.
      
Respond ONLY in this JSON format:
{
  "hasIncident": true/false,
  "incidentType": "string (e.g., 'Vehicle Collision', 'Robbery in Progress', 'Medical Emergency')",
  "location": "string (cross streets or address)",
  "units": "string (responding units if mentioned)",
  "priority": "HIGH/MEDIUM/LOW",
  "summary": "string (brief description)"
}

If no clear incident, set hasIncident to false.
Common codes: 10-50 = Accident, 10-31 = Crime in Progress, 10-52 = Medical, 10-34 = Assault`,
      messages: [{
        role: "user",
        content: `Parse this scanner transcript:\n\n"${transcript}"`
      }]
    });

    const text = response.content[0].text;
    // Extract JSON from response
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
    // Create a File-like object for the API
    const file = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });
    
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: "whisper-1",
      language: "en"
    });

    return transcription.text;
  } catch (error) {
    console.error("Whisper transcription error:", error);
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

  // Send current state
  ws.send(JSON.stringify({
    type: "init",
    incidents: incidents.slice(0, 20),
    cameras: cameras
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║                                                       ║
  ║   🚨 DISPATCH - Police Scanner Intelligence           ║
  ║   Running on port ${PORT}                                ║
  ║                                                       ║
  ║   WebSocket: ws://localhost:${PORT}                      ║
  ║   REST API:  http://localhost:${PORT}                    ║
  ║                                                       ║
  ╚═══════════════════════════════════════════════════════╝
  `);
});
