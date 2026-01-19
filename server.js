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
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const clients = new Set();

// ============================================
// NYPD PRECINCT TO BOROUGH MAPPING
// ============================================

const PRECINCT_TO_BOROUGH = {
  // Manhattan (1-34)
  '1': 'Manhattan', '5': 'Manhattan', '6': 'Manhattan', '7': 'Manhattan', '9': 'Manhattan',
  '10': 'Manhattan', '13': 'Manhattan', '14': 'Manhattan', '17': 'Manhattan', '18': 'Manhattan',
  '19': 'Manhattan', '20': 'Manhattan', '22': 'Manhattan', '23': 'Manhattan', '24': 'Manhattan',
  '25': 'Manhattan', '26': 'Manhattan', '28': 'Manhattan', '30': 'Manhattan', '32': 'Manhattan',
  '33': 'Manhattan', '34': 'Manhattan',
  // Bronx (40-52)
  '40': 'Bronx', '41': 'Bronx', '42': 'Bronx', '43': 'Bronx', '44': 'Bronx',
  '45': 'Bronx', '46': 'Bronx', '47': 'Bronx', '48': 'Bronx', '49': 'Bronx',
  '50': 'Bronx', '52': 'Bronx',
  // Brooklyn (60-94)
  '60': 'Brooklyn', '61': 'Brooklyn', '62': 'Brooklyn', '63': 'Brooklyn', '66': 'Brooklyn',
  '67': 'Brooklyn', '68': 'Brooklyn', '69': 'Brooklyn', '70': 'Brooklyn', '71': 'Brooklyn',
  '72': 'Brooklyn', '73': 'Brooklyn', '75': 'Brooklyn', '76': 'Brooklyn', '77': 'Brooklyn',
  '78': 'Brooklyn', '79': 'Brooklyn', '81': 'Brooklyn', '83': 'Brooklyn', '84': 'Brooklyn',
  '88': 'Brooklyn', '90': 'Brooklyn', '94': 'Brooklyn',
  // Queens (100-115)
  '100': 'Queens', '101': 'Queens', '102': 'Queens', '103': 'Queens', '104': 'Queens',
  '105': 'Queens', '106': 'Queens', '107': 'Queens', '108': 'Queens', '109': 'Queens',
  '110': 'Queens', '111': 'Queens', '112': 'Queens', '113': 'Queens', '114': 'Queens', '115': 'Queens',
  // Staten Island (120-123)
  '120': 'Staten Island', '121': 'Staten Island', '122': 'Staten Island', '123': 'Staten Island'
};

// Common NYC landmarks and areas for better parsing
const NYC_LANDMARKS = [
  'Times Square', 'Penn Station', 'Grand Central', 'Port Authority', 'Lincoln Tunnel',
  'Holland Tunnel', 'Brooklyn Bridge', 'Manhattan Bridge', 'Williamsburg Bridge',
  'GW Bridge', 'George Washington Bridge', 'Yankee Stadium', 'Citi Field', 'JFK', 'LaGuardia',
  'Central Park', 'Prospect Park', 'Harlem', 'SoHo', 'Tribeca', 'Chinatown', 'Little Italy',
  'East Village', 'West Village', 'Midtown', 'Downtown', 'Uptown', 'FDR', 'West Side Highway',
  'BQE', 'LIE', 'Cross Bronx', 'Major Deegan', 'Bruckner', 'Flatbush', 'Atlantic Avenue',
  'Fulton Street', 'Broadway', '125th Street', '42nd Street', '34th Street', '14th Street',
  'Wall Street', 'Canal Street', 'Houston Street', 'Delancey', 'Bowery'
];

function getPrecinctBorough(precinctNum) {
  const num = precinctNum.toString().replace(/\D/g, '');
  return PRECINCT_TO_BOROUGH[num] || null;
}

// ============================================
// DETECTIVE BUREAU - 4 SPECIALIZED AGENTS
// ============================================

