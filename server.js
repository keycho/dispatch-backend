import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import https from 'https';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ============================================
// PERSISTENCE - Save incidents to file
// ============================================
const DATA_DIR = process.env.DATA_DIR || './data';
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.json');
const TRANSCRIPTS_FILE = path.join(DATA_DIR, 'transcripts.json');
const DETECTIVE_FILE = path.join(DATA_DIR, 'detective.json');
const MAX_INCIDENT_AGE_HOURS = 6; // Keep incidents for 6 hours

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadIncidents() {
  try {
    if (fs.existsSync(INCIDENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
      const cutoff = Date.now() - (MAX_INCIDENT_AGE_HOURS * 60 * 60 * 1000);
      // Filter out old incidents
      return data.filter(inc => new Date(inc.timestamp).getTime() > cutoff);
    }
  } catch (error) {
    console.error('[PERSISTENCE] Error loading incidents:', error.message);
  }
  return [];
}

function saveIncidents(incidents) {
  try {
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents.slice(0, 100), null, 2));
  } catch (error) {
    console.error('[PERSISTENCE] Error saving incidents:', error.message);
  }
}

function loadTranscripts() {
  try {
    if (fs.existsSync(TRANSCRIPTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRANSCRIPTS_FILE, 'utf8'));
      const cutoff = Date.now() - (MAX_INCIDENT_AGE_HOURS * 60 * 60 * 1000);
      return data.filter(t => new Date(t.timestamp).getTime() > cutoff);
    }
  } catch (error) {
    console.error('[PERSISTENCE] Error loading transcripts:', error.message);
  }
  return [];
}

function saveTranscripts(transcripts) {
  try {
    fs.writeFileSync(TRANSCRIPTS_FILE, JSON.stringify(transcripts.slice(0, 50), null, 2));
  } catch (error) {
    console.error('[PERSISTENCE] Error saving transcripts:', error.message);
  }
}

function loadDetectiveState() {
  try {
    if (fs.existsSync(DETECTIVE_FILE)) {
      const data = JSON.parse(fs.readFileSync(DETECTIVE_FILE, 'utf8'));
      const cutoff = Date.now() - (MAX_INCIDENT_AGE_HOURS * 60 * 60 * 1000);
      // Filter old data
      if (data.patterns) {
        data.patterns = data.patterns.filter(p => new Date(p.detectedAt).getTime() > cutoff);
      }
      if (data.predictions) {
        data.predictions = data.predictions.filter(p => new Date(p.createdAt).getTime() > cutoff);
      }
      return data;
    }
  } catch (error) {
    console.error('[PERSISTENCE] Error loading detective state:', error.message);
  }
  return null;
}

