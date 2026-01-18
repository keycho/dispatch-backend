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

// ============================================
// BETTING SYSTEM - DYNAMIC ODDS ENGINE
// ============================================

const TREASURY_WALLET = process.env.TREASURY_WALLET || 'YOUR_SOLANA_WALLET_HERE';
const HOUSE_EDGE = 0.05; // 5% edge = your profit margin

const oddsEngine = {
  boroughRates: {
    'Manhattan': 12.5,
    'Brooklyn': 9.8,
    'Bronx': 7.2,
    'Queens': 6.1,
    'Staten Island': 1.4,
  },
  
  incidentTypeRarity: {
    'any': 1.0,
    'traffic': 0.25,
    'medical': 0.20,
    'domestic': 0.15,
    'assault': 0.12,
    'suspicious': 0.10,
    'theft': 0.08,
    'robbery': 0.05,
    'pursuit': 0.03,
    'shots fired': 0.02,
  },
  
  timeMultipliers: {
    0: 0.7, 1: 0.5, 2: 0.4, 3: 0.3, 4: 0.4, 5: 0.5,
    6: 0.7, 7: 0.9, 8: 1.0, 9: 1.0, 10: 1.0, 11: 1.1,
    12: 1.2, 13: 1.1, 14: 1.0, 15: 1.1, 16: 1.2, 17: 1.3,
    18: 1.4, 19: 1.5, 20: 1.6, 21: 1.5, 22: 1.3, 23: 1.0
  },
  
  calculateProbability(borough, incidentType = 'any', windowMinutes = 30) {
    const hour = new Date().getHours();
    const baseRate = this.boroughRates[borough] || 5.0;
    const timeAdjusted = baseRate * this.timeMultipliers[hour];
    const typeMultiplier = this.incidentTypeRarity[incidentType.toLowerCase()] || 0.1;
    const adjusted = timeAdjusted * typeMultiplier;
    const expected = (adjusted / 60) * windowMinutes;
    return Math.min(0.95, 1 - Math.exp(-expected));
  },
  
  calculateMultiplier(probability) {
    const fair = 1 / probability;
    const withEdge = fair * (1 - HOUSE_EDGE);
    return Math.max(1.1, Math.min(50.0, Math.round(withEdge * 100) / 100));
  },
  
  getOdds(borough, incidentType = 'any', windowMinutes = 30) {
    const prob = this.calculateProbability(borough, incidentType, windowMinutes);
    const mult = this.calculateMultiplier(prob);
    return {
      borough,
      incidentType,
      windowMinutes,
      probability: Math.round(prob * 1000) / 10,
      multiplier: mult,
    };
  }
};

const treasury = {
  totalReceived: 0,
  totalPaidOut: 0,
  get netProfit() { return this.totalReceived - this.totalPaidOut; }
};

// ============================================
// NYC Traffic Camera database
// ============================================

let cameras = [];

async function fetchNYCCameras() {
  try {
    const response = await fetch('https://webcams.nyctmc.org/api/cameras');
    const data = await response.json();
    
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
    cameras = [
      { id: "07b8616e-373e-4ec9-89cc-11cad7d59fcb", location: "Worth St @ Centre St", lat: 40.715157, lng: -74.00213, area: "Manhattan", imageUrl: "https://webcams.nyctmc.org/api/cameras/07b8616e-373e-4ec9-89cc-11cad7d59fcb/image", isOnline: true },
      { id: "8d2b3ae9-da68-4d37-8ae2-d3bc014f827b", location: "WBB - Bedford Ave & S 5 St", lat: 40.710983, lng: -73.963168, area: "Brooklyn", imageUrl: "https://webcams.nyctmc.org/api/cameras/8d2b3ae9-da68-4d37-8ae2-d3bc014f827b/image", isOnline: true },
    ];
  }
}

fetchNYCCameras();

// ============================================
// Broadcastify Live Scanner - NYPD Feeds
// ============================================

const BROADCASTIFY_USERNAME = 'whitefang123';
const BROADCASTIFY_PASSWORD = process.env.BROADCASTIFY_PASSWORD;