class DetectiveBureau {
  constructor(anthropicClient) {
    this.anthropic = anthropicClient;
    
    this.agents = {
      CHASE: {
        id: 'CHASE',
        name: 'CHASE',
        icon: 'ðŸš”',
        role: 'Pursuit Specialist',
        status: 'idle',
        triggers: ['pursuit', 'fled', 'fleeing', 'chase', 'vehicle pursuit', 'on foot', 'running', 'high speed', 'foot pursuit'],
        systemPrompt: `You are CHASE, a pursuit specialist AI. You predict escape routes, containment points, and track active pursuits across NYC. You know NYC street topology intimately - one-ways, dead ends, bridge/tunnel access. Keep responses to 2-3 sentences. Be tactical and specific.`
      },
      PATTERN: {
        id: 'PATTERN',
        name: 'PATTERN',
        icon: 'ðŸ”',
        role: 'Serial Crime Analyst',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are PATTERN, a serial crime analyst AI. You find connections between incidents - matching MOs, geographic clusters, temporal patterns, suspect descriptions. You name the patterns you discover. Keep responses to 2-3 sentences. Reference specific incident details.`
      },
      PROPHET: {
        id: 'PROPHET',
        name: 'PROPHET',
        icon: 'ðŸ”®',
        role: 'Predictive Analyst',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are PROPHET, a predictive analyst AI. You make specific, testable predictions about where and when incidents will occur. Always include location, time window, incident type, and confidence percentage. Your accuracy is tracked publicly.`
      },
      HISTORIAN: {
        id: 'HISTORIAN',
        name: 'HISTORIAN',
        icon: 'ðŸ“š',
        role: 'Historical Context',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are HISTORIAN, the memory of the Detective Bureau. You remember every incident, every address, every suspect description. When new incidents occur, you surface relevant history - "this address had 4 calls this week", "suspect matches description from yesterday". Keep responses to 2-3 sentences.`
      }
    };

    this.memory = {
      incidents: [],
      cases: new Map(),
      predictions: [],
      patterns: [],
      suspectProfiles: [],
      hotspots: new Map(),
      addressHistory: new Map()
    };

    this.predictionStats = {
      total: 0,
      correct: 0,
      pending: []
    };

    this.startProphetCycle();
    this.startPatternCycle();
  }

  async processIncident(incident, broadcast) {
    const insights = [];
    
    this.memory.incidents.unshift(incident);
    if (this.memory.incidents.length > 200) this.memory.incidents.pop();
    
    const addressKey = incident.location?.toLowerCase() || 'unknown';
    const addressCount = (this.memory.addressHistory.get(addressKey) || 0) + 1;
    this.memory.addressHistory.set(addressKey, addressCount);
    
    const hotspotKey = `${incident.borough}-${incident.location}`;
    this.memory.hotspots.set(hotspotKey, (this.memory.hotspots.get(hotspotKey) || 0) + 1);
    
    this.checkPredictionHit(incident, broadcast);

    // CHASE - Activates on pursuits
    if (this.shouldActivateChase(incident)) {
      this.agents.CHASE.status = 'active';
      const chaseInsight = await this.runChase(incident);
      if (chaseInsight) {
        insights.push(chaseInsight);
        broadcast({
          type: 'agent_insight',
          agent: 'CHASE',
          agentIcon: 'ðŸš”',
          incidentId: incident.id,
          analysis: chaseInsight,
          urgency: 'critical',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.CHASE.status = 'idle';
    }

    // HISTORIAN - Always runs (but only for incidents with locations)
    if (incident.location && incident.location !== 'Unknown') {
      this.agents.HISTORIAN.status = 'analyzing';
      const historianInsight = await this.runHistorian(incident, addressCount);
      if (historianInsight) {
        insights.push(historianInsight);
        broadcast({
          type: 'agent_insight',
          agent: 'HISTORIAN',
          agentIcon: 'ðŸ“š',
          incidentId: incident.id,
          analysis: historianInsight,
          urgency: addressCount > 3 ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.HISTORIAN.status = 'idle';
    }

    // PATTERN - Check for connections
    if (this.memory.incidents.length >= 3) {
      this.agents.PATTERN.status = 'analyzing';
      const patternInsight = await this.runPattern(incident);
      if (patternInsight) {
        insights.push(patternInsight);
        broadcast({
          type: 'agent_insight',
          agent: 'PATTERN',
          agentIcon: 'ðŸ”',
          incidentId: incident.id,
          analysis: patternInsight.analysis,
          urgency: patternInsight.confidence === 'HIGH' ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
        
        if (patternInsight.isPattern) {
          broadcast({
            type: 'pattern_detected',
            agent: 'PATTERN',
            pattern: patternInsight,
            timestamp: new Date().toISOString()
          });
        }
      }
      this.agents.PATTERN.status = 'idle';
    }

    return insights;
  }

  shouldActivateChase(incident) {
    const text = `${incident.incidentType} ${incident.summary || ''}`.toLowerCase();
    return this.agents.CHASE.triggers.some(trigger => text.includes(trigger));
  }

  async runChase(incident) {
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: this.agents.CHASE.systemPrompt,
        messages: [{
          role: "user",
          content: `ACTIVE PURSUIT:
Type: ${incident.incidentType}
Location: ${incident.location}
Borough: ${incident.borough}
Details: ${incident.summary}
Units: ${JSON.stringify(incident.units)}

Predict escape routes and recommend containment.`
        }]
      });
      return response.content[0].text;
    } catch (error) {
      console.error('[CHASE] Error:', error.message);
      return null;
    }
  }

  async runHistorian(incident, addressCount) {
    try {
      const relatedIncidents = this.memory.incidents.filter(inc => 
        inc.id !== incident.id && 
        (inc.location === incident.location || inc.borough === incident.borough)
      ).slice(0, 5);

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: this.agents.HISTORIAN.systemPrompt,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:
${JSON.stringify(incident)}

This address has had ${addressCount} calls recently.

Related incidents at same location/borough:
${JSON.stringify(relatedIncidents)}

What historical context is relevant?`
        }]
      });
      return response.content[0].text;
    } catch (error) {
      console.error('[HISTORIAN] Error:', error.message);
      return null;
    }
  }

  async runPattern(incident) {
    try {
      const recentSimilar = this.memory.incidents.filter(inc => {
        if (inc.id === incident.id) return false;
        const timeDiff = new Date(incident.timestamp) - new Date(inc.timestamp);
        const isRecent = timeDiff < 2 * 60 * 60 * 1000;
        return isRecent;
      }).slice(0, 10);

      if (recentSimilar.length < 2) return null;

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: this.agents.PATTERN.systemPrompt + `\n\nRespond in JSON: { "isPattern": true/false, "patternName": "string", "analysis": "string", "linkedIncidentIds": [numbers], "confidence": "HIGH/MEDIUM/LOW", "prediction": { "location": "string", "timeWindow": "string", "type": "string" } }`,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:
${JSON.stringify(incident)}

RECENT INCIDENTS (last 2 hours):
${JSON.stringify(recentSimilar)}

Are these connected? Is there a pattern forming?`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        if (result.isPattern) {
          this.memory.patterns.unshift({ ...result, detectedAt: new Date().toISOString(), status: 'active' });
          if (this.memory.patterns.length > 50) this.memory.patterns.pop();
        }
        return result;
      }
      return { isPattern: false, analysis: text };
    } catch (error) {
      console.error('[PATTERN] Error:', error.message);
      return null;
    }
  }

  startProphetCycle() {
    setInterval(async () => {
      await this.runProphet();
    }, 15 * 60 * 1000);
    
    setTimeout(() => this.runProphet(), 2 * 60 * 1000);
  }

  async runProphet() {
    if (this.memory.incidents.length < 5) return;
    
    this.agents.PROPHET.status = 'analyzing';
    
    try {
      const recentIncidents = this.memory.incidents.slice(0, 20);
      const hotspots = Array.from(this.memory.hotspots.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: this.agents.PROPHET.systemPrompt + `\n\nRespond in JSON: { "predictions": [{ "location": "specific NYC location", "borough": "string", "incidentType": "string", "timeWindowMinutes": number, "confidence": 0.0-1.0, "reasoning": "string" }] }. Make 1-3 specific predictions.`,
        messages: [{
          role: "user",
          content: `Current time: ${new Date().toISOString()}
Hour: ${new Date().getHours()}
Day: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}

RECENT INCIDENTS:
${JSON.stringify(recentIncidents)}

CURRENT HOTSPOTS:
${JSON.stringify(hotspots)}

Based on patterns and current activity, what incidents do you predict in the next 30-60 minutes?`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        for (const pred of result.predictions || []) {
          const prediction = {
            id: `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...pred,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (pred.timeWindowMinutes || 30) * 60 * 1000).toISOString(),
            status: 'pending'
          };
          
          this.predictionStats.pending.push(prediction);
          this.predictionStats.total++;
          
          broadcast({
            type: 'prophet_prediction',
            agent: 'PROPHET',
            agentIcon: 'ðŸ”®',
            prediction,
            timestamp: new Date().toISOString()
          });
          
          console.log(`[PROPHET] Prediction: ${pred.incidentType} at ${pred.location} (${(pred.confidence * 100).toFixed(0)}%)`);
        }
      }
    } catch (error) {
      console.error('[PROPHET] Error:', error.message);
    }
    
    this.agents.PROPHET.status = 'idle';
  }

  checkPredictionHit(incident, broadcast) {
    const now = new Date();
    
    this.predictionStats.pending = this.predictionStats.pending.filter(pred => {
      const expiresAt = new Date(pred.expiresAt);
      
      if (now > expiresAt) {
        pred.status = 'expired';
        return false;
      }
      
      const boroughMatch = incident.borough?.toLowerCase() === pred.borough?.toLowerCase();
      const typeMatch = incident.incidentType?.toLowerCase().includes(pred.incidentType?.toLowerCase()) ||
                       pred.incidentType?.toLowerCase().includes(incident.incidentType?.toLowerCase());
      
      if (boroughMatch && typeMatch) {
        pred.status = 'hit';
        pred.matchedIncidentId = incident.id;
        this.predictionStats.correct++;
        
        broadcast({
          type: 'prediction_hit',
          agent: 'PROPHET',
          agentIcon: 'ðŸ”®',
          prediction: pred,
          matchedIncident: incident,
          accuracy: this.getAccuracy(),
          timestamp: new Date().toISOString()
        });
        
        console.log(`[PROPHET] PREDICTION HIT! ${pred.incidentType} at ${pred.location}`);
        return false;
      }
      
      return true;
    });
  }

  startPatternCycle() {
    setInterval(async () => {
      if (this.memory.incidents.length < 10) return;
      
      this.agents.PATTERN.status = 'analyzing';
      
      try {
        const response = await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: this.agents.PATTERN.systemPrompt,
          messages: [{
            role: "user",
            content: `Analyze the last 50 incidents for patterns:\n${JSON.stringify(this.memory.incidents.slice(0, 50))}`
          }]
        });
        
        console.log('[PATTERN] Background analysis complete');
      } catch (error) {
        console.error('[PATTERN] Background error:', error.message);
      }
      
      this.agents.PATTERN.status = 'idle';
    }, 5 * 60 * 1000);
  }

  getAccuracy() {
    if (this.predictionStats.total === 0) return '0%';
    return `${((this.predictionStats.correct / this.predictionStats.total) * 100).toFixed(1)}%`;
  }

  getAgentStatuses() {
    return Object.values(this.agents).map(agent => ({
      id: agent.id,
      name: agent.name,
      icon: agent.icon,
      role: agent.role,
      status: agent.status
    }));
  }

  getPredictionStats() {
    return {
      total: this.predictionStats.total,
      correct: this.predictionStats.correct,
      accuracy: this.getAccuracy(),
      pending: this.predictionStats.pending
    };
  }

  async askAgents(question, context = {}) {
    const responses = [];
    
    for (const agent of Object.values(this.agents)) {
      try {
        const response = await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: agent.systemPrompt,
          messages: [{
            role: "user",
            content: `Question: ${question}\n\nRecent incidents: ${JSON.stringify(this.memory.incidents.slice(0, 10))}`
          }]
        });
        
        responses.push({
          agent: agent.name,
          agentIcon: agent.icon,
          answer: response.content[0].text
        });
      } catch (error) {
        console.error(`[${agent.name}] Ask error:`, error.message);
      }
    }
    
    return { responses, timestamp: new Date().toISOString() };
  }

  async generateBriefing() {
    const stats = {
      totalIncidents: this.memory.incidents.length,
      patterns: this.memory.patterns.filter(p => p.status === 'active').length,
      predictions: this.predictionStats,
      hotspots: Array.from(this.memory.hotspots.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
    };

    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: `You are the Detective Bureau briefing officer. Summarize current activity, patterns, predictions, and recommendations. Be concise and actionable.`,
        messages: [{
          role: "user",
          content: `Generate briefing:
Stats: ${JSON.stringify(stats)}
Recent incidents: ${JSON.stringify(this.memory.incidents.slice(0, 15))}
Active patterns: ${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'))}
Pending predictions: ${JSON.stringify(this.predictionStats.pending)}`
        }]
      });

      return {
        briefing: response.content[0].text,
        stats,
        agents: this.getAgentStatuses(),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return { error: error.message, stats, agents: this.getAgentStatuses() };
    }
  }
}