function saveDetectiveState(bureau) {
  try {
    const state = {
      patterns: bureau.memory.patterns.slice(0, 50),
      predictions: bureau.predictionStats.pending.slice(0, 20),
      predictionStats: {
        total: bureau.predictionStats.total,
        correct: bureau.predictionStats.correct
      },
      hotspots: Array.from(bureau.memory.hotspots.entries()).slice(0, 100),
      agentInsights: {
        CHASE: bureau.agents.CHASE.recentInsights.slice(0, 10),
        PATTERN: bureau.agents.PATTERN.recentInsights.slice(0, 10),
        PROPHET: bureau.agents.PROPHET.recentInsights.slice(0, 10),
        HISTORIAN: bureau.agents.HISTORIAN.recentInsights.slice(0, 10)
      },
      agentLastActive: {
        CHASE: bureau.agents.CHASE.lastActive,
        PATTERN: bureau.agents.PATTERN.lastActive,
        PROPHET: bureau.agents.PROPHET.lastActive,
        HISTORIAN: bureau.agents.HISTORIAN.lastActive
      },
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DETECTIVE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[PERSISTENCE] Error saving detective state:', error.message);
  }
}

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
        icon: '🚔',
        role: 'Pursuit Specialist',
        status: 'idle',
        lastActive: null,
        recentInsights: [],
        triggers: ['pursuit', 'fled', 'fleeing', 'chase', 'vehicle pursuit', 'on foot', 'running', 'high speed', 'foot pursuit'],
        systemPrompt: `You are CHASE, a pursuit specialist AI. You predict escape routes, containment points, and track active pursuits across NYC. You know NYC street topology intimately - one-ways, dead ends, bridge/tunnel access. Keep responses to 2-3 sentences. Be tactical and specific.`
      },
      PATTERN: {
        id: 'PATTERN',
        name: 'PATTERN',
        icon: '🔍',
        role: 'Serial Crime Analyst',
        status: 'idle',
        lastActive: null,
        recentInsights: [],
        triggers: [],
        systemPrompt: `You are PATTERN, a serial crime analyst AI. You find connections between incidents - matching MOs, geographic clusters, temporal patterns, suspect descriptions. You name the patterns you discover. Keep responses to 2-3 sentences. Reference specific incident details.`
      },
      PROPHET: {
        id: 'PROPHET',
        name: 'PROPHET',
        icon: '🔮',
        role: 'Predictive Analyst',
        status: 'idle',
        lastActive: null,
        recentInsights: [],
        triggers: [],
        systemPrompt: `You are PROPHET, a predictive analyst AI. You make specific, testable predictions about where and when incidents will occur. Always include location, time window, incident type, and confidence percentage. Your accuracy is tracked publicly.`
      },
      HISTORIAN: {
        id: 'HISTORIAN',
        name: 'HISTORIAN',
        icon: '📚',
        role: 'Historical Context',
        status: 'idle',
        lastActive: null,
        recentInsights: [],
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
        // Track agent activity
        this.agents.CHASE.lastActive = new Date().toISOString();
        this.agents.CHASE.recentInsights.unshift({
          text: chaseInsight,
          incidentId: incident.id,
          timestamp: new Date().toISOString()
        });
        if (this.agents.CHASE.recentInsights.length > 10) this.agents.CHASE.recentInsights.pop();
        
        broadcast({
          type: 'agent_insight',
          agent: 'CHASE',
          agentIcon: '🚔',
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
        // Track agent activity
        this.agents.HISTORIAN.lastActive = new Date().toISOString();
        this.agents.HISTORIAN.recentInsights.unshift({
          text: historianInsight,
          incidentId: incident.id,
          timestamp: new Date().toISOString()
        });
        if (this.agents.HISTORIAN.recentInsights.length > 10) this.agents.HISTORIAN.recentInsights.pop();
        
        broadcast({
          type: 'agent_insight',
          agent: 'HISTORIAN',
          agentIcon: '📚',
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
        // Track agent activity
        this.agents.PATTERN.lastActive = new Date().toISOString();
        this.agents.PATTERN.recentInsights.unshift({
          text: patternInsight.analysis,
          incidentId: incident.id,
          isPattern: patternInsight.isPattern,
          timestamp: new Date().toISOString()
        });
        if (this.agents.PATTERN.recentInsights.length > 10) this.agents.PATTERN.recentInsights.pop();
        
        broadcast({
          type: 'agent_insight',
          agent: 'PATTERN',
          agentIcon: '🔍',
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

      // Check for nearby correctional facilities
      const facilityContext = getFacilityContext(incident);
      let facilityInfo = '';
      if (facilityContext) {
        facilityInfo = `\n\nCORRECTIONAL FACILITY PROXIMITY:
- Nearby facility: ${facilityContext.facility} (${facilityContext.shortName})
- Distance: ${facilityContext.distance}km
- During release hours: ${facilityContext.duringReleaseHours ? 'YES (5-10 AM)' : 'No'}
- Note: ${facilityContext.note}`;
      }

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 250,
        system: this.agents.HISTORIAN.systemPrompt + `\n\nYou also track proximity to NYC correctional facilities (Rikers Island, The Tombs, Brooklyn House, Queens House, Vernon C. Bain). If an incident is near a facility during release hours (5-10 AM), note this as potentially relevant context.`,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:
${JSON.stringify(incident)}

This address has had ${addressCount} calls recently.

Related incidents at same location/borough:
${JSON.stringify(relatedIncidents)}${facilityInfo}

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
          // Ensure confidence is a proper number between 0 and 1
          const confidence = typeof pred.confidence === 'number' ? pred.confidence : 0.5;
          
          const prediction = {
            id: `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...pred,
            confidence: confidence, // Ensure it's set
            confidencePercent: Math.round(confidence * 100), // Add percentage for display
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + (pred.timeWindowMinutes || 30) * 60 * 1000).toISOString(),
            status: 'pending'
          };
          
          this.predictionStats.pending.push(prediction);
          this.predictionStats.total++;
          
          // Track PROPHET activity
          this.agents.PROPHET.lastActive = new Date().toISOString();
          this.agents.PROPHET.recentInsights.unshift({
            text: `Predicted ${pred.incidentType} in ${pred.borough} (${prediction.confidencePercent}% confidence)`,
            predictionId: prediction.id,
            timestamp: new Date().toISOString()
          });
          if (this.agents.PROPHET.recentInsights.length > 10) this.agents.PROPHET.recentInsights.pop();
          
          broadcast({
            type: 'prophet_prediction',
            agent: 'PROPHET',
            agentIcon: '🔮',
            prediction,
            timestamp: new Date().toISOString()
          });
          
          console.log(`[PROPHET] Prediction: ${pred.incidentType} at ${pred.location} (${prediction.confidencePercent}%)`);
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
          agentIcon: '🔮',
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
      status: agent.status,
      lastActive: agent.lastActive,
      recentInsights: agent.recentInsights.slice(0, 5),
      insightCount: agent.recentInsights.length
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

  restoreState(savedState) {
    if (!savedState) return;
    
    try {
      if (savedState.patterns && Array.isArray(savedState.patterns)) {
        this.memory.patterns = savedState.patterns;
        console.log(`[DETECTIVE] Restored ${savedState.patterns.length} patterns`);
      }
      
      if (savedState.predictions && Array.isArray(savedState.predictions)) {
        this.predictionStats.pending = savedState.predictions;
        console.log(`[DETECTIVE] Restored ${savedState.predictions.length} pending predictions`);
      }
      
      if (savedState.predictionStats) {
        this.predictionStats.total = savedState.predictionStats.total || 0;
        this.predictionStats.correct = savedState.predictionStats.correct || 0;
        console.log(`[DETECTIVE] Restored prediction stats: ${this.getAccuracy()} accuracy`);
      }
      
      if (savedState.hotspots && Array.isArray(savedState.hotspots)) {
        this.memory.hotspots = new Map(savedState.hotspots);
        console.log(`[DETECTIVE] Restored ${savedState.hotspots.length} hotspots`);
      }
      
      // Restore agent insights
      if (savedState.agentInsights) {
        for (const agentId of ['CHASE', 'PATTERN', 'PROPHET', 'HISTORIAN']) {
          if (savedState.agentInsights[agentId] && Array.isArray(savedState.agentInsights[agentId])) {
            this.agents[agentId].recentInsights = savedState.agentInsights[agentId];
          }
        }
        console.log(`[DETECTIVE] Restored agent insights`);
      }
      
      // Restore agent lastActive timestamps
      if (savedState.agentLastActive) {
        for (const agentId of ['CHASE', 'PATTERN', 'PROPHET', 'HISTORIAN']) {
          if (savedState.agentLastActive[agentId]) {
            this.agents[agentId].lastActive = savedState.agentLastActive[agentId];
          }
        }
        console.log(`[DETECTIVE] Restored agent activity timestamps`);
      }
    } catch (error) {
      console.error('[DETECTIVE] Error restoring state:', error.message);
    }
  }
}

const detectiveBureau = new DetectiveBureau(anthropic);

// Restore detective bureau state from persistence
const savedDetectiveState = loadDetectiveState();
if (savedDetectiveState) {
  detectiveBureau.restoreState(savedDetectiveState);
  // Also restore incidents to detective memory
  detectiveBureau.memory.incidents = incidents.slice(0, 200);
  console.log(`[DETECTIVE] Restored ${incidents.length} incidents to memory`);
}

// Periodically save detective state (every 2 minutes)
setInterval(() => {
  saveDetectiveState(detectiveBureau);
}, 2 * 60 * 1000);

// ============================================
// NYC CORRECTIONAL FACILITIES INTEGRATION
// ============================================

// NYC DOC Facility Locations (static data)
const NYC_CORRECTIONAL_FACILITIES = [
  {
    id: 'rikers_island',
    name: 'Rikers Island Complex',
    shortName: 'Rikers',
    type: 'jail',
    borough: 'Bronx', // Technically between Bronx/Queens
    lat: 40.7932,
    lng: -73.8860,
    capacity: 10000,
    description: 'Main NYC jail complex with multiple facilities',
    facilities: [
      'Anna M. Kross Center (AMKC)',
      'Eric M. Taylor Center (EMTC)', 
      'George R. Vierno Center (GRVC)',
      'North Infirmary Command (NIC)',
      'Otis Bantum Correctional Center (OBCC)',
      'Robert N. Davoren Center (RNDC)',
      'Rose M. Singer Center (RMSC) - Women',
      'George Motchan Detention Center (GMDC)',
      'West Facility (WF)'
    ],
    releaseInfo: {
      typicalReleaseTime: '6:00 AM - 8:00 AM',
      typicalDailyReleases: '50-150',
      releaseLocation: 'Queens side of Rikers Island Bridge'
    }
  },
  {
    id: 'manhattan_detention',
    name: 'Manhattan Detention Complex',
    shortName: 'The Tombs',
    type: 'jail',
    borough: 'Manhattan',
    lat: 40.7142,
    lng: -74.0015,
    capacity: 898,
    description: 'Located at 125 White Street, adjacent to Manhattan Criminal Court',
    releaseInfo: {
      typicalReleaseTime: '24/7 releases',
      typicalDailyReleases: '20-50',
      releaseLocation: '125 White Street entrance'
    }
  },
  {
    id: 'brooklyn_detention',
    name: 'Brooklyn Detention Complex',
    shortName: 'Brooklyn House',
    type: 'jail',
    borough: 'Brooklyn',
    lat: 40.6892,
    lng: -73.9836,
    capacity: 759,
    description: 'Located at 275 Atlantic Avenue',
    releaseInfo: {
      typicalReleaseTime: '6:00 AM - 10:00 AM',
      typicalDailyReleases: '15-40',
      releaseLocation: 'Atlantic Avenue entrance'
    }
  },
  {
    id: 'queens_detention',
    name: 'Queens Detention Facility',
    shortName: 'Queens House',
    type: 'jail',
    borough: 'Queens',
    lat: 40.7282,
    lng: -73.8303,
    capacity: 500,
    description: 'Located at 126-02 82nd Avenue, Kew Gardens',
    releaseInfo: {
      typicalReleaseTime: '6:00 AM - 8:00 AM',
      typicalDailyReleases: '10-30',
      releaseLocation: '82nd Avenue entrance'
    }
  },
  {
    id: 'vernon_bain',
    name: 'Vernon C. Bain Center',
    shortName: 'The Boat',
    type: 'jail',
    borough: 'Bronx',
    lat: 40.8058,
    lng: -73.8778,
    capacity: 800,
    description: 'Floating detention facility (barge) at Hunts Point',
    releaseInfo: {
      typicalReleaseTime: '6:00 AM - 8:00 AM',
      typicalDailyReleases: '10-25',
      releaseLocation: 'Hunts Point dock'
    }
  }
];

// Extended facility data storage
let facilityIntelligence = {
  population: {
    lastFetch: null,
    current: 0,
    trend: 'stable', // increasing, decreasing, stable
    history: [] // last 30 days
  },
  discharges: {
    lastFetch: null,
    today: 0,
    average: 98,
    byDayOfWeek: { Sun: 72, Mon: 95, Tue: 102, Wed: 108, Thu: 115, Fri: 145, Sat: 85 },
    history: []
  },
  admissions: {
    lastFetch: null,
    today: 0,
    average: 105,
    history: []
  },
  q100Bus: {
    lastFetch: null,
    schedule: [],
    nextBus: null,
    firstBus: '5:45 AM',
    lastBus: '2:30 AM',
    frequency: '10-20 min peak, 30 min off-peak'
  },
  complaints311: {
    lastFetch: null,
    nearRikers: [],
    nearTombs: [],
    nearBrooklyn: [],
    total24h: 0
  },
  arrests: {
    lastFetch: null,
    byPrecinct: {},
    total7d: 0,
    trend: 'stable'
  }
};

// Q100 Bus Schedule (Rikers Island - only way off the island)
// Based on MTA schedule - buses run 24/7
const Q100_SCHEDULE = {
  weekday: {
    // Peak hours (5 AM - 10 AM) - every 10-15 min during release time
    peakStart: 5,
    peakEnd: 10,
    peakFrequencyMin: 10,
    // Off-peak - every 20-30 min
    offPeakFrequencyMin: 20,
    // Overnight - every 30-40 min
    overnightFrequencyMin: 35
  },
  weekend: {
    peakStart: 7,
    peakEnd: 11,
    peakFrequencyMin: 15,
    offPeakFrequencyMin: 25,
    overnightFrequencyMin: 40
  },
  stops: [
    { name: 'Rikers Island', lat: 40.7932, lng: -73.8860, isOrigin: true },
    { name: 'Hazen St/19 Ave', lat: 40.7785, lng: -73.8863 },
    { name: '19 Ave/Hazen St', lat: 40.7771, lng: -73.8889 },
    { name: 'Queens Plaza (E/M/R)', lat: 40.7505, lng: -73.9375, isTerminal: true }
  ]
};

// Calculate next Q100 buses
function getNextQ100Buses(count = 5) {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const schedule = isWeekend ? Q100_SCHEDULE.weekend : Q100_SCHEDULE.weekday;
  
  let frequency;
  if (hour >= schedule.peakStart && hour < schedule.peakEnd) {
    frequency = schedule.peakFrequencyMin;
  } else if (hour >= 6 && hour < 22) {
    frequency = schedule.offPeakFrequencyMin;
  } else {
    frequency = schedule.overnightFrequencyMin;
  }
  
  const buses = [];
  let nextMinute = Math.ceil(minute / frequency) * frequency;
  let nextHour = hour;
  
  for (let i = 0; i < count; i++) {
    if (nextMinute >= 60) {
      nextMinute -= 60;
      nextHour = (nextHour + 1) % 24;
    }
    
    const busTime = new Date(now);
    busTime.setHours(nextHour, nextMinute, 0, 0);
    
    if (busTime <= now) {
      busTime.setMinutes(busTime.getMinutes() + frequency);
    }
    
    const minutesUntil = Math.round((busTime - now) / 60000);
    
    buses.push({
      time: busTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
      minutesUntil,
      isPeak: hour >= schedule.peakStart && hour < schedule.peakEnd,
      destination: 'Queens Plaza'
    });
    
    nextMinute += frequency;
  }
  
  return buses;
}

// Fetch comprehensive DOC data
async function fetchFacilityPopulation() {
  try {
    // NYC DOC Daily Inmates In Custody dataset
    const response = await fetch(
      'https://data.cityofnewyork.us/resource/7479-ugqb.json?$order=date_of_data%20DESC&$limit=30',
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      throw new Error(`NYC Open Data returned ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      const latest = data[0];
      const previous = data[1];
      
      const currentPop = parseInt(latest.total_inmates) || 0;
      const previousPop = previous ? parseInt(previous.total_inmates) || 0 : currentPop;
      
      // Calculate trend
      let trend = 'stable';
      if (currentPop > previousPop + 20) trend = 'increasing';
      else if (currentPop < previousPop - 20) trend = 'decreasing';
      
      // Build history
      const history = data.map(d => ({
        date: d.date_of_data,
        population: parseInt(d.total_inmates) || 0,
        ada: parseInt(d.total_ada_inmates) || 0
      }));
      
      facilityIntelligence.population = {
        lastFetch: new Date().toISOString(),
        dataDate: latest.date_of_data,
        current: currentPop,
        previous: previousPop,
        change: currentPop - previousPop,
        trend,
        ada: parseInt(latest.total_ada_inmates) || 0,
        history
      };
      
      // Estimate daily discharges based on typical patterns
      const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
      const typicalDischarges = facilityIntelligence.discharges.byDayOfWeek[dayOfWeek];
      
      facilityIntelligence.discharges.today = typicalDischarges + Math.floor(Math.random() * 30) - 15;
      facilityIntelligence.discharges.lastFetch = new Date().toISOString();
      
      console.log(`[FACILITIES] Population: ${currentPop} (${trend}, ${currentPop - previousPop >= 0 ? '+' : ''}${currentPop - previousPop})`);
      console.log(`[FACILITIES] Est. discharges today: ${facilityIntelligence.discharges.today} (${dayOfWeek} avg: ${typicalDischarges})`);
    }
    
    return facilityIntelligence.population;
  } catch (error) {
    console.error(`[FACILITIES] Population fetch error: ${error.message}`);
    return facilityIntelligence.population;
  }
}

// Fetch 311 complaints near facilities
async function fetch311NearFacilities() {
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // 311 complaints in Queens near Rikers (zip codes 11370, 11372)
    const rikersUrl = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$where=created_date%3E%3D'${yesterday}'&incident_zip=11370&$limit=50`;
    const rikersResponse = await fetch(rikersUrl, { 
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    }).catch(e => null);
    
    if (rikersResponse && rikersResponse.ok) {
      const rikersData = await rikersResponse.json();
      facilityIntelligence.complaints311.nearRikers = (rikersData || []).map(c => ({
        type: c.complaint_type || 'Unknown',
        descriptor: c.descriptor || '',
        address: c.incident_address || '',
        created: c.created_date,
        status: c.status || ''
      })).slice(0, 20);
    }
    
    // 311 complaints in Manhattan near The Tombs (zip 10013)
    const tombsUrl = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$where=created_date%3E%3D'${yesterday}'&incident_zip=10013&$limit=50`;
    const tombsResponse = await fetch(tombsUrl, { 
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    }).catch(e => null);
    
    if (tombsResponse && tombsResponse.ok) {
      const tombsData = await tombsResponse.json();
      facilityIntelligence.complaints311.nearTombs = (tombsData || []).map(c => ({
        type: c.complaint_type || 'Unknown',
        descriptor: c.descriptor || '',
        address: c.incident_address || '',
        created: c.created_date,
        status: c.status || ''
      })).slice(0, 20);
    }
    
    // Brooklyn near detention (zip 11201)
    const brooklynUrl = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$where=created_date%3E%3D'${yesterday}'&incident_zip=11201&$limit=50`;
    const brooklynResponse = await fetch(brooklynUrl, { 
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    }).catch(e => null);
    
    if (brooklynResponse && brooklynResponse.ok) {
      const brooklynData = await brooklynResponse.json();
      facilityIntelligence.complaints311.nearBrooklyn = (brooklynData || []).map(c => ({
        type: c.complaint_type || 'Unknown',
        descriptor: c.descriptor || '',
        address: c.incident_address || '',
        created: c.created_date,
        status: c.status || ''
      })).slice(0, 20);
    }
    
    facilityIntelligence.complaints311.total24h = 
      facilityIntelligence.complaints311.nearRikers.length +
      facilityIntelligence.complaints311.nearTombs.length +
      facilityIntelligence.complaints311.nearBrooklyn.length;
    
    facilityIntelligence.complaints311.lastFetch = new Date().toISOString();
    
    console.log(`[FACILITIES] 311 complaints near facilities (24h): ${facilityIntelligence.complaints311.total24h}`);
    
  } catch (error) {
    console.error(`[FACILITIES] 311 fetch error: ${error.message}`);
  }
}

// Fetch NYPD arrest data (CompStat)
async function fetchArrestData() {
  try {
    // NYPD Arrests Data (Year to Date)
    const response = await fetch(
      'https://data.cityofnewyork.us/resource/uip8-fykc.json?$limit=100&$order=arrest_date%20DESC',
      { 
        headers: { 'Accept': 'application/json' },
        timeout: 10000
      }
    ).catch(e => null);
    
    if (response && response.ok) {
      const data = await response.json();
      
      if (data && Array.isArray(data)) {
        // Group by precinct
        const byPrecinct = {};
        data.forEach(arrest => {
          const pct = arrest.arrest_precinct || 'Unknown';
          byPrecinct[pct] = (byPrecinct[pct] || 0) + 1;
        });
        
        facilityIntelligence.arrests = {
          lastFetch: new Date().toISOString(),
          byPrecinct,
          total7d: data.length,
          recentArrests: data.slice(0, 20).map(a => ({
            date: a.arrest_date || '',
            precinct: a.arrest_precinct || '',
            offense: a.ofns_desc || '',
            borough: a.arrest_boro || ''
          })),
          trend: 'stable'
        };
        
        console.log(`[FACILITIES] Arrest data: ${data.length} recent arrests`);
      }
    }
  } catch (error) {
    console.error(`[FACILITIES] Arrest fetch error: ${error.message}`);
  }
}

// Get comprehensive facility status
function getFacilityStatus() {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
  
  const nextBuses = getNextQ100Buses(5);
  
  return {
    timestamp: now.toISOString(),
    
    // Release window status
    releaseWindow: {
      active: hour >= 5 && hour <= 10,
      status: hour >= 5 && hour <= 10 ? 'ACTIVE' : (hour < 5 ? 'PENDING' : 'CLOSED'),
      peakHours: '6:00 AM - 8:00 AM',
      nextWindowIn: hour >= 10 ? `${24 - hour + 5} hours` : (hour < 5 ? `${5 - hour} hours` : 'NOW')
    },
    
    // Population
    population: {
      current: facilityIntelligence.population.current,
      change: facilityIntelligence.population.change,
      trend: facilityIntelligence.population.trend,
      dataDate: facilityIntelligence.population.dataDate
    },
    
    // Discharges
    discharges: {
      estimatedToday: facilityIntelligence.discharges.today,
      dayAverage: facilityIntelligence.discharges.byDayOfWeek[dayOfWeek],
      weekdayPattern: facilityIntelligence.discharges.byDayOfWeek,
      note: dayOfWeek === 'Fri' ? 'Fridays typically have highest releases' : null
    },
    
    // Q100 Bus
    q100: {
      nextBuses,
      nextBusIn: nextBuses[0]?.minutesUntil + ' min',
      isPeakTime: nextBuses[0]?.isPeak,
      note: 'Q100 is the only public transit to/from Rikers Island'
    },
    
    // 311 Activity
    complaints311: {
      total24h: facilityIntelligence.complaints311.total24h,
      nearRikers: facilityIntelligence.complaints311.nearRikers.length,
      nearTombs: facilityIntelligence.complaints311.nearTombs.length,
      nearBrooklyn: facilityIntelligence.complaints311.nearBrooklyn.length,
      topTypes: getTop311Types()
    },
    
    // Recent arrests (pipeline to facilities)
    arrests: {
      recent7d: facilityIntelligence.arrests.total7d,
      topPrecincts: getTopPrecincts(),
      note: 'Arrests flow into facility intake within 24-48 hours'
    }
  };
}

function getTop311Types() {
  const allComplaints = [
    ...facilityIntelligence.complaints311.nearRikers,
    ...facilityIntelligence.complaints311.nearTombs,
    ...facilityIntelligence.complaints311.nearBrooklyn
  ];
  
  const types = {};
  allComplaints.forEach(c => {
    types[c.type] = (types[c.type] || 0) + 1;
  });
  
  return Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));
}

function getTopPrecincts() {
  const precincts = facilityIntelligence.arrests.byPrecinct || {};
  return Object.entries(precincts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([precinct, count]) => ({ precinct, count }));
}

// Population data storage (keep for backwards compatibility)
let facilityPopulation = {
  lastFetch: null,
  facilities: {},
  totalPopulation: 0,
  dailyAdmissions: 0,
  dailyReleases: 0,
  fetchErrors: 0
};

// Sync facilityPopulation with facilityIntelligence
function syncFacilityPopulation() {
  facilityPopulation = {
    lastFetch: facilityIntelligence.population.lastFetch,
    dataDate: facilityIntelligence.population.dataDate,
    totalPopulation: facilityIntelligence.population.current,
    change: facilityIntelligence.population.change,
    trend: facilityIntelligence.population.trend,
    estimatedDischarges: facilityIntelligence.discharges.today,
    facilities: {},
    fetchErrors: 0
  };
}

// Get facility near a location
function getNearbyFacility(lat, lng, radiusKm = 2) {
  if (!lat || !lng) return null;
  
  for (const facility of NYC_CORRECTIONAL_FACILITIES) {
    const distance = Math.sqrt(
      Math.pow((facility.lat - lat) * 111, 2) + // 1 degree lat ≈ 111km
      Math.pow((facility.lng - lng) * 85, 2)    // 1 degree lng ≈ 85km at NYC latitude
    );
    
    if (distance <= radiusKm) {
      return {
        ...facility,
        distanceKm: Math.round(distance * 10) / 10
      };
    }
  }
  
  return null;
}

// Check if current time is during typical release hours
function isDuringReleaseHours() {
  const hour = new Date().getHours();
  return hour >= 5 && hour <= 10; // 5 AM - 10 AM
}

// Get release context for an incident
function getFacilityContext(incident) {
  const nearbyFacility = getNearbyFacility(incident.lat, incident.lng);
  
  if (!nearbyFacility) return null;
  
  const context = {
    facility: nearbyFacility.name,
    shortName: nearbyFacility.shortName,
    distance: nearbyFacility.distanceKm,
    duringReleaseHours: isDuringReleaseHours()
  };
  
  if (context.duringReleaseHours) {
    context.note = `Incident ${context.distance}km from ${context.shortName} during typical release hours (${nearbyFacility.releaseInfo.typicalReleaseTime})`;
  } else {
    context.note = `Incident ${context.distance}km from ${context.shortName}`;
  }
  
  return context;
}

// Start facility data fetch cycle
async function startFacilityFetching() {
  console.log('[FACILITIES] Starting comprehensive facility data fetching...');
  
  // Initial fetches
  await fetchFacilityPopulation();
  syncFacilityPopulation();
  
  await fetch311NearFacilities();
  await fetchArrestData();
  
  // Update Q100 bus schedule
  facilityIntelligence.q100.schedule = getNextQ100Buses(10);
  facilityIntelligence.q100.nextBus = facilityIntelligence.q100.schedule[0];
  facilityIntelligence.q100.lastFetch = new Date().toISOString();
  
  console.log('[FACILITIES] Initial data fetch complete');
  
  // Broadcast comprehensive update
  broadcast({
    type: 'facility_update',
    facilities: NYC_CORRECTIONAL_FACILITIES,
    population: facilityPopulation,
    intelligence: getFacilityStatus(),
    timestamp: new Date().toISOString()
  });
  
  // Fetch population every 30 minutes
  setInterval(async () => {
    await fetchFacilityPopulation();
    syncFacilityPopulation();
    
    broadcast({
      type: 'facility_update',
      facilities: NYC_CORRECTIONAL_FACILITIES,
      population: facilityPopulation,
      intelligence: getFacilityStatus(),
      timestamp: new Date().toISOString()
    });
  }, 30 * 60 * 1000);
  
  // Fetch 311 every 15 minutes
  setInterval(async () => {
    await fetch311NearFacilities();
  }, 15 * 60 * 1000);
  
  // Fetch arrests every hour
  setInterval(async () => {
    await fetchArrestData();
  }, 60 * 60 * 1000);
  
  // Update bus schedule every 5 minutes
  setInterval(() => {
    facilityIntelligence.q100.schedule = getNextQ100Buses(10);
    facilityIntelligence.q100.nextBus = facilityIntelligence.q100.schedule[0];
    facilityIntelligence.q100.lastFetch = new Date().toISOString();
  }, 5 * 60 * 1000);
}

// Start fetching after server starts
setTimeout(startFacilityFetching, 10000);

// ============================================
// BETTING SYSTEM
// ============================================

const TREASURY_WALLET = process.env.TREASURY_WALLET || 'YOUR_SOLANA_WALLET_HERE';
const HOUSE_EDGE = 0.08; // 8% house edge

const oddsEngine = {
  // Base rates: expected DETECTED incidents per hour per borough
  // These are much lower than actual incidents because:
  // 1. Scanner doesn't catch everything
  // 2. AI must classify it correctly
  // 3. Location must be parsed successfully
  boroughRates: { 
    'Manhattan': 2.5,      // ~2-3 detected incidents/hour
    'Brooklyn': 2.0, 
    'Bronx': 1.8, 
    'Queens': 1.2, 
    'Staten Island': 0.3   // Much quieter
  },
  
  // Incident type probability relative to "any"
  // These multiply against base rate - lower = rarer = higher payout
  incidentTypeRarity: { 
    'any': 1.0,            // Any detected incident
    'traffic': 0.20,       // 20% of incidents are traffic
    'medical': 0.15,       // 15% medical
    'domestic': 0.12,      // 12% domestic
    'assault': 0.08,       // 8% assault  
    'suspicious': 0.10,    // 10% suspicious person/vehicle
    'theft': 0.06,         // 6% theft/larceny
    'robbery': 0.03,       // 3% robbery (rarer, higher payout)
    'pursuit': 0.02,       // 2% pursuit/chase
    'shots fired': 0.01    // 1% shots fired (very rare, big payout)
  },
  
  // Time of day multipliers (crime patterns)
  timeMultipliers: { 
    0: 0.8, 1: 0.5, 2: 0.4, 3: 0.3, 4: 0.3, 5: 0.4,   // Late night - quieter
    6: 0.6, 7: 0.8, 8: 1.0, 9: 1.0, 10: 1.0, 11: 1.0, // Morning rush
    12: 1.1, 13: 1.0, 14: 1.0, 15: 1.1, 16: 1.2,      // Afternoon
    17: 1.3, 18: 1.4, 19: 1.5, 20: 1.6, 21: 1.5,      // Evening peak
    22: 1.3, 23: 1.0                                    // Late evening
  },
  
  calculateProbability(borough, incidentType = 'any', windowMinutes = 30) {
    const hour = new Date().getHours();
    const baseRate = this.boroughRates[borough] || 1.0;
    const timeAdjusted = baseRate * (this.timeMultipliers[hour] || 1.0);
    const typeMultiplier = this.incidentTypeRarity[incidentType.toLowerCase()] || 0.05;
    
    // Expected incidents in the time window
    const expectedIncidents = (timeAdjusted * typeMultiplier / 60) * windowMinutes;
    
    // Poisson probability of at least 1 incident: 1 - e^(-lambda)
    // Cap at 85% to ensure house edge always works
    const probability = Math.min(0.85, 1 - Math.exp(-expectedIncidents));
    
    // Floor at 2% (minimum probability for very rare events)
    return Math.max(0.02, probability);
  },
  
  calculateMultiplier(probability) {
    // Fair odds = 1 / probability
    // With house edge: fair * (1 - edge)
    const fairOdds = 1 / probability;
    const withEdge = fairOdds * (1 - HOUSE_EDGE);
    
    // Round to 1 decimal place, min 1.1x, max 45x
    return Math.max(1.1, Math.min(45.0, Math.round(withEdge * 10) / 10));
  },
  
  // Calculate expected value for the player (should be negative = house wins)
  calculateExpectedValue(probability, multiplier) {
    // EV = (prob * multiplier) - 1
    // Negative EV = house edge working
    return (probability * multiplier) - 1;
  },
  
  getOdds(borough, incidentType = 'any', windowMinutes = 30) {
    const prob = this.calculateProbability(borough, incidentType, windowMinutes);
    const mult = this.calculateMultiplier(prob);
    const ev = this.calculateExpectedValue(prob, mult);
    
    return { 
      borough, 
      incidentType, 
      windowMinutes, 
      probability: Math.round(prob * 100),     // Show as whole percentage (e.g., 45 for 45%)
      probabilityRaw: prob,                     // Raw decimal for calculations
      multiplier: mult,
      expectedValue: Math.round(ev * 1000) / 1000, // House edge check (should be negative)
      houseEdge: `${HOUSE_EDGE * 100}%`
    };
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
const incidents = loadIncidents(); // Load persisted incidents on startup
let incidentId = incidents.length > 0 ? Math.max(...incidents.map(i => i.id || 0)) + 1 : 1;
const recentTranscripts = loadTranscripts(); // Load persisted transcripts
const MAX_TRANSCRIPTS = 50;
const audioClips = new Map();
const MAX_AUDIO_CLIPS = 50;

console.log(`[PERSISTENCE] Loaded ${incidents.length} incidents, ${recentTranscripts.length} transcripts from storage`);

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

// NYPD and NYC area feeds only
const SCANNER_FEEDS = [
  // NYPD Citywide
  { id: '40184', name: 'NYPD Citywide 1', area: 'Citywide' },
  { id: '40185', name: 'NYPD Citywide 2', area: 'Citywide' },
  { id: '40186', name: 'NYPD Citywide 3', area: 'Citywide' },
  // NYPD Borough
  { id: '8498', name: 'NYPD Manhattan South', area: 'Manhattan' },
  { id: '8499', name: 'NYPD Manhattan North', area: 'Manhattan' },
  { id: '31371', name: 'NYPD Brooklyn North', area: 'Brooklyn' },
  { id: '31372', name: 'NYPD Brooklyn South', area: 'Brooklyn' },
  { id: '9275', name: 'NYPD Queens North', area: 'Queens' },
  { id: '31373', name: 'NYPD Bronx', area: 'Bronx' },
  // NYC EMS/Fire for more activity
  { id: '8464', name: 'FDNY Citywide', area: 'Citywide' },
  { id: '30875', name: 'NYC EMS', area: 'Citywide' },
  // Transit
  { id: '31653', name: 'NYPD Transit 1-2', area: 'Transit' },
  { id: '31654', name: 'NYPD Transit 3-4', area: 'Transit' },
];

// Keep NYPD_FEEDS reference for backwards compatibility
const NYPD_FEEDS = SCANNER_FEEDS;

let currentFeedIndex = 0;
let lastProcessTime = Date.now();
let consecutivePSAs = 0;
let currentStream = null;
let feedAttempts = new Map();

const CHUNK_DURATION = 20000;

// Detect when Whisper hallucinates/echoes the prompt (happens on silence)
function isPromptEcho(text) {
  const lower = text.toLowerCase();
  // If it contains multiple 10-codes in a row without other content, it's likely an echo
  if (lower.includes('10-4, 10-13, 10-85')) return true;
  if (lower.includes('10-4 10-13 10-85')) return true;
  if (lower.includes('forthwith, precinct, sector, central')) return true;
  // Very short repeated phrases
  if (lower.match(/^(10-\d+[,\s]*){3,}$/)) return true;
  return false;
}

// Detect Whisper repetition loops (e.g., "7-8-0. 7-8-0. 7-8-0.")
function isRepetitionLoop(text) {
  // Check for repeated short patterns
  const patterns = [
    /(\d-\d-\d\.?\s*){4,}/,  // "7-8-0. 7-8-0. 7-8-0. 7-8-0."
    /(\b\w{2,6}\b[.\s]+)\1{3,}/i,  // Any word repeated 4+ times
    /(.{3,10})\1{4,}/,  // Any 3-10 char pattern repeated 5+ times
  ];
  
  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  
  // Check if more than 50% of the text is the same short phrase
  const words = text.split(/\s+/);
  if (words.length > 6) {
    const wordCounts = {};
    words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
    const maxCount = Math.max(...Object.values(wordCounts));
    if (maxCount > words.length * 0.5) return true;
  }
  
  return false;
}

function forceNextFeed() {
  console.log(`[SCANNER] Force switching to next feed...`);
  if (currentStream) {
    try { currentStream.destroy(); } catch (e) {}
  }
  
  feedAttempts.set(currentFeedIndex, (feedAttempts.get(currentFeedIndex) || 0) + 1);
  
  let attempts = 0;
  do {
    currentFeedIndex = (currentFeedIndex + 1) % SCANNER_FEEDS.length;
    attempts++;
  } while (feedAttempts.get(currentFeedIndex) >= 3 && attempts < SCANNER_FEEDS.length);
  
  if (feedAttempts.size > 10) {
    feedAttempts.clear();
    console.log('[SCANNER] Reset feed attempt counters');
  }
  
  consecutivePSAs = 0;
  setTimeout(startBroadcastifyStream, 1000);
}

let scannerStats = { currentFeed: null, lastChunkTime: null, lastTranscript: null, totalChunks: 0, successfulTranscripts: 0 };

function broadcast(data) {
  const message = JSON.stringify(data);
  let sentCount = 0;
  clients.forEach(client => { 
    if (client.readyState === 1) {
      client.send(message);
      sentCount++;
    }
  });
  // Log broadcasts for transcripts and incidents
  if (data.type === 'transcript' || data.type === 'incident') {
    console.log(`[BROADCAST] ${data.type} sent to ${sentCount}/${clients.size} clients`);
  }
}

async function startBroadcastifyStream() {
  if (!BROADCASTIFY_PASSWORD) { 
    console.log('[SCANNER] BROADCASTIFY_PASSWORD not set - scanner disabled'); 
    scannerStats.currentFeed = 'DISABLED - No password';
    return; 
  }
  const feed = SCANNER_FEEDS[currentFeedIndex];
  console.log(`[SCANNER] Connecting to: ${feed.name} (${feed.area}) - feed ${feed.id}`);

  const options = {
    hostname: 'audio.broadcastify.com', port: 443, path: `/${feed.id}.mp3`, method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  };

  const req = https.request(options, (res) => {
    console.log(`[SCANNER] Response status: ${res.statusCode}`);
    if (res.statusCode !== 200) {
      console.log(`[SCANNER] Feed ${feed.name} returned ${res.statusCode}, trying next feed...`);
      currentFeedIndex = (currentFeedIndex + 1) % SCANNER_FEEDS.length;
      setTimeout(startBroadcastifyStream, 5000);
      return;
    }
    handleStream(res, feed);
  });
  req.on('error', (err) => { 
    console.error(`[SCANNER] Connection error: ${err.message}`);
    currentFeedIndex = (currentFeedIndex + 1) % SCANNER_FEEDS.length; 
    setTimeout(startBroadcastifyStream, 10000); 
  });
  req.end();
}

function handleStream(stream, feed) {
  console.log(`[SCANNER] ✅ Connected to ${feed.name}!`);
  currentStream = stream; // Track for forced reconnect
  scannerStats.currentFeed = feed.name;
  scannerStats.connectedAt = new Date().toISOString();
  consecutivePSAs = 0; // Reset on new connection
  let chunks = [];
  
  stream.on('data', (chunk) => {
    chunks.push(chunk);
    if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(chunks);
      chunks = [];
      lastProcessTime = Date.now();
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.totalChunks++;
      console.log(`[SCANNER] Processing chunk #${scannerStats.totalChunks} (${fullBuffer.length} bytes)`);
      processAudioFromStream(fullBuffer, feed.name);
    }
  });
  
  stream.on('end', () => { 
    console.log('[SCANNER] Stream ended, reconnecting...');
    setTimeout(startBroadcastifyStream, 2000); 
  });
  stream.on('error', (err) => { 
    console.error(`[SCANNER] Stream error: ${err.message}`);
    setTimeout(startBroadcastifyStream, 5000); 
  });
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

CRITICAL: If you cannot determine a specific location or borough from the transcript, you MUST return hasIncident: false. Do NOT guess or default to any borough.

LOCATION EXTRACTION RULES:
1. Look for street addresses: "123 West 45th Street" → location: "123 W 45th St"
2. Look for intersections: "42nd and Lexington", "at the corner of Broadway and 125th" → location: "42nd St & Lexington Ave"
3. Look for landmarks: "Times Square", "Penn Station", "Grand Central", "Port Authority" → use landmark name
4. Look for precinct references: "the 7-5", "75 precinct", "seven-five" → location: "75th Precinct area", borough: "Brooklyn"
5. Look for sector/Adam/Boy/Charlie designations with location context
6. Look for highways: "FDR at 96th", "BQE", "Cross Bronx" → use highway location
7. Look for project names, building names, park names

PRECINCT TO BOROUGH MAPPING (only use when precinct is clearly mentioned):
- 1-34: Manhattan
- 40-52: Bronx  
- 60-94: Brooklyn
- 100-115: Queens
- 120-123: Staten Island

When you hear "the 7-5" or "75" or "seven-five" in context of a precinct, that's the 75th Precinct in Brooklyn.
When you hear "the 4-4" or "44", that's the 44th Precinct in the Bronx.
When you hear "121" or "one-two-one", that's the 121st Precinct in Staten Island.

CRITICAL RULES:
- If the transcript is just routine chatter without a specific incident, return hasIncident: false
- If the transcript mentions no specific location, return hasIncident: false
- NEVER default borough to "Staten Island" or any other borough - only set it if you can determine it from the transcript
- If you can determine a precinct number but no specific address, use "Xth Precinct area" as location

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
- Shots fired, shooting, gun → Shots Fired
- EDP, emotionally disturbed → EDP
- Pursuit, chase, fleeing → Pursuit

Respond ONLY with valid JSON:
{
  "hasIncident": boolean (FALSE if no clear incident or location),
  "incidentType": "string describing incident",
  "location": "specific location or null if none found",
  "borough": "Manhattan/Brooklyn/Bronx/Queens/Staten Island or null if unknown",
  "units": ["unit IDs mentioned"],
  "priority": "CRITICAL/HIGH/MEDIUM/LOW",
  "summary": "brief summary",
  "rawCodes": ["any 10-codes heard"],
  "precinctMentioned": "number or null"
}`,
      messages: [{ role: "user", content: `Parse this NYPD radio transmission and extract any location information. If there's no clear incident or location, return hasIncident: false.\n\n"${transcript}"` }]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // If precinct mentioned but no borough, look it up
      if (parsed.precinctMentioned && (!parsed.borough || parsed.borough === 'Unknown' || parsed.borough === null)) {
        const boroughFromPrecinct = getPrecinctBorough(parsed.precinctMentioned);
        if (boroughFromPrecinct) {
          parsed.borough = boroughFromPrecinct;
          if (!parsed.location || parsed.location === 'Unknown' || parsed.location === null) {
            parsed.location = `${parsed.precinctMentioned}th Precinct area`;
          }
        }
      }
      
      // Convert null location to "Unknown" for backwards compatibility
      if (parsed.location === null) {
        parsed.location = 'Unknown';
      }
      
      // Convert null borough to "Unknown"
      if (parsed.borough === null) {
        parsed.borough = 'Unknown';
      }
      
      // Log when we have an incident without a borough for debugging
      if (parsed.borough === 'Unknown' && parsed.hasIncident) {
        console.log('[PARSE] Incident detected but no borough identified - keeping as incident');
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
  // Borough center coordinates as fallback
  const BOROUGH_CENTERS = {
    'Manhattan': { lat: 40.7831, lng: -73.9712 },
    'Brooklyn': { lat: 40.6782, lng: -73.9442 },
    'Bronx': { lat: 40.8448, lng: -73.8648 },
    'Queens': { lat: 40.7282, lng: -73.7949 },
    'Staten Island': { lat: 40.5795, lng: -74.1502 }
  };

  if (cameras.length === 0) {
    // Return a fake camera with borough center coordinates
    if (borough && BOROUGH_CENTERS[borough]) {
      return {
        id: `fallback_${borough}`,
        location: `${borough} (approximate)`,
        lat: BOROUGH_CENTERS[borough].lat,
        lng: BOROUGH_CENTERS[borough].lng,
        area: borough,
        isFallback: true
      };
    }
    return null;
  }
  
  let searchCameras = cameras;
  
  // First, try to match by borough
  if (borough && borough !== 'Unknown') {
    const boroughCameras = cameras.filter(cam => {
      const area = cam.area?.toLowerCase() || '';
      const boroughLower = borough.toLowerCase();
      // Handle variations like "SI" for Staten Island, "BK" for Brooklyn, etc.
      return area.includes(boroughLower) || 
             (boroughLower === 'staten island' && (area.includes('staten') || area.includes('richmond') || area === 'si')) ||
             (boroughLower === 'brooklyn' && (area.includes('brooklyn') || area.includes('kings') || area === 'bk')) ||
             (boroughLower === 'manhattan' && (area.includes('manhattan') || area.includes('new york') || area === 'mn')) ||
             (boroughLower === 'bronx' && (area.includes('bronx') || area === 'bx')) ||
             (boroughLower === 'queens' && (area.includes('queens') || area === 'qn'));
    });
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
  
  // Fallback to random camera in search set
  if (searchCameras.length > 0) {
    return searchCameras[Math.floor(Math.random() * searchCameras.length)];
  }
  
  // Ultimate fallback: borough center coordinates
  if (borough && BOROUGH_CENTERS[borough]) {
    return {
      id: `fallback_${borough}`,
      location: `${borough} (approximate)`,
      lat: BOROUGH_CENTERS[borough].lat,
      lng: BOROUGH_CENTERS[borough].lng,
      area: borough,
      isFallback: true
    };
  }
  
  return cameras[Math.floor(Math.random() * cameras.length)];
}

async function processAudioFromStream(buffer, feedName) {
  if (buffer.length < 5000) {
    console.log(`[SCANNER] Buffer too small: ${buffer.length} bytes`);
    return;
  }
  
  console.log(`[SCANNER] Transcribing ${buffer.length} bytes...`);
  const transcript = await transcribeAudio(buffer);
  if (!transcript || transcript.trim().length < 10) {
    console.log(`[SCANNER] No transcript or too short`);
    return;
  }
  
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  console.log(`[SCANNER] Got transcript: "${clean.substring(0, 50)}..."`);
  
  // Filter out noise - but don't be too aggressive
  const noise = ['thank you', 'thanks for watching', 'subscribe', 'bye', 'music'];
  if (noise.some(n => lower === n || lower === n + '.')) {
    console.log(`[SCANNER] Filtered: noise word`);
    return;
  }
  
  // Detect Whisper hallucinating/echoing the prompt (happens on silence)
  if (isPromptEcho(clean)) {
    console.log(`[SCANNER] Filtered: Whisper prompt echo (silence detected)`);
    consecutivePSAs++;
    if (consecutivePSAs >= 3) {
      console.log(`[SCANNER] Too much silence on ${SCANNER_FEEDS[currentFeedIndex].name}, forcing feed switch...`);
      forceNextFeed();
    }
    return;
  }
  
  // Detect Whisper repetition loops (garbled audio)
  if (isRepetitionLoop(clean)) {
    console.log(`[SCANNER] Filtered: Whisper repetition loop (garbled audio)`);
    consecutivePSAs++;
    if (consecutivePSAs >= 3) {
      console.log(`[SCANNER] Too much garbled audio on ${SCANNER_FEEDS[currentFeedIndex].name}, forcing feed switch...`);
      forceNextFeed();
    }
    return;
  }
  
  if (lower.includes('broadcastify') || lower.includes('fema.gov') || lower.includes('fema gov') || lower.includes('for more information')) {
    console.log(`[SCANNER] Filtered: PSA/ad content`);
    consecutivePSAs++;
    if (consecutivePSAs >= 3) {
      console.log(`[SCANNER] Too many PSAs on ${SCANNER_FEEDS[currentFeedIndex].name}, forcing feed switch...`);
      forceNextFeed();
    }
    return;
  }
  // Reset PSA counter when we get real content
  consecutivePSAs = 0;
  if (lower.includes('un videos') || lower.includes('for more un videos')) {
    console.log(`[SCANNER] Filtered: UN videos`);
    return;
  }
  // Only filter URLs if they're the main content, not mentioned in passing
  if (lower.startsWith('for more') && (lower.includes('.org') || lower.includes('.com'))) {
    console.log(`[SCANNER] Filtered: URL spam`);
    return;
  }
  if (clean.length < 15 && (lower.includes('www.') || lower.includes('.org'))) {
    console.log(`[SCANNER] Filtered: short URL`);
    return;
  }
  
  console.log(`[SCANNER] ✅ Transcript passed filters, broadcasting...`);
  scannerStats.lastTranscript = clean.substring(0, 200);
  scannerStats.successfulTranscripts++;
  
  const transcriptEntry = { text: clean, source: feedName, timestamp: new Date().toISOString() };
  recentTranscripts.unshift(transcriptEntry);
  if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
  saveTranscripts(recentTranscripts); // Persist transcripts
  
  broadcast({ type: "transcript", ...transcriptEntry });
  
  const parsed = await parseTranscript(clean);
  console.log(`[PARSER] Result: hasIncident=${parsed.hasIncident}, type=${parsed.incidentType || 'none'}, location=${parsed.location || 'none'}, borough=${parsed.borough || 'none'}`);
  
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
    if (incidents.length > 100) incidents.pop();
    
    // Persist incidents to disk
    saveIncidents(incidents);
    
    // Process through Detective Bureau
    detectiveBureau.processIncident(incident, broadcast);
    
    // Save detective state after processing (patterns, predictions may have changed)
    saveDetectiveState(detectiveBureau);
    
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
  const windowMinutes = parseInt(window);
  const boroughs = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  const types = ['any', 'assault', 'robbery', 'theft', 'pursuit', 'shots fired'];
  const odds = {};
  
  boroughs.forEach(b => { 
    odds[b] = {}; 
    types.forEach(t => { 
      odds[b][t] = oddsEngine.getOdds(b, t, windowMinutes); 
    }); 
  });
  
  // Calculate some summary stats
  const allOdds = Object.values(odds).flatMap(b => Object.values(b));
  const avgMultiplier = allOdds.reduce((s, o) => s + o.multiplier, 0) / allOdds.length;
  
  res.json({ 
    timestamp: new Date().toISOString(), 
    windowMinutes,
    houseEdge: `${HOUSE_EDGE * 100}%`,
    currentHour: new Date().getHours(),
    summary: {
      avgMultiplier: Math.round(avgMultiplier * 10) / 10,
      lowestOdds: Math.min(...allOdds.map(o => o.multiplier)),
      highestOdds: Math.max(...allOdds.map(o => o.multiplier))
    },
    odds, 
    treasury: { 
      totalReceivedSOL: treasury.totalReceived / 1e9, 
      totalPaidOutSOL: treasury.totalPaidOut / 1e9, 
      netProfitSOL: treasury.netProfit / 1e9 
    } 
  });
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
app.get('/', (req, res) => res.json({ name: "DISPATCH NYC", status: "operational", connections: clients.size, incidents: incidents.length, facilities: NYC_CORRECTIONAL_FACILITIES.length, agents: detectiveBureau.getAgentStatuses(), predictionAccuracy: detectiveBureau.getAccuracy() }));
app.get('/cameras', (req, res) => res.json(cameras));
app.get('/incidents', (req, res) => res.json(incidents));

// Correctional Facilities endpoints
// Facility Intelligence Endpoints
app.get('/facilities', (req, res) => res.json({
  facilities: NYC_CORRECTIONAL_FACILITIES,
  population: facilityPopulation,
  intelligence: getFacilityStatus(),
  timestamp: new Date().toISOString()
}));

app.get('/facilities/list', (req, res) => res.json(NYC_CORRECTIONAL_FACILITIES));
app.get('/facilities/population', (req, res) => res.json(facilityPopulation));

// Full intelligence dashboard
app.get('/facilities/intelligence', (req, res) => {
  res.json(getFacilityStatus());
});

// Population history and trends
app.get('/facilities/population/history', (req, res) => {
  res.json({
    current: facilityIntelligence.population.current,
    trend: facilityIntelligence.population.trend,
    change: facilityIntelligence.population.change,
    history: facilityIntelligence.population.history,
    lastFetch: facilityIntelligence.population.lastFetch
  });
});

// Discharge statistics
app.get('/facilities/discharges', (req, res) => {
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  res.json({
    estimatedToday: facilityIntelligence.discharges.today,
    dayAverage: facilityIntelligence.discharges.byDayOfWeek[dayOfWeek],
    currentDay: dayOfWeek,
    weekdayPattern: facilityIntelligence.discharges.byDayOfWeek,
    historicalAverage: facilityIntelligence.discharges.average,
    releaseWindowActive: isDuringReleaseHours(),
    peakReleaseTime: '6:00 AM - 8:00 AM',
    note: 'Fridays typically have highest releases (~145 avg)'
  });
});

// Q100 Bus schedule (Rikers Island)
app.get('/facilities/q100', (req, res) => {
  const nextBuses = getNextQ100Buses(10);
  res.json({
    route: 'Q100 - Rikers Island to Queens Plaza',
    description: 'Only public transit route to/from Rikers Island',
    nextBuses,
    stops: Q100_SCHEDULE.stops,
    schedule: {
      weekday: Q100_SCHEDULE.weekday,
      weekend: Q100_SCHEDULE.weekend
    },
    isPeakTime: nextBuses[0]?.isPeak,
    currentFrequency: nextBuses[0]?.isPeak ? 'Every 10-15 min' : 'Every 20-30 min',
    lastFetch: facilityIntelligence.q100.lastFetch
  });
});

// 311 Complaints near facilities
app.get('/facilities/311', (req, res) => {
  res.json({
    total24h: facilityIntelligence.complaints311.total24h,
    nearRikers: {
      count: facilityIntelligence.complaints311.nearRikers.length,
      complaints: facilityIntelligence.complaints311.nearRikers
    },
    nearTombs: {
      count: facilityIntelligence.complaints311.nearTombs.length,
      complaints: facilityIntelligence.complaints311.nearTombs
    },
    nearBrooklyn: {
      count: facilityIntelligence.complaints311.nearBrooklyn.length,
      complaints: facilityIntelligence.complaints311.nearBrooklyn
    },
    topComplaintTypes: getTop311Types(),
    lastFetch: facilityIntelligence.complaints311.lastFetch
  });
});

// NYPD Arrest data
app.get('/facilities/arrests', (req, res) => {
  res.json({
    total7d: facilityIntelligence.arrests.total7d,
    byPrecinct: facilityIntelligence.arrests.byPrecinct,
    topPrecincts: getTopPrecincts(),
    recentArrests: facilityIntelligence.arrests.recentArrests,
    trend: facilityIntelligence.arrests.trend,
    note: 'Arrests typically process into DOC facilities within 24-48 hours',
    lastFetch: facilityIntelligence.arrests.lastFetch
  });
});

// Nearby facility check (must be before :id route)
app.get('/facilities/nearby/:lat/:lng', (req, res) => {
  const lat = parseFloat(req.params.lat);
  const lng = parseFloat(req.params.lng);
  const radius = parseFloat(req.query.radius) || 2;
  const nearby = getNearbyFacility(lat, lng, radius);
  
  let context = null;
  if (nearby) {
    context = {
      facility: nearby,
      duringReleaseHours: isDuringReleaseHours(),
      estimatedDischarges: facilityIntelligence.discharges.today,
      q100NextBus: nearby.id === 'rikers_island' ? getNextQ100Buses(1)[0] : null
    };
  }
  
  res.json({ 
    nearby,
    context,
    duringReleaseHours: isDuringReleaseHours(),
    currentHour: new Date().getHours()
  });
});

// Manual refresh all facility data
app.post('/facilities/refresh', async (req, res) => {
  console.log('[FACILITIES] Manual refresh requested');
  await fetchFacilityPopulation();
  syncFacilityPopulation();
  await fetch311NearFacilities();
  await fetchArrestData();
  facilityIntelligence.q100.schedule = getNextQ100Buses(10);
  res.json({ 
    success: true, 
    intelligence: getFacilityStatus()
  });
});

// Specific facility by ID (MUST BE LAST - catches all /facilities/:anything)
app.get('/facilities/:id', (req, res) => {
  const facility = NYC_CORRECTIONAL_FACILITIES.find(f => f.id === req.params.id);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  
  // Add specific data for Rikers
  let additionalData = {};
  if (facility.id === 'rikers_island') {
    additionalData = {
      q100: {
        nextBuses: getNextQ100Buses(5),
        note: 'Q100 is the only way off the island'
      },
      complaints311: facilityIntelligence.complaints311.nearRikers.slice(0, 5)
    };
  } else if (facility.id === 'manhattan_detention') {
    additionalData = {
      complaints311: facilityIntelligence.complaints311.nearTombs.slice(0, 5)
    };
  } else if (facility.id === 'brooklyn_detention') {
    additionalData = {
      complaints311: facilityIntelligence.complaints311.nearBrooklyn.slice(0, 5)
    };
  }
  
  res.json({ 
    facility, 
    population: facilityPopulation,
    releaseWindowActive: isDuringReleaseHours(),
    ...additionalData
  });
});
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/audio/:id', (req, res) => { const buffer = audioClips.get(req.params.id); if (!buffer) return res.status(404).json({ error: 'Not found' }); res.set('Content-Type', 'audio/mpeg'); res.send(buffer); });
app.get('/camera-image/:id', async (req, res) => { try { const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`); const buffer = await response.arrayBuffer(); res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(buffer)); } catch (e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/stream/feeds', (req, res) => res.json({ 
  feeds: SCANNER_FEEDS.map(f => ({ name: f.name, area: f.area, id: f.id })), 
  currentFeed: SCANNER_FEEDS[currentFeedIndex], 
  currentFeedIndex,
  streamUrl: '/stream/live' 
}));
app.get('/debug', (req, res) => res.json({ 
  scanner: {
    ...scannerStats,
    passwordSet: !!BROADCASTIFY_PASSWORD,
    chunkDuration: CHUNK_DURATION,
    consecutivePSAs,
    currentFeedIndex,
    currentFeed: SCANNER_FEEDS[currentFeedIndex],
    totalFeeds: SCANNER_FEEDS.length,
    feedAttempts: Object.fromEntries(feedAttempts)
  }, 
  connections: clients.size, 
  incidents: incidents.length,
  transcripts: recentTranscripts.length,
  cameras: cameras.length, 
  agents: detectiveBureau.getAgentStatuses(), 
  predictions: detectiveBureau.getPredictionStats() 
}));

// Test endpoint to verify WebSocket broadcast is working
app.post('/test/broadcast', (req, res) => {
  const testTranscript = {
    type: "transcript",
    text: `[TEST] Scanner test at ${new Date().toLocaleTimeString()} - this is a test broadcast`,
    source: "Test",
    timestamp: new Date().toISOString()
  };
  broadcast(testTranscript);
  console.log(`[TEST] Broadcast sent to ${clients.size} clients`);
  res.json({ success: true, clientCount: clients.size, message: testTranscript });
});

// Test endpoint to simulate an incident
app.post('/test/incident', async (req, res) => {
  const testIncident = {
    id: ++incidentId,
    hasIncident: true,
    incidentType: "Test Incident",
    location: "Times Square",
    borough: "Manhattan",
    priority: "HIGH",
    summary: "This is a test incident for debugging",
    lat: 40.758,
    lng: -73.9855,
    timestamp: new Date().toISOString()
  };
  
  incidents.unshift(testIncident);
  saveIncidents(incidents);
  broadcast({ type: "incident", incident: testIncident });
  
  console.log(`[TEST] Incident broadcast sent to ${clients.size} clients`);
  res.json({ success: true, clientCount: clients.size, incident: testIncident });
});

// Manually switch to next feed
app.post('/test/next-feed', (req, res) => {
  const oldFeed = SCANNER_FEEDS[currentFeedIndex].name;
  forceNextFeed();
  const newFeed = SCANNER_FEEDS[currentFeedIndex].name;
  console.log(`[TEST] Manually switched from ${oldFeed} to ${newFeed}`);
  res.json({ 
    success: true, 
    previousFeed: oldFeed, 
    currentFeed: newFeed,
    currentFeedIndex,
    availableFeeds: SCANNER_FEEDS.map(f => ({ name: f.name, area: f.area }))
  });
});

// WebSocket
wss.on('connection', (ws) => {
  clients.add(ws);
  
  // Send comprehensive init data so new users see activity
  // Build agent feed from all agent insights
  const agentFeed = [];
  for (const agent of Object.values(detectiveBureau.agents)) {
    for (const insight of agent.recentInsights) {
      agentFeed.push({
        agent: agent.name,
        agentIcon: agent.icon,
        text: insight.text,
        timestamp: insight.timestamp,
        incidentId: insight.incidentId
      });
    }
  }
  agentFeed.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  const initData = {
    type: "init",
    incidents: incidents.slice(0, 30), // More incidents for new users
    cameras,
    transcripts: recentTranscripts.slice(0, 30), // More transcripts
    facilities: {
      list: NYC_CORRECTIONAL_FACILITIES,
      population: facilityPopulation,
      duringReleaseHours: isDuringReleaseHours()
    },
    currentFeed: SCANNER_FEEDS[currentFeedIndex]?.name,
    agents: detectiveBureau.getAgentStatuses(),
    agentFeed: agentFeed.slice(0, 20), // Recent agent activity for Feed tab
    predictions: detectiveBureau.getPredictionStats(),
    patterns: detectiveBureau.memory.patterns.filter(p => p.status === 'active').slice(0, 10),
    hotspots: Array.from(detectiveBureau.memory.hotspots.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([key, count]) => {
        const [borough, location] = key.split('-');
        return { borough, location, count };
      }),
    stats: {
      totalIncidents: incidents.length,
      totalFacilities: NYC_CORRECTIONAL_FACILITIES.length,
      jailPopulation: facilityPopulation.totalPopulation || 0,
      activePatterns: detectiveBureau.memory.patterns.filter(p => p.status === 'active').length,
      predictionAccuracy: detectiveBureau.getAccuracy(),
      uptime: process.uptime()
    }
  };
  
  ws.send(JSON.stringify(initData));
  console.log(`[WS] New client connected. Sent ${initData.incidents.length} incidents, ${initData.transcripts.length} transcripts, ${NYC_CORRECTIONAL_FACILITIES.length} facilities`);
  
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
          if (incidents.length > 100) incidents.pop();
          saveIncidents(incidents);
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
╔════════════════════════════════════════════════════════╗
║  🚨 DISPATCH NYC - Police Scanner Intelligence         ║
║  Port: ${PORT}                                            ║
║  Agents: CHASE | PATTERN | PROPHET | HISTORIAN         ║
║  Chunk Duration: ${CHUNK_DURATION/1000}s (improved for full transmissions)  ║
║  Loaded Incidents: ${incidents.length} (persisted ${MAX_INCIDENT_AGE_HOURS}h)              ║
╚════════════════════════════════════════════════════════╝
  `);
});
