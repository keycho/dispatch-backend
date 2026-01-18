import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
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

// NYC Traffic Camera database (sample - expand as needed)
const cameras = [
  { id: "1", location: "42nd St & Lexington Ave", lat: 40.7527, lng: -73.9772, url: "https://webcams.nyctmc.org/google_popup.php?cid=1" },
  { id: "2", location: "Times Square - 42nd & Broadway", lat: 40.7580, lng: -73.9855, url: "https://webcams.nyctmc.org/google_popup.php?cid=2" },
  { id: "3", location: "34th St & 5th Ave", lat: 40.7484, lng: -73.9857, url: "https://webcams.nyctmc.org/google_popup.php?cid=3" },
  { id: "4", location: "14th St & Union Square", lat: 40.7359, lng: -73.9906, url: "https://webcams.nyctmc.org/google_popup.php?cid=4" },
  { id: "5", location: "125th St & Lenox Ave", lat: 40.8094, lng: -73.9392, url: "https://webcams.nyctmc.org/google_popup.php?cid=5" },
  { id: "6", location: "Canal St & Broadway", lat: 40.7193, lng: -74.0020, url: "https://webcams.nyctmc.org/google_popup.php?cid=6" },
  { id: "7", location: "Brooklyn Bridge", lat: 40.7061, lng: -73.9969, url: "https://webcams.nyctmc.org/google_popup.php?cid=7" },
  { id: "8", location: "FDR Drive & 42nd St", lat: 40.7489, lng: -73.9680, url: "https://webcams.nyctmc.org/google_popup.php?cid=8" },
];

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

// Find nearest camera to a location
function findNearestCamera(location) {
  // Simple keyword matching for now
  const locationLower = location.toLowerCase();
  
  for (const cam of cameras) {
    const camLocationLower = cam.location.toLowerCase();
    // Check if any part of the location matches
    const locationParts = locationLower.split(/[&,\s]+/);
    for (const part of locationParts) {
      if (part.length > 2 && camLocationLower.includes(part)) {
        return cam;
      }
    }
  }
  
  // Default to Times Square if no match
  return cameras[1];
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