const detectiveBureau = new DetectiveBureau(anthropic);

// ============================================
// BETTING SYSTEM
// ============================================

const TREASURY_WALLET = process.env.TREASURY_WALLET || 'YOUR_SOLANA_WALLET_HERE';
const HOUSE_EDGE = 0.05;

const oddsEngine = {
  boroughRates: { 'Manhattan': 12.5, 'Brooklyn': 9.8, 'Bronx': 7.2, 'Queens': 6.1, 'Staten Island': 1.4 },
  incidentTypeRarity: { 'any': 1.0, 'traffic': 0.25, 'medical': 0.20, 'domestic': 0.15, 'assault': 0.12, 'suspicious': 0.10, 'theft': 0.08, 'robbery': 0.05, 'pursuit': 0.03, 'shots fired': 0.02 },
  timeMultipliers: { 0: 0.7, 1: 0.5, 2: 0.4, 3: 0.3, 4: 0.4, 5: 0.5, 6: 0.7, 7: 0.9, 8: 1.0, 9: 1.0, 10: 1.0, 11: 1.1, 12: 1.2, 13: 1.1, 14: 1.0, 15: 1.1, 16: 1.2, 17: 1.3, 18: 1.4, 19: 1.5, 20: 1.6, 21: 1.5, 22: 1.3, 23: 1.0 },
  
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
    return { borough, incidentType, windowMinutes, probability: Math.round(prob * 1000) / 10, multiplier: mult };
  }
};