const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1' },
  { id: '40185', name: 'NYPD Citywide 2' },
  { id: '40186', name: 'NYPD Citywide 3' },
  { id: '1189', name: 'NYPD Bronx/Manhattan Transit' },
  { id: '7392', name: 'Hatzolah EMS Dispatch' },
];

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
const CHUNK_DURATION = 10000;

async function startBroadcastifyStream() {
  if (!BROADCASTIFY_PASSWORD) {
    console.log('BROADCASTIFY_PASSWORD not set - scanner disabled');
    return;
  }

  const feed = NYPD_FEEDS[currentFeedIndex];
  
  console.log(`Connecting to Broadcastify feed: ${feed.name} (${feed.id})`);

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
    
    if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(chunks);
      const bufferSize = fullBuffer.length;
      chunks = [];
      lastProcessTime = Date.now();
      
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.lastChunkSize = bufferSize;
      scannerStats.totalChunks++;
      
      console.log(`[${feed.name}] Audio chunk: ${(bufferSize / 1024).toFixed(1)}KB`);
      
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
  if (buffer.length < 5000) {
    console.log(`[${feedName}] Skipping - buffer too small: ${buffer.length} bytes`);
    scannerStats.skippedChunks++;
    return;
  }
  
  try {
    console.log(`[${feedName}] Sending ${(buffer.length / 1024).toFixed(1)}KB to Whisper...`);
    const transcript = await transcribeAudio(buffer);
    
    if (!transcript) {
      console.log(`[${feedName}] No transcript returned`);
      scannerStats.skippedChunks++;
      return;
    }
    
    const cleanTranscript = transcript.trim();
    if (cleanTranscript.length < 10) {
      console.log(`[${feedName}] Transcript too short: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    const words = cleanTranscript.split(/\s+/);
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    if (words.length > 3 && uniqueWords.size <= 2) {
      console.log(`[${feedName}] Skipping repetitive noise: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
    if (/^[\s.,!?-]+$/.test(cleanTranscript)) {
      console.log(`[${feedName}] Skipping punctuation-only: "${cleanTranscript}"`);
      scannerStats.skippedChunks++;
      return;
    }
    
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
    
    const adPatterns = [
      'fema.gov', 'fema gov', 'broadcastify', 'radioreference',
      'for more information visit', 'visit www', 'visit http',
      'this stream', 'this feed', 'premium subscriber',
      'brought to you by', 'sponsored by', 'support this feed',
      'emergency alert system', 'this is a test', 'only a test',
      'ready.gov', 'weather.gov', 'public service announcement'
    ];
    if (adPatterns.some(pattern => lowerTranscript.includes(pattern))) {
      console.log(`[${feedName}] Skipping ad/PSA: "${cleanTranscript.substring(0, 50)}..."`);
      scannerStats.skippedChunks++;
      return;
    }
    
    const youCount = (lowerTranscript.match(/\byou\b/g) || []).length;
    const wordCount = words.length;
    if (youCount > 3 && youCount / wordCount > 0.3) {
      console.log(`[${feedName}] Skipping you-heavy transcript (${youCount}/${wordCount} words): "${cleanTranscript.substring(0, 50)}..."`);
      scannerStats.skippedChunks++;
      return;
    }
    
    scannerStats.lastTranscriptTime = new Date().toISOString();
    scannerStats.lastTranscript = cleanTranscript.substring(0, 200);
    scannerStats.successfulTranscripts++;
    
    console.log(`[${feedName}] Transcript:`, transcript);
    
    const transcriptEntry = {
      text: transcript,
      source: feedName,
      timestamp: new Date().toISOString()
    };
    recentTranscripts.unshift(transcriptEntry);
    if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
    
    broadcast({
      type: "transcript",
      ...transcriptEntry
    });
    
    const parsed = await parseTranscript(transcript);
    
    if (parsed.hasIncident) {
      incidentId++;
      const camera = findNearestCamera(parsed.location || "", null, null, parsed.borough);
      
      const audioId = `audio_${incidentId}_${Date.now()}`;
      audioClips.set(audioId, buffer);
      
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
        lat: camera?.lat || null,
        lng: camera?.lng || null,
        source: feedName,
        timestamp: new Date().toISOString()
      };
      
      incidents.unshift(incident);
      if (incidents.length > 50) incidents.pop();
      
      checkBetsForIncident(incident);
      
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
      
      generateDetectiveCommentary(incident, recentIncidentsForAnalysis.slice(0, 5))
        .then(commentary => {
          if (commentary) {
            broadcast({
              type: "detective_commentary",
              incidentId: incident.id,
              commentary: commentary,
              timestamp: new Date().toISOString()
            });
          }
        });
      
      if (linkAnalysis && linkAnalysis.linkedIncidentIds?.length > 0) {
        const linkedIncs = incidents.filter(i => 
          linkAnalysis.linkedIncidentIds.includes(i.id) || i.id === incident.id
        );
        buildCaseFile(linkedIncs, linkAnalysis)
          .then(caseFile => {
            if (caseFile) {
              broadcast({
                type: "new_case",
                caseFile: caseFile,
                timestamp: new Date().toISOString()
              });
              console.log(`[Claude Detective] New case: ${caseFile.caseName}`);
            }
          });
      }
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

console.log('Starting Broadcastify scanner in 5 seconds...');
setTimeout(startBroadcastifyStream, 5000);

// ============================================
// AI CRIME ANALYST - Pattern Detection
// ============================================

const recentIncidentsForAnalysis = [];
const MAX_ANALYSIS_INCIDENTS = 100;

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

async function checkForLinkedIncidents(newIncident) {
  const recentSimilar = recentIncidentsForAnalysis.filter(inc => {
    const timeDiff = new Date(newIncident.timestamp) - new Date(inc.timestamp);
    const isRecent = timeDiff < 30 * 60 * 1000;
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

// ============================================
// CLAUDE DETECTIVE - AI Crime Investigation
// ============================================

const caseFiles = new Map();
let caseNumber = 0;

async function generateDetectiveCommentary(incident, recentIncidents) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: `You are Claude, an AI detective analyzing NYPD radio traffic in real-time. You speak like a seasoned detective - observant, analytical, sometimes dry wit. Keep responses to 2-3 sentences max.

Your job:
- Notice patterns others might miss
- Make educated deductions about suspects/situations  
- Connect dots between incidents
- Provide insight a regular person wouldn't have

Style: Think noir detective meets data analyst. Be specific, reference actual details from the incidents. Never be generic.`,
      messages: [{
        role: "user",
        content: `New incident just came in:
${JSON.stringify(incident, null, 2)}

Recent incidents in the last hour:
${JSON.stringify(recentIncidents.slice(0, 5), null, 2)}

Give your detective's take on this - what do you notice? Any connections? What should we watch for?`
      }]
    });

    return response.content[0].text;
  } catch (error) {
    console.error('[Claude Detective] Commentary error:', error.message);
    return null;
  }
}

async function buildCaseFile(linkedIncidents, linkAnalysis) {
  try {
    caseNumber++;
    
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `You are Claude, an AI detective. Create a case file for linked crimes.

Return JSON:
{
  "caseName": "string (creative name like 'The Bronx Phantom' or 'Midtown Smash & Grab Ring')",
  "summary": "string (2-3 sentence executive summary)",
  "suspectProfile": "string (what we can deduce about the perpetrator)",
  "modus_operandi": "string (how they operate)",
  "predictedNextMove": "string (where/when they might strike next)",
  "recommendedAction": "string (what police should do)",
  "confidenceLevel": "HIGH/MEDIUM/LOW",
  "threatLevel": "CRITICAL/HIGH/MEDIUM/LOW"
}`,
      messages: [{
        role: "user",
        content: `Build a case file for these linked incidents:
${JSON.stringify(linkedIncidents, null, 2)}

Link analysis: ${JSON.stringify(linkAnalysis)}`
      }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const caseData = JSON.parse(jsonMatch[0]);
      
      const caseFile = {
        id: caseNumber,
        ...caseData,
        incidents: linkedIncidents.map(i => i.id),
        incidentCount: linkedIncidents.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'OPEN'
      };
      
      caseFiles.set(caseNumber, caseFile);
      
      return caseFile;
    }
  } catch (error) {
    console.error('[Claude Detective] Case file error:', error.message);
  }
  return null;
}

app.post('/detective/ask', express.json(), async (req, res) => {
  const { question, incidentId, caseId } = req.body;
  
  if (!question) {
    return res.status(400).json({ error: 'Question required' });
  }
  
  let context = '';
  
  if (incidentId) {
    const incident = incidents.find(i => i.id === incidentId);
    if (incident) {
      context += `\nIncident in question:\n${JSON.stringify(incident, null, 2)}`;
    }
  }
  
  if (caseId) {
    const caseFile = caseFiles.get(parseInt(caseId));
    if (caseFile) {
      context += `\nCase file:\n${JSON.stringify(caseFile, null, 2)}`;
      const linkedIncs = incidents.filter(i => caseFile.incidents.includes(i.id));
      context += `\nLinked incidents:\n${JSON.stringify(linkedIncs, null, 2)}`;
    }
  }
  
  context += `\nRecent incidents:\n${JSON.stringify(incidents.slice(0, 10), null, 2)}`;
  
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `You are Claude, an AI detective working with the NYPD. You have access to real-time scanner data and incident reports.

Your personality:
- Analytical and observant
- Confident but not arrogant
- Sometimes darkly humorous
- You care about public safety
- You notice patterns and details others miss

Answer questions about crimes, incidents, and patterns. Be specific and reference actual data when possible. If you don't know something, say so - don't make things up.`,
      messages: [{
        role: "user",
        content: `Context:${context}

User's question: ${question}`
      }]
    });

    res.json({
      answer: response.content[0].text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/detective/cases', (req, res) => {
  const cases = Array.from(caseFiles.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(cases);
});

app.get('/detective/cases/:id', (req, res) => {
  const caseFile = caseFiles.get(parseInt(req.params.id));
  if (!caseFile) {
    return res.status(404).json({ error: 'Case not found' });
  }
  
  const fullIncidents = incidents.filter(i => caseFile.incidents.includes(i.id));
  res.json({ ...caseFile, fullIncidents });
});

app.get('/detective/briefing', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: `You are Claude, an AI detective providing a daily briefing. Be concise, insightful, and actionable.`,
      messages: [{
        role: "user",
        content: `Give me a detective's briefing based on recent activity:

Total incidents: ${incidents.length}
Open cases: ${caseFiles.size}

Recent incidents:
${JSON.stringify(incidents.slice(0, 15), null, 2)}

Active cases:
${JSON.stringify(Array.from(caseFiles.values()).slice(0, 5), null, 2)}

Provide:
1. Overall assessment of current crime activity
2. Top concerns/hotspots
3. Patterns you've noticed
4. Predictions for the next few hours
5. Recommendations`
      }]
    });

    res.json({
      briefing: response.content[0].text,
      stats: {
        totalIncidents: incidents.length,
        openCases: caseFiles.size,
        highPriorityIncidents: incidents.filter(i => ['CRITICAL', 'HIGH'].includes(i.priority)).length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Incident log
const incidents = [];
let incidentId = 0;

const recentTranscripts = [];
const MAX_TRANSCRIPTS = 20;

const audioClips = new Map();
const MAX_AUDIO_CLIPS = 50;

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function findNearestCamera(location, lat = null, lng = null, borough = null) {
  if (cameras.length === 0) {
    return null;
  }
  
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
  
  let searchCameras = cameras;
  if (borough && borough !== 'Unknown') {
    const boroughCameras = cameras.filter(cam => 
      cam.area && cam.area.toLowerCase().includes(borough.toLowerCase())
    );
    if (boroughCameras.length > 0) {
      searchCameras = boroughCameras;
    }
  }
  
  const locationLower = location.toLowerCase();
  
  for (const cam of searchCameras) {
    const camLocationLower = cam.location.toLowerCase();
    
    const locationParts = locationLower.split(/[&@,\s]+/);
    for (const part of locationParts) {
      if (part.length > 2 && camLocationLower.includes(part)) {
        return cam;
      }
    }
  }
  
  return searchCameras[Math.floor(Math.random() * searchCameras.length)];
}

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

async function transcribeAudio(audioBuffer) {
  try {
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

async function processAudioChunk(audioBuffer) {
  const transcript = await transcribeAudio(audioBuffer);
  if (!transcript || transcript.trim().length < 10) return;

  console.log("Transcript:", transcript);
  
  broadcast({
    type: "transcript",
    text: transcript,
    timestamp: new Date().toISOString()
  });

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
    
    checkBetsForIncident(incident);

    broadcast({
      type: "incident",
      incident: incident
    });

    broadcast({
      type: "camera_switch",
      camera: camera,
      reason: `${parsed.incidentType} at ${parsed.location}`
    });

    console.log("Incident detected:", incident);
  }

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
      
      if (data.type === 'audio_chunk') {
        const audioBuffer = Buffer.from(data.audio, 'base64');
        await processAudioChunk(audioBuffer);
      }
      
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
          
          checkBetsForIncident(incident);
          
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
    incidents: incidents.length,
    treasury: {
      netProfitSOL: treasury.netProfit / 1e9
    }
  });
});

app.get('/cameras', (req, res) => {
  res.json(cameras);
});

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

app.get('/refresh-cameras', async (req, res) => {
  await fetchNYCCameras();
  res.json({ count: cameras.length, message: 'Cameras refreshed' });
});

app.get('/incidents', (req, res) => {
  res.json(incidents);
});

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
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    
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

  req.on('close', () => {
    console.log(`[Stream Proxy] Client disconnected from ${feedInfo.name}`);
    proxyReq.destroy();
  });

  proxyReq.end();
});

app.get('/stream/feeds', (req, res) => {
  res.json({
    feeds: NYPD_FEEDS,
    currentFeed: NYPD_FEEDS[currentFeedIndex],
    streamUrl: '/stream/live'
  });
});

// ============================================
// SOLANA BETTING SYSTEM - DYNAMIC ODDS
// ============================================

const activeBets = new Map();
const userProfiles = new Map();
const betHistory = [];

app.post('/auth/verify', express.json(), (req, res) => {
  const { walletAddress, signature, message } = req.body;
  
  if (!walletAddress) {
    return res.status(400).json({ error: 'Wallet address required' });
  }
  
  let profile = userProfiles.get(walletAddress);
  if (!profile) {
    profile = {
      walletAddress: walletAddress,
      displayName: `detective_${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
      score: 0,
      totalBets: 0,
      wins: 0,
      totalWinnings: 0,
      createdAt: new Date().toISOString()
    };
    userProfiles.set(walletAddress, profile);
  }
  
  res.json({ 
    success: true, 
    profile,
    activeBets: Array.from(activeBets.values()).filter(b => b.walletAddress === walletAddress)
  });
});

// Get dynamic odds
app.get('/bet/odds', (req, res) => {
  const { type = 'any', window = 30 } = req.query;
  const windowMins = parseInt(window);
  
  const boroughs = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  const odds = boroughs.map(b => oddsEngine.getOdds(b, type, windowMins));
  
  res.json(odds);
});

// Get all odds for betting UI
app.get('/bet/all-odds', (req, res) => {
  const { window = 30 } = req.query;
  const windowMins = parseInt(window);
  const boroughs = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  const types = ['any', 'assault', 'robbery', 'traffic', 'shots fired'];
  
  const odds = {};
  boroughs.forEach(borough => {
    odds[borough] = {};
    types.forEach(type => {
      odds[borough][type] = oddsEngine.getOdds(borough, type, windowMins);
    });
  });
  
  res.json({
    timestamp: new Date().toISOString(),
    windowMinutes: windowMins,
    houseEdge: `${HOUSE_EDGE * 100}%`,
    odds,
    treasury: {
      totalReceivedSOL: treasury.totalReceived / 1e9,
      totalPaidOutSOL: treasury.totalPaidOut / 1e9,
      netProfitSOL: treasury.netProfit / 1e9,
    }
  });
});

// Treasury stats
app.get('/bet/treasury', (req, res) => {
  res.json({
    wallet: TREASURY_WALLET,
    totalReceivedSOL: treasury.totalReceived / 1e9,
    totalPaidOutSOL: treasury.totalPaidOut / 1e9,
    netProfitSOL: treasury.netProfit / 1e9,
    activeBets: activeBets.size,
    houseEdge: `${HOUSE_EDGE * 100}%`,
  });
});

// Place a bet with dynamic odds
app.post('/bet/place', express.json(), (req, res) => {
  const { walletAddress, borough, incidentType, amount, timeWindow, txSignature } = req.body;
  
  if (!walletAddress || !borough || !amount) {
    return res.status(400).json({ error: 'walletAddress, borough, and amount required' });
  }
  
  const lamports = parseInt(amount);
  if (lamports < 10000000) {
    return res.status(400).json({ error: 'Minimum bet is 0.01 SOL' });
  }
  if (lamports > 10000000000) {
    return res.status(400).json({ error: 'Maximum bet is 10 SOL' });
  }
  
  const existingBet = Array.from(activeBets.values()).find(
    b => b.walletAddress === walletAddress && b.status === 'ACTIVE'
  );
  if (existingBet) {
    return res.status(400).json({ error: 'You already have an active bet', bet: existingBet });
  }
  
  // GET DYNAMIC ODDS
  const type = incidentType || 'any';
  const window = timeWindow || 30;
  const odds = oddsEngine.getOdds(borough, type, window);
  
  const potentialWin = Math.floor(lamports * odds.multiplier);
  
  const betId = `bet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const bet = {
    id: betId,
    walletAddress,
    borough,
    incidentType: type,
    amount: lamports,
    amountSOL: lamports / 1e9,
    timeWindow: window,
    txSignature,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + window * 60 * 1000).toISOString(),
    status: 'ACTIVE',
    multiplier: odds.multiplier,
    probability: odds.probability,
    potentialWin: potentialWin,
    potentialWinSOL: potentialWin / 1e9,
  };
  
  activeBets.set(betId, bet);
  
  treasury.totalReceived += lamports;
  
  const profile = userProfiles.get(walletAddress);
  if (profile) profile.totalBets++;
  
  console.log(`[BET] ${bet.amountSOL} SOL on ${type} in ${borough} @ ${odds.multiplier}x (potential: ${bet.potentialWinSOL} SOL)`);
  
  broadcast({
    type: 'new_bet',
    bet: {
      id: bet.id,
      borough: bet.borough,
      incidentType: bet.incidentType,
      amount: bet.amountSOL,
      multiplier: bet.multiplier,
      potentialWinSOL: bet.potentialWinSOL,
      user: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    },
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, bet, odds });
});

app.get('/bet/pool', (req, res) => {
  const active = Array.from(activeBets.values()).filter(b => b.status === 'ACTIVE');
  
  const poolByBorough = {};
  active.forEach(bet => {
    if (!poolByBorough[bet.borough]) {
      poolByBorough[bet.borough] = { total: 0, count: 0 };
    }
    poolByBorough[bet.borough].total += bet.amount;
    poolByBorough[bet.borough].count++;
  });
  
  const totalPool = active.reduce((sum, b) => sum + b.amount, 0);
  
  res.json({
    totalPool: totalPool / 1e9,
    totalBets: active.length,
    poolByBorough: Object.fromEntries(
      Object.entries(poolByBorough).map(([k, v]) => [k, { 
        total: v.total / 1e9, 
        count: v.count 
      }])
    ),
    recentWinners: betHistory.filter(b => b.status === 'WON').slice(0, 5)
  });
});

app.get('/bet/history/:walletAddress', (req, res) => {
  const wallet = req.params.walletAddress;
  const userBets = betHistory.filter(b => b.walletAddress === wallet);
  const profile = userProfiles.get(wallet);
  
  res.json({
    profile,
    bets: userBets.slice(0, 50),
    activeBet: Array.from(activeBets.values()).find(b => b.walletAddress === wallet && b.status === 'ACTIVE')
  });
});

function checkBetsForIncident(incident) {
  const now = new Date();
  
  activeBets.forEach((bet, betId) => {
    if (bet.status !== 'ACTIVE') return;
    
    const expiresAt = new Date(bet.expiresAt);
    if (now > expiresAt) {
      bet.status = 'EXPIRED';
      bet.resolvedAt = now.toISOString();
      betHistory.unshift(bet);
      activeBets.delete(betId);
      console.log(`[BET] EXPIRED - kept ${bet.amountSOL} SOL`);
      return;
    }
    
    const boroughMatch = incident.borough?.toLowerCase() === bet.borough.toLowerCase();
    const typeMatch = bet.incidentType === 'any' || 
      incident.incidentType?.toLowerCase().includes(bet.incidentType.toLowerCase());
    
    if (boroughMatch && typeMatch) {
      bet.status = 'WON';
      bet.resolvedAt = now.toISOString();
      bet.matchedIncident = incident.id;
      bet.winnings = bet.potentialWin;
      
      treasury.totalPaidOut += bet.winnings;
      
      const profile = userProfiles.get(bet.walletAddress);
      if (profile) {
        profile.wins++;
        profile.score += 100;
        profile.totalWinnings += bet.winnings;
      }
      
      betHistory.unshift(bet);
      activeBets.delete(betId);
      
      console.log(`[BET] WINNER! Paying ${bet.winnings / 1e9} SOL (${bet.multiplier}x) to ${bet.walletAddress.slice(0, 8)}...`);
      console.log(`[TREASURY] Profit so far: ${treasury.netProfit / 1e9} SOL`);
      
      broadcast({
        type: 'bet_won',
        bet: {
          id: bet.id,
          user: `${bet.walletAddress.slice(0, 4)}...${bet.walletAddress.slice(-4)}`,
          amount: bet.amountSOL,
          multiplier: bet.multiplier,
          winnings: bet.winnings / 1e9,
          borough: bet.borough,
          incidentType: bet.incidentType
        },
        incident: {
          id: incident.id,
          type: incident.incidentType,
          location: incident.location
        },
        timestamp: new Date().toISOString()
      });
    }
  });
}

app.get('/bet/leaderboard', (req, res) => {
  const leaders = Array.from(userProfiles.values())
    .sort((a, b) => b.totalWinnings - a.totalWinnings)
    .slice(0, 20)
    .map(p => ({
      displayName: p.displayName,
      wins: p.wins,
      totalBets: p.totalBets,
      winnings: p.totalWinnings / 1e9,
      winRate: p.totalBets > 0 ? ((p.wins / p.totalBets) * 100).toFixed(1) + '%' : '0%'
    }));
  
  res.json(leaders);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// GAMIFICATION & ANALYSIS ENDPOINTS
// ============================================

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
    timeWindow: timeWindow || 30,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (timeWindow || 30) * 60 * 1000).toISOString(),
    status: 'PENDING'
  };
  
  const predictionId = `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  predictions.set(predictionId, prediction);
  
  res.json({ predictionId, prediction });
});

app.get('/game/predictions/:userId', (req, res) => {
  const userPredictions = [];
  predictions.forEach((pred, id) => {
    if (pred.userId === req.params.userId) {
      userPredictions.push({ id, ...pred });
    }
  });
  res.json(userPredictions);
});

const userScores = new Map();

app.get('/game/leaderboard', (req, res) => {
  const leaderboard = Array.from(userScores.entries())
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  
  res.json(leaderboard);
});

app.get('/game/challenges', (req, res) => {
  const challenges = [
    { id: 'night_owl', name: 'Night Owl', description: 'Monitor 10 incidents after midnight', points: 100, icon: '🦉' },
    { id: 'eagle_eye', name: 'Eagle Eye', description: 'Spot a HIGH priority incident within 30 seconds', points: 50, icon: '🦅' },
    { id: 'analyst', name: 'Crime Analyst', description: 'Correctly predict 5 incident locations', points: 200, icon: '🔍' },
    { id: 'manhattan_expert', name: 'Manhattan Expert', description: 'Track 50 incidents in Manhattan', points: 150, icon: '🏙️' },
    { id: 'pattern_spotter', name: 'Pattern Spotter', description: 'Identify a linked case before the AI', points: 500, icon: '🧠' }
  ];
  
  res.json(challenges);
});

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
    treasury: {
      netProfitSOL: treasury.netProfit / 1e9
    },
    uptime: process.uptime() + 's'
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ========================================================
  
     DISPATCH - Police Scanner Intelligence
     Running on port ${PORT}
     Treasury: ${TREASURY_WALLET.slice(0, 8)}...
     House Edge: ${HOUSE_EDGE * 100}%
  
     WebSocket: ws://localhost:${PORT}
     REST API:  http://localhost:${PORT}
  
  ========================================================
  `);
});