const treasury = { totalReceived: 0, totalPaidOut: 0, get netProfit() { return this.totalReceived - this.totalPaidOut; } };
const activeBets = new Map();
const userProfiles = new Map();
const betHistory = [];

// ============================================
// CAMERAS & SCANNER
// ============================================

let cameras = [];
const incidents = [];
let incidentId = 0;
const recentTranscripts = [];
const MAX_TRANSCRIPTS = 20;
const audioClips = new Map();
const MAX_AUDIO_CLIPS = 50;

async function fetchNYCCameras() {
  try {
    const response = await fetch('https://webcams.nyctmc.org/api/cameras');
    const data = await response.json();
    cameras = data.filter(cam => cam.isOnline === true || cam.isOnline === "true").map(cam => ({
      id: cam.id, location: cam.name, lat: cam.latitude, lng: cam.longitude, area: cam.area || "NYC",
      imageUrl: `https://webcams.nyctmc.org/api/cameras/${cam.id}/image`, isOnline: true
    }));
    console.log(`Loaded ${cameras.length} NYC traffic cameras`);
  } catch (error) {
    console.error("Failed to fetch NYC cameras:", error);
    cameras = [
      { id: "07b8616e-373e-4ec9-89cc-11cad7d59fcb", location: "Worth St @ Centre St", lat: 40.715157, lng: -74.00213, area: "Manhattan" },
      { id: "8d2b3ae9-da68-4d37-8ae2-d3bc014f827b", location: "Bedford Ave & S 5 St", lat: 40.710983, lng: -73.963168, area: "Brooklyn" },
    ];
  }
}
fetchNYCCameras();

// Broadcastify Scanner
const BROADCASTIFY_USERNAME = 'whitefang123';
const BROADCASTIFY_PASSWORD = process.env.BROADCASTIFY_PASSWORD;
const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1' },
  { id: '40185', name: 'NYPD Citywide 2' },
  { id: '40186', name: 'NYPD Citywide 3' },
];

let currentFeedIndex = 0;
let lastProcessTime = Date.now();

// INCREASED from 10 seconds to 20 seconds to capture full transmissions
const CHUNK_DURATION = 20000;

let scannerStats = { currentFeed: null, lastChunkTime: null, lastTranscript: null, totalChunks: 0, successfulTranscripts: 0 };

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => { if (client.readyState === 1) client.send(message); });
}

async function startBroadcastifyStream() {
  if (!BROADCASTIFY_PASSWORD) { console.log('BROADCASTIFY_PASSWORD not set'); return; }
  const feed = NYPD_FEEDS[currentFeedIndex];
  console.log(`Connecting to: ${feed.name}`);

  const options = {
    hostname: 'audio.broadcastify.com', port: 443, path: `/${feed.id}.mp3`, method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
      setTimeout(startBroadcastifyStream, 5000);
      return;
    }
    handleStream(res, feed);
  });
  req.on('error', () => { currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length; setTimeout(startBroadcastifyStream, 10000); });
  req.end();
}

function handleStream(stream, feed) {
  console.log(`Connected to ${feed.name}!`);
  scannerStats.currentFeed = feed.name;
  let chunks = [];
  
  stream.on('data', (chunk) => {
    chunks.push(chunk);
    if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(chunks);
      chunks = [];
      lastProcessTime = Date.now();
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.totalChunks++;
      processAudioFromStream(fullBuffer, feed.name);
    }
  });
  
  stream.on('end', () => { setTimeout(startBroadcastifyStream, 2000); });
  stream.on('error', () => { setTimeout(startBroadcastifyStream, 5000); });
}

async function transcribeAudio(audioBuffer) {
  try {
    const file = await toFile(audioBuffer, 'audio.mp3', { type: 'audio/mpeg' });
    const transcription = await openai.audio.transcriptions.create({
      file, model: "whisper-1", language: "en",
      prompt: "NYPD police radio dispatch with locations. 10-4, 10-13, 10-85, K, forthwith, precinct, sector, central, responding. Addresses like 123 Main Street, intersections like 42nd and Lex, landmarks like Times Square, Penn Station."
    });
    return transcription.text;
  } catch (error) { return null; }
}

// ============================================
// IMPROVED LOCATION PARSING
// ============================================

async function parseTranscript(transcript) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `You are an expert NYPD radio parser. Your PRIMARY job is to extract LOCATION information.

LOCATION EXTRACTION RULES:
1. Look for street addresses: "123 West 45th Street" â†’ location: "123 W 45th St"
2. Look for intersections: "42nd and Lexington", "at the corner of Broadway and 125th" â†’ location: "42nd St & Lexington Ave"
3. Look for landmarks: "Times Square", "Penn Station", "Grand Central", "Port Authority" â†’ use landmark name
4. Look for precinct references: "the 7-5", "75 precinct", "seven-five" â†’ location: "75th Precinct", borough: "Brooklyn"
5. Look for sector/Adam/Boy/Charlie designations with location context
6. Look for highways: "FDR at 96th", "BQE", "Cross Bronx" â†’ use highway location
7. Look for project names, building names, park names

PRECINCT TO BOROUGH MAPPING:
- 1-34: Manhattan
- 40-52: Bronx  
- 60-94: Brooklyn
- 100-115: Queens
- 120-123: Staten Island

When you hear "the 7-5" or "75" or "seven-five" in context of a precinct, that's the 75th Precinct in Brooklyn.
When you hear "the 4-4" or "44", that's the 44th Precinct in the Bronx.

If NO location can be determined, set location to null (not "Unknown").

INCIDENT TYPE MAPPING:
- 10-10: Possible crime
- 10-13: Officer needs assistance (CRITICAL)
- 10-30: Robbery in progress
- 10-31: Burglary in progress
- 10-34: Assault
- 10-52: Dispute
- 10-53: Accident
- 10-54: Ambulance needed
- 10-85: Backup needed
- Shots fired, shooting, gun â†’ Shots Fired
- EDP, emotionally disturbed â†’ EDP
- Pursuit, chase, fleeing â†’ Pursuit

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
  "precinctMentioned": "number or null"
}`,
      messages: [{ role: "user", content: `Parse this NYPD radio transmission and extract any location information:\n\n"${transcript}"` }]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // If precinct mentioned but no borough, look it up
      if (parsed.precinctMentioned && (!parsed.borough || parsed.borough === 'Unknown')) {
        const boroughFromPrecinct = getPrecinctBorough(parsed.precinctMentioned);
        if (boroughFromPrecinct) {
          parsed.borough = boroughFromPrecinct;
          if (!parsed.location || parsed.location === 'Unknown') {
            parsed.location = `${parsed.precinctMentioned}th Precinct area`;
          }
        }
      }
      
      // Convert null location to "Unknown" for backwards compatibility
      if (parsed.location === null) {
        parsed.location = 'Unknown';
      }
      
      return parsed;
    }
    return { hasIncident: false };
  } catch (error) {
    console.error('[PARSE] Error:', error.message);
    return { hasIncident: false };
  }
}

function findNearestCamera(location, lat, lng, borough) {
  if (cameras.length === 0) return null;
  let searchCameras = cameras;
  
  // First, try to match by borough
  if (borough && borough !== 'Unknown') {
    const boroughCameras = cameras.filter(cam => cam.area?.toLowerCase().includes(borough.toLowerCase()));
    if (boroughCameras.length > 0) searchCameras = boroughCameras;
  }
  
  // If we have a location string, try to find a camera with matching street name
  if (location && location !== 'Unknown') {
    const locationLower = location.toLowerCase();
    const matchingCameras = searchCameras.filter(cam => {
      const camLocation = cam.location?.toLowerCase() || '';
      // Check for street name matches
      const locationWords = locationLower.split(/[\s&@]+/).filter(w => w.length > 2);
      return locationWords.some(word => camLocation.includes(word));
    });
    
    if (matchingCameras.length > 0) {
      return matchingCameras[Math.floor(Math.random() * matchingCameras.length)];
    }
  }
  
  // Fallback to random camera in borough
  return searchCameras[Math.floor(Math.random() * searchCameras.length)];
}

async function processAudioFromStream(buffer, feedName) {
  if (buffer.length < 5000) return;
  
  const transcript = await transcribeAudio(buffer);
  if (!transcript || transcript.trim().length < 10) return;
  
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  
  // Filter out noise
  const noise = ['thank you', 'thanks for watching', 'subscribe', 'you', 'bye', 'music'];
  if (noise.some(n => lower === n || lower === n + '.')) return;
  if (lower.includes('broadcastify') || lower.includes('fema.gov')) return;
  
  scannerStats.lastTranscript = clean.substring(0, 200);
  scannerStats.successfulTranscripts++;
  
  const transcriptEntry = { text: clean, source: feedName, timestamp: new Date().toISOString() };
  recentTranscripts.unshift(transcriptEntry);
  if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
  
  broadcast({ type: "transcript", ...transcriptEntry });
  
  const parsed = await parseTranscript(clean);
  
  if (parsed.hasIncident) {
    incidentId++;
    const camera = findNearestCamera(parsed.location, null, null, parsed.borough);
    
    const audioId = `audio_${incidentId}_${Date.now()}`;
    audioClips.set(audioId, buffer);
    if (audioClips.size > MAX_AUDIO_CLIPS) audioClips.delete(audioClips.keys().next().value);
    
    const incident = {
      id: incidentId,
      ...parsed,
      transcript: clean,
      audioUrl: `/audio/${audioId}`,
      camera,
      lat: camera?.lat,
      lng: camera?.lng,
      source: feedName,
      timestamp: new Date().toISOString()
    };
    
    incidents.unshift(incident);
    if (incidents.length > 50) incidents.pop();
    
    // Process through Detective Bureau
    detectiveBureau.processIncident(incident, broadcast);
    
    // Check bets
    checkBetsForIncident(incident);
    
    broadcast({ type: "incident", incident });
    if (camera) broadcast({ type: "camera_switch", camera, reason: `${parsed.incidentType} at ${parsed.location}`, priority: parsed.priority });
    
    console.log('[INCIDENT]', incident.incidentType, '@', incident.location, `(${incident.borough})`);
  } else {
    // Broadcast as monitoring even if no incident detected
    broadcast({
      type: "analysis",
      text: `[MONITORING] ${clean.substring(0, 100)}...`,
      location: 'Unknown',
      timestamp: new Date().toISOString()
    });
  }
}

setTimeout(startBroadcastifyStream, 5000);

// ============================================
// BETTING FUNCTIONS
// ============================================

function checkBetsForIncident(incident) {
  const now = new Date();
  activeBets.forEach((bet, betId) => {
    if (bet.status !== 'ACTIVE') return;
    if (now > new Date(bet.expiresAt)) {
      bet.status = 'EXPIRED';
      betHistory.unshift(bet);
      activeBets.delete(betId);
      return;
    }
    const boroughMatch = incident.borough?.toLowerCase() === bet.borough.toLowerCase();
    const typeMatch = bet.incidentType === 'any' || incident.incidentType?.toLowerCase().includes(bet.incidentType.toLowerCase());
    if (boroughMatch && typeMatch) {
      bet.status = 'WON';
      bet.winnings = bet.potentialWin;
      treasury.totalPaidOut += bet.winnings;
      const profile = userProfiles.get(bet.walletAddress);
      if (profile) { profile.wins++; profile.totalWinnings += bet.winnings; }
      betHistory.unshift(bet);
      activeBets.delete(betId);
      broadcast({
        type: 'bet_won',
        bet: { id: bet.id, user: `${bet.walletAddress.slice(0,4)}...${bet.walletAddress.slice(-4)}`, amount: bet.amountSOL, multiplier: bet.multiplier, winnings: bet.winnings / 1e9, borough: bet.borough },
        incident: { id: incident.id, type: incident.incidentType, location: incident.location },
        timestamp: new Date().toISOString()
      });
      console.log(`[BET] WINNER! ${bet.winnings / 1e9} SOL`);
    }
  });
}

// ============================================
// API ROUTES
// ============================================

// Detective Bureau endpoints
app.get('/detective/agents', (req, res) => res.json(detectiveBureau.getAgentStatuses()));
app.get('/detective/predictions', (req, res) => res.json(detectiveBureau.getPredictionStats()));
app.get('/detective/patterns', (req, res) => res.json({ active: detectiveBureau.memory.patterns.filter(p => p.status === 'active'), total: detectiveBureau.memory.patterns.length }));
app.get('/detective/hotspots', (req, res) => {
  const hotspots = Array.from(detectiveBureau.memory.hotspots.entries()).map(([key, count]) => {
    const [borough, location] = key.split('-');
    return { borough, location, count };
  }).sort((a, b) => b.count - a.count).slice(0, 50);
  res.json(hotspots);
});
app.get('/detective/briefing', async (req, res) => {
  const briefing = await detectiveBureau.generateBriefing();
  res.json(briefing);
});
app.post('/detective/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const response = await detectiveBureau.askAgents(question);
  res.json(response);
});

// Betting endpoints
app.get('/bet/odds', (req, res) => {
  const { type = 'any', window = 30 } = req.query;
  const boroughs = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  res.json(boroughs.map(b => oddsEngine.getOdds(b, type, parseInt(window))));
});
app.get('/bet/all-odds', (req, res) => {
  const { window = 30 } = req.query;
  const boroughs = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  const types = ['any', 'assault', 'robbery', 'traffic', 'shots fired'];
  const odds = {};
  boroughs.forEach(b => { odds[b] = {}; types.forEach(t => { odds[b][t] = oddsEngine.getOdds(b, t, parseInt(window)); }); });
  res.json({ timestamp: new Date().toISOString(), windowMinutes: parseInt(window), houseEdge: `${HOUSE_EDGE * 100}%`, odds, treasury: { totalReceivedSOL: treasury.totalReceived / 1e9, totalPaidOutSOL: treasury.totalPaidOut / 1e9, netProfitSOL: treasury.netProfit / 1e9 } });
});
app.get('/bet/treasury', (req, res) => res.json({ wallet: TREASURY_WALLET, totalReceivedSOL: treasury.totalReceived / 1e9, totalPaidOutSOL: treasury.totalPaidOut / 1e9, netProfitSOL: treasury.netProfit / 1e9, activeBets: activeBets.size, houseEdge: `${HOUSE_EDGE * 100}%` }));
app.get('/bet/pool', (req, res) => {
  const active = Array.from(activeBets.values()).filter(b => b.status === 'ACTIVE');
  const poolByBorough = {};
  active.forEach(bet => { if (!poolByBorough[bet.borough]) poolByBorough[bet.borough] = { total: 0, count: 0 }; poolByBorough[bet.borough].total += bet.amount; poolByBorough[bet.borough].count++; });
  res.json({ totalPool: active.reduce((s, b) => s + b.amount, 0) / 1e9, totalBets: active.length, poolByBorough: Object.fromEntries(Object.entries(poolByBorough).map(([k, v]) => [k, { total: v.total / 1e9, count: v.count }])), recentWinners: betHistory.filter(b => b.status === 'WON').slice(0, 5) });
});
app.get('/bet/leaderboard', (req, res) => {
  const leaders = Array.from(userProfiles.values()).sort((a, b) => b.totalWinnings - a.totalWinnings).slice(0, 20).map(p => ({ displayName: p.displayName, wins: p.wins, totalBets: p.totalBets, winnings: p.totalWinnings / 1e9, winRate: p.totalBets > 0 ? ((p.wins / p.totalBets) * 100).toFixed(1) + '%' : '0%' }));
  res.json(leaders);
});
app.post('/bet/place', (req, res) => {
  const { walletAddress, borough, incidentType, amount, timeWindow, txSignature } = req.body;
  if (!walletAddress || !borough || !amount) return res.status(400).json({ error: 'Missing fields' });
  const lamports = parseInt(amount);
  if (lamports < 10000000 || lamports > 10000000000) return res.status(400).json({ error: 'Bet must be 0.01-10 SOL' });
  const existing = Array.from(activeBets.values()).find(b => b.walletAddress === walletAddress && b.status === 'ACTIVE');
  if (existing) return res.status(400).json({ error: 'Active bet exists', bet: existing });
  
  const type = incidentType || 'any';
  const window = timeWindow || 30;
  const odds = oddsEngine.getOdds(borough, type, window);
  const potentialWin = Math.floor(lamports * odds.multiplier);
  
  const betId = `bet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const bet = { id: betId, walletAddress, borough, incidentType: type, amount: lamports, amountSOL: lamports / 1e9, timeWindow: window, txSignature, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + window * 60 * 1000).toISOString(), status: 'ACTIVE', multiplier: odds.multiplier, probability: odds.probability, potentialWin, potentialWinSOL: potentialWin / 1e9 };
  
  activeBets.set(betId, bet);
  treasury.totalReceived += lamports;
  
  let profile = userProfiles.get(walletAddress);
  if (!profile) { profile = { walletAddress, displayName: `${walletAddress.slice(0,4)}...${walletAddress.slice(-4)}`, totalBets: 0, wins: 0, totalWinnings: 0 }; userProfiles.set(walletAddress, profile); }
  profile.totalBets++;
  
  broadcast({ type: 'new_bet', bet: { id: bet.id, borough: bet.borough, incidentType: bet.incidentType, amount: bet.amountSOL, multiplier: bet.multiplier, potentialWinSOL: bet.potentialWinSOL, user: profile.displayName }, timestamp: new Date().toISOString() });
  
  res.json({ success: true, bet, odds });
});

app.post('/auth/verify', (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet required' });
  let profile = userProfiles.get(walletAddress);
  if (!profile) { profile = { walletAddress, displayName: `${walletAddress.slice(0,4)}...${walletAddress.slice(-4)}`, totalBets: 0, wins: 0, totalWinnings: 0, createdAt: new Date().toISOString() }; userProfiles.set(walletAddress, profile); }
  res.json({ success: true, profile, activeBets: Array.from(activeBets.values()).filter(b => b.walletAddress === walletAddress) });
});

// Core endpoints
app.get('/', (req, res) => res.json({ name: "DISPATCH NYC", status: "operational", connections: clients.size, incidents: incidents.length, agents: detectiveBureau.getAgentStatuses(), predictionAccuracy: detectiveBureau.getAccuracy() }));
app.get('/cameras', (req, res) => res.json(cameras));
app.get('/incidents', (req, res) => res.json(incidents));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/audio/:id', (req, res) => { const buffer = audioClips.get(req.params.id); if (!buffer) return res.status(404).json({ error: 'Not found' }); res.set('Content-Type', 'audio/mpeg'); res.send(buffer); });
app.get('/camera-image/:id', async (req, res) => { try { const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`); const buffer = await response.arrayBuffer(); res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(buffer)); } catch (e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/stream/feeds', (req, res) => res.json({ feeds: NYPD_FEEDS, currentFeed: NYPD_FEEDS[currentFeedIndex], streamUrl: '/stream/live' }));
app.get('/debug', (req, res) => res.json({ scanner: scannerStats, connections: clients.size, incidents: incidents.length, cameras: cameras.length, agents: detectiveBureau.getAgentStatuses(), predictions: detectiveBureau.getPredictionStats() }));

// WebSocket
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: "init",
    incidents: incidents.slice(0, 20),
    cameras,
    transcripts: recentTranscripts.slice(0, 10),
    currentFeed: NYPD_FEEDS[currentFeedIndex]?.name,
    agents: detectiveBureau.getAgentStatuses(),
    predictions: detectiveBureau.getPredictionStats()
  }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'manual_transcript') {
        broadcast({ type: "transcript", text: data.text, timestamp: new Date().toISOString() });
        const parsed = await parseTranscript(data.text);
        if (parsed.hasIncident) {
          incidentId++;
          const camera = findNearestCamera(parsed.location, null, null, parsed.borough);
          const incident = { id: incidentId, ...parsed, camera, lat: camera?.lat, lng: camera?.lng, timestamp: new Date().toISOString() };
          incidents.unshift(incident);
          detectiveBureau.processIncident(incident, broadcast);
          checkBetsForIncident(incident);
          broadcast({ type: "incident", incident });
          if (camera) broadcast({ type: "camera_switch", camera, reason: `${parsed.incidentType} at ${parsed.location}` });
        }
      }
    } catch (e) { console.error('WS error:', e); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
â•‘  ðŸš¨ DISPATCH NYC - Police Scanner Intelligence         â•‘
â•‘  Port: ${PORT}                                            â•‘
â•‘  Agents: CHASE | PATTERN | PROPHET | HISTORIAN         â•‘
â•‘  Chunk Duration: ${CHUNK_DURATION/1000}s (improved for full transmissions)  â•‘
â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  `);
});
