// ============================================
// DISPATCH WEB - API & WebSocket Server
// ============================================
// Handles: Express API, WebSocket connections, Detective Bureau agents,
// Betting system, ICE tracking, subscribes to Redis for real-time data

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

import { 
  CITIES, NYPD_FEEDS, MPLS_FEEDS, ALL_FEEDS,
  REDIS_CHANNELS, 
  HOUSE_EDGE, SIGNUP_BONUS, DAILY_LOGIN_BONUS, MIN_PREDICTION, MAX_PREDICTION,
  RANKS, STREAK_BONUSES
} from './shared/constants.js';

import { 
  initPool, getPool, initDatabase,
  getRecentIncidents, getRecentArrests, getAddressHistory, getFlaggedAddresses
} from './shared/database.js';

import {
  initRedis, subscribe, getWorkerStats, getCityState,
  publishActivity, publishBetWon, publishNewBet
} from './shared/redis.js';

dotenv.config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// CLIENT MANAGEMENT
// ============================================

const clients = new Set();
const cityClients = {};
Object.keys(CITIES).forEach(cityId => {
  cityClients[cityId] = new Set();
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => { 
    if (client.readyState === 1) client.send(message); 
  });
}

function broadcastToCity(cityId, data) {
  const message = JSON.stringify(data);
  const citySet = cityClients[cityId];
  if (citySet) {
    citySet.forEach(client => {
      if (client.readyState === 1) client.send(message);
    });
  }
}

// ============================================
// LOCAL STATE (synced from Redis/worker)
// ============================================

const localState = {};
Object.keys(CITIES).forEach(cityId => {
  localState[cityId] = {
    cameras: [],
    incidents: [],
    recentTranscripts: [],
    incidentId: 0
  };
});

// ============================================
// DETECTIVE BUREAU
// ============================================

class DetectiveBureau {
  constructor(anthropicClient, cityId = 'nyc') {
    this.anthropic = anthropicClient;
    this.cityId = cityId;
    
    const cityKnowledge = {
      nyc: {
        streets: 'NYC street topology - one-ways, dead ends, bridge/tunnel access',
        landmarks: 'Times Square, Penn Station, Grand Central, Port Authority, Central Park',
        precincts: 'NYPD precincts 1-123'
      },
      mpls: {
        streets: 'Minneapolis street grid - Lake Street, Hennepin Ave, I-35W, I-94',
        landmarks: 'Target Center, US Bank Stadium, Mall of America, Nicollet Mall',
        precincts: 'Minneapolis Police precincts 1-5, Hennepin County Sheriff'
      }
    };
    
    const cityInfo = cityKnowledge[cityId] || cityKnowledge.nyc;
    
    this.agents = {
      CHASE: {
        id: 'CHASE', name: 'CHASE', icon: '🚔', role: 'Pursuit Specialist', status: 'idle',
        triggers: ['pursuit', 'fled', 'fleeing', 'chase', 'vehicle pursuit', 'on foot', 'running', 'high speed', 'foot pursuit', '10-13'],
        systemPrompt: `You are CHASE, a pursuit specialist AI for ${cityId.toUpperCase()}. You predict escape routes, containment points, and track active pursuits. You know ${cityInfo.streets}. Keep responses to 2-3 sentences. Be tactical and specific.`,
        stats: { activations: 0, insights: 0, successfulContainments: 0 },
        history: []
      },
      PATTERN: {
        id: 'PATTERN', name: 'PATTERN', icon: '🔗', role: 'Serial Crime Analyst', status: 'idle',
        triggers: [],
        systemPrompt: `You are PATTERN, a serial crime analyst AI. You find connections between incidents - matching MOs, geographic clusters, temporal patterns, suspect descriptions. Keep responses to 2-3 sentences.`,
        stats: { activations: 0, patternsFound: 0, linkedIncidents: 0 },
        history: []
      },
      PROPHET: {
        id: 'PROPHET', name: 'PROPHET', icon: '🔮', role: 'Predictive Analyst', status: 'idle',
        triggers: [],
        systemPrompt: `You are PROPHET, a predictive analyst AI. You make specific, testable predictions about where and when incidents will occur. Always include location, time window, incident type, and confidence percentage.`,
        stats: { activations: 0, totalPredictions: 0, hits: 0, misses: 0 },
        history: []
      },
      HISTORIAN: {
        id: 'HISTORIAN', name: 'HISTORIAN', icon: '📚', role: 'Historical Context', status: 'idle',
        triggers: [],
        systemPrompt: `You are HISTORIAN, the memory of the Detective Bureau. You remember every incident, address, suspect description. Surface relevant history - "this address had 4 calls this week". Keep responses to 2-3 sentences.`,
        stats: { activations: 0, contextsProvided: 0, repeatAddresses: 0 },
        history: []
      }
    };

    this.memory = {
      incidents: [],
      patterns: [],
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

  async processIncident(incident) {
    const insights = [];
    
    this.memory.incidents.unshift(incident);
    if (this.memory.incidents.length > 200) this.memory.incidents.pop();
    
    const addressKey = incident.location?.toLowerCase() || 'unknown';
    const addressCount = (this.memory.addressHistory.get(addressKey) || 0) + 1;
    this.memory.addressHistory.set(addressKey, addressCount);
    
    const hotspotKey = `${incident.borough}-${incident.location}`;
    this.memory.hotspots.set(hotspotKey, (this.memory.hotspots.get(hotspotKey) || 0) + 1);
    
    this.checkPredictionHit(incident);

    // CHASE
    if (this.shouldActivateChase(incident)) {
      this.agents.CHASE.status = 'active';
      const chaseInsight = await this.runChase(incident);
      if (chaseInsight) {
        insights.push(chaseInsight);
        broadcastToCity(this.cityId, {
          type: 'agent_insight', agent: 'CHASE', agentIcon: '🚔',
          incidentId: incident.id, analysis: chaseInsight, urgency: 'critical',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.CHASE.status = 'idle';
    }

    // HISTORIAN
    if (incident.location && incident.location !== 'Unknown') {
      this.agents.HISTORIAN.status = 'analyzing';
      const historianInsight = await this.runHistorian(incident, addressCount);
      if (historianInsight) {
        insights.push(historianInsight);
        broadcastToCity(this.cityId, {
          type: 'agent_insight', agent: 'HISTORIAN', agentIcon: '📚',
          incidentId: incident.id, analysis: historianInsight,
          urgency: addressCount > 3 ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.HISTORIAN.status = 'idle';
    }

    // PATTERN
    if (this.memory.incidents.length >= 3) {
      this.agents.PATTERN.status = 'analyzing';
      const patternInsight = await this.runPattern(incident);
      if (patternInsight) {
        insights.push(patternInsight);
        broadcastToCity(this.cityId, {
          type: 'agent_insight', agent: 'PATTERN', agentIcon: '🔗',
          incidentId: incident.id, analysis: patternInsight.analysis,
          urgency: patternInsight.confidence === 'HIGH' ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
        
        if (patternInsight.isPattern) {
          broadcastToCity(this.cityId, {
            type: 'pattern_detected', agent: 'PATTERN', pattern: patternInsight,
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
          content: `ACTIVE PURSUIT:\nType: ${incident.incidentType}\nLocation: ${incident.location}\nBorough: ${incident.borough}\nDetails: ${incident.summary}\n\nPredict escape routes and recommend containment.`
        }]
      });
      this.agents.CHASE.stats.activations++;
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
          content: `NEW INCIDENT:\n${JSON.stringify(incident)}\n\nThis address has had ${addressCount} calls recently.\n\nRelated incidents:\n${JSON.stringify(relatedIncidents)}\n\nWhat historical context is relevant?`
        }]
      });
      this.agents.HISTORIAN.stats.activations++;
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
        return timeDiff < 2 * 60 * 60 * 1000;
      }).slice(0, 10);

      if (recentSimilar.length < 2) return null;

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: this.agents.PATTERN.systemPrompt + `\n\nRespond in JSON: { "isPattern": true/false, "patternName": "string", "analysis": "string", "linkedIncidentIds": [numbers], "confidence": "HIGH/MEDIUM/LOW" }`,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:\n${JSON.stringify(incident)}\n\nRECENT INCIDENTS (last 2 hours):\n${JSON.stringify(recentSimilar)}\n\nAre these connected?`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        if (result.isPattern) {
          this.memory.patterns.unshift({ ...result, detectedAt: new Date().toISOString(), status: 'active' });
          if (this.memory.patterns.length > 50) this.memory.patterns.pop();
          this.agents.PATTERN.stats.patternsFound++;
        }
        this.agents.PATTERN.stats.activations++;
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
        .sort((a, b) => b[1] - a[1]).slice(0, 10);

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: this.agents.PROPHET.systemPrompt + `\n\nRespond in JSON: { "predictions": [{ "location": "specific location", "borough": "string", "incidentType": "string", "timeWindowMinutes": number, "confidence": 0.0-1.0, "reasoning": "string" }] }`,
        messages: [{
          role: "user",
          content: `Current time: ${new Date().toISOString()}\nHour: ${new Date().getHours()}\n\nRECENT INCIDENTS:\n${JSON.stringify(recentIncidents)}\n\nHOTSPOTS:\n${JSON.stringify(hotspots)}\n\nPredict incidents in next 30-60 minutes.`
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
          this.agents.PROPHET.stats.totalPredictions++;
          
          broadcastToCity(this.cityId, {
            type: 'prophet_prediction', agent: 'PROPHET', agentIcon: '🔮',
            prediction, timestamp: new Date().toISOString()
          });
          
          console.log(`[PROPHET-${this.cityId.toUpperCase()}] Prediction: ${pred.incidentType} at ${pred.location} (${(pred.confidence * 100).toFixed(0)}%)`);
        }
      }
    } catch (error) {
      console.error(`[PROPHET-${this.cityId.toUpperCase()}] Error:`, error.message);
    }
    
    this.agents.PROPHET.status = 'idle';
  }

  checkPredictionHit(incident) {
    const now = new Date();
    
    this.predictionStats.pending = this.predictionStats.pending.filter(pred => {
      const expiresAt = new Date(pred.expiresAt);
      
      if (now > expiresAt) {
        pred.status = 'expired';
        this.agents.PROPHET.stats.misses++;
        return false;
      }
      
      const boroughMatch = incident.borough?.toLowerCase() === pred.borough?.toLowerCase();
      const typeMatch = incident.incidentType?.toLowerCase().includes(pred.incidentType?.toLowerCase()) ||
                       pred.incidentType?.toLowerCase().includes(incident.incidentType?.toLowerCase());
      
      if (boroughMatch && typeMatch) {
        pred.status = 'hit';
        pred.matchedIncidentId = incident.id;
        this.predictionStats.correct++;
        this.agents.PROPHET.stats.hits++;
        
        broadcastToCity(this.cityId, {
          type: 'prediction_hit', agent: 'PROPHET', agentIcon: '🔮',
          prediction: pred, matchedIncident: incident,
          accuracy: this.getAccuracy(), timestamp: new Date().toISOString()
        });
        
        console.log(`[PROPHET-${this.cityId.toUpperCase()}] PREDICTION HIT! ${pred.incidentType} at ${pred.location}`);
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
        await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: this.agents.PATTERN.systemPrompt,
          messages: [{ role: "user", content: `Analyze the last 50 incidents for patterns:\n${JSON.stringify(this.memory.incidents.slice(0, 50))}` }]
        });
        console.log(`[PATTERN-${this.cityId.toUpperCase()}] Background analysis complete`);
      } catch (error) {
        console.error(`[PATTERN-${this.cityId.toUpperCase()}] Background error:`, error.message);
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
      id: agent.id, name: agent.name, icon: agent.icon,
      role: agent.role, status: agent.status
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

  async askAgents(question) {
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
          agent: agent.name, agentIcon: agent.icon,
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
          content: `Generate briefing:\nStats: ${JSON.stringify(stats)}\nRecent incidents: ${JSON.stringify(this.memory.incidents.slice(0, 15))}\nActive patterns: ${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'))}`
        }]
      });

      return {
        briefing: response.content[0].text, stats,
        agents: this.getAgentStatuses(), timestamp: new Date().toISOString()
      };
    } catch (error) {
      return { error: error.message, stats, agents: this.getAgentStatuses() };
    }
  }
}

// Create Detective Bureaus for each city
const detectiveBureaus = {};
Object.keys(CITIES).forEach(cityId => {
  detectiveBureaus[cityId] = new DetectiveBureau(anthropic, cityId);
});

// Legacy reference
const detectiveBureau = detectiveBureaus.nyc;

// ============================================
// PREDICTION/BETTING SYSTEM
// ============================================

const users = new Map();
const activePredictions = new Map();
const predictionHistory = [];
const activityFeed = [];

function getUserRank(pts) {
  let currentRank = RANKS[0];
  let nextRank = RANKS[1];
  
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (pts >= RANKS[i].minPts) {
      currentRank = RANKS[i];
      nextRank = RANKS[i + 1] || null;
      break;
    }
  }
  
  const progress = nextRank 
    ? ((pts - currentRank.minPts) / (nextRank.minPts - currentRank.minPts)) * 100
    : 100;
  
  return {
    ...currentRank, currentPts: pts,
    nextRank: nextRank ? { rank: nextRank.rank, minPts: nextRank.minPts, ptsNeeded: nextRank.minPts - pts } : null,
    progress: Math.min(100, Math.round(progress))
  };
}

function createUser(username) {
  const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const user = {
    id: userId,
    username: username.toLowerCase().trim(),
    displayName: username.trim(),
    pts: SIGNUP_BONUS,
    totalPredictions: 0, wins: 0, losses: 0,
    totalWinnings: 0, totalLosses: 0,
    currentWinStreak: 0, bestWinStreak: 0,
    loginStreak: 1, bestLoginStreak: 1,
    lastLoginDate: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString()
  };
  users.set(user.username, user);
  
  addToActivityFeed({ type: 'user_joined', user: user.displayName });
  return user;
}

function addToActivityFeed(activity) {
  const item = {
    id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    ...activity, timestamp: new Date().toISOString()
  };
  
  activityFeed.unshift(item);
  if (activityFeed.length > 100) activityFeed.pop();
  
  broadcast({ type: 'activity_feed', activity: item });
  publishActivity(activity);
  return item;
}

const oddsEngine = {
  districtRates: {
    nyc: { 'Manhattan': 2.5, 'Brooklyn': 2.0, 'Bronx': 1.8, 'Queens': 1.2, 'Staten Island': 0.3 },
    mpls: { 'Downtown': 1.8, 'North': 1.5, 'Northeast': 1.0, 'South': 1.2, 'Southwest': 0.7 }
  },
  incidentTypeRarity: { 'any': 1.0, 'traffic': 0.20, 'assault': 0.08, 'robbery': 0.03, 'shots fired': 0.01 },
  timeMultipliers: { 0: 0.6, 6: 0.6, 12: 1.2, 18: 1.4, 21: 1.5, 23: 0.9 },
  
  calculateProbability(district, incidentType = 'any', windowMinutes = 30, cityId = 'nyc') {
    const hour = new Date().getHours();
    const cityRates = this.districtRates[cityId] || this.districtRates.nyc;
    const baseRate = cityRates[district] || 1.0;
    const timeMultiplier = this.timeMultipliers[hour] || 1.0;
    const typeMultiplier = this.incidentTypeRarity[incidentType.toLowerCase()] || 0.05;
    const lambda = (baseRate * timeMultiplier * typeMultiplier / 60) * windowMinutes;
    return Math.max(0.02, Math.min(0.85, 1 - Math.exp(-lambda)));
  },
  
  calculateMultiplier(probability) {
    const fairOdds = 1 / probability;
    return Math.max(1.1, Math.min(45.0, Math.round(fairOdds * (1 - HOUSE_EDGE) * 10) / 10));
  },
  
  getOdds(district, incidentType = 'any', windowMinutes = 30, cityId = 'nyc') {
    const prob = this.calculateProbability(district, incidentType, windowMinutes, cityId);
    return { district, incidentType, windowMinutes, probability: Math.round(prob * 100), multiplier: this.calculateMultiplier(prob) };
  }
};

function checkPredictionsForIncident(incident) {
  const incidentCity = incident.city || 'nyc';
  
  activePredictions.forEach((pred, predId) => {
    if (pred.status !== 'ACTIVE') return;
    
    if (Date.now() > new Date(pred.expiresAt).getTime()) {
      pred.status = 'LOST';
      const user = users.get(pred.username);
      if (user) { user.losses++; user.currentWinStreak = 0; }
      predictionHistory.unshift(pred);
      activePredictions.delete(predId);
      return;
    }
    
    if ((pred.city || 'nyc') !== incidentCity) return;
    
    const districtMatch = (pred.district || '').toLowerCase() === (incident.borough || '').toLowerCase();
    const typeMatch = pred.incidentType === 'any' || incident.incidentType?.toLowerCase().includes(pred.incidentType.toLowerCase());
    
    if (districtMatch && typeMatch) {
      pred.status = 'WON';
      const user = users.get(pred.username);
      
      let winnings = Math.floor(pred.amount * pred.multiplier);
      
      if (user) {
        user.currentWinStreak++;
        if (user.currentWinStreak > user.bestWinStreak) user.bestWinStreak = user.currentWinStreak;
        user.pts += winnings;
        user.wins++;
        user.totalWinnings += winnings;
      }
      
      pred.winnings = winnings;
      predictionHistory.unshift(pred);
      activePredictions.delete(predId);
      
      publishBetWon(pred, incident);
      addToActivityFeed({ type: 'prediction_won', user: pred.displayName, district: pred.district, winnings });
    }
  });
}

// ============================================
// REDIS SUBSCRIPTIONS
// ============================================

async function setupRedisSubscriptions() {
  // Subscribe to incidents
  await subscribe(REDIS_CHANNELS.INCIDENTS, (data) => {
    const { incident, city } = data;
    
    // Update local state
    if (localState[city]) {
      localState[city].incidents.unshift(incident);
      if (localState[city].incidents.length > 50) localState[city].incidents.pop();
    }
    
    // Process through Detective Bureau
    detectiveBureaus[city]?.processIncident(incident);
    
    // Check predictions
    checkPredictionsForIncident(incident);
    
    // Broadcast to city clients
    broadcastToCity(city, { type: 'incident', incident });
  });
  
  // Subscribe to transcripts
  await subscribe(REDIS_CHANNELS.TRANSCRIPTS, (data) => {
    const { city, ...transcript } = data;
    
    if (localState[city]) {
      localState[city].recentTranscripts.unshift(transcript);
      if (localState[city].recentTranscripts.length > 20) localState[city].recentTranscripts.pop();
    }
    
    broadcastToCity(city, { type: 'transcript', ...transcript });
  });
  
  // Subscribe to camera switches
  await subscribe(REDIS_CHANNELS.CAMERAS, (data) => {
    const { city, ...cameraData } = data;
    broadcastToCity(city, cameraData);
  });
  
  // Subscribe to ICE alerts
  await subscribe(REDIS_CHANNELS.ICE_ALERTS, (data) => {
    const { city, ...alertData } = data;
    broadcastToCity(city, alertData);
  });
  
  console.log('[REDIS] Subscriptions established');
}

// ============================================
// API ROUTES
// ============================================

// Detective Bureau endpoints
app.get('/detective/agents', (req, res) => {
  const city = req.query.city || 'nyc';
  res.json(detectiveBureaus[city]?.getAgentStatuses() || []);
});

app.get('/detective/predictions', (req, res) => {
  const city = req.query.city || 'nyc';
  res.json(detectiveBureaus[city]?.getPredictionStats() || {});
});

app.get('/detective/patterns', (req, res) => {
  const city = req.query.city || 'nyc';
  const bureau = detectiveBureaus[city];
  res.json({ 
    active: bureau?.memory.patterns.filter(p => p.status === 'active') || [], 
    total: bureau?.memory.patterns.length || 0 
  });
});

app.get('/detective/hotspots', (req, res) => {
  const city = req.query.city || 'nyc';
  const bureau = detectiveBureaus[city];
  const hotspots = Array.from(bureau?.memory.hotspots.entries() || [])
    .map(([key, count]) => {
      const [borough, location] = key.split('-');
      return { borough, location, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  res.json(hotspots);
});

app.get('/detective/briefing', async (req, res) => {
  const city = req.query.city || 'nyc';
  const briefing = await detectiveBureaus[city]?.generateBriefing();
  res.json(briefing || { error: 'City not found' });
});

app.post('/detective/ask', async (req, res) => {
  const { question, city = 'nyc' } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  const response = await detectiveBureaus[city]?.askAgents(question);
  res.json(response || { error: 'City not found' });
});

// Prediction endpoints
app.get('/predict/odds', (req, res) => {
  const { city = 'nyc', type = 'any', window = 30 } = req.query;
  const districts = Object.keys(oddsEngine.districtRates[city] || oddsEngine.districtRates.nyc);
  res.json(districts.map(d => oddsEngine.getOdds(d, type, parseInt(window), city)));
});

app.post('/predict/place', (req, res) => {
  const { username, district, incidentType = 'any', amount, timeWindow = 30, city = 'nyc' } = req.body;
  if (!username || !district || !amount) return res.status(400).json({ error: 'Missing fields' });
  
  const pts = parseInt(amount);
  if (pts < MIN_PREDICTION || pts > MAX_PREDICTION) {
    return res.status(400).json({ error: `Prediction must be ${MIN_PREDICTION}-${MAX_PREDICTION} PTS` });
  }
  
  let user = users.get(username.toLowerCase().trim());
  if (!user) user = createUser(username);
  
  if (user.pts < pts) return res.status(400).json({ error: 'Insufficient PTS', balance: user.pts });
  
  const odds = oddsEngine.getOdds(district, incidentType, timeWindow, city);
  
  const predId = `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const prediction = {
    id: predId, username: user.username, displayName: user.displayName,
    district, incidentType, amount: pts, timeWindow, city,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeWindow * 60 * 1000).toISOString(),
    status: 'ACTIVE', multiplier: odds.multiplier, probability: odds.probability,
    potentialWin: Math.floor(pts * odds.multiplier)
  };
  
  user.pts -= pts;
  user.totalPredictions++;
  activePredictions.set(predId, prediction);
  
  publishNewBet(prediction, user);
  addToActivityFeed({ type: 'prediction_placed', user: user.displayName, district, incidentType, amount: pts });
  
  res.json({ success: true, prediction, user: { pts: user.pts, rank: getUserRank(user.pts) } });
});

app.get('/predict/leaderboard', (req, res) => {
  const leaders = Array.from(users.values())
    .sort((a, b) => b.totalWinnings - a.totalWinnings)
    .slice(0, 20)
    .map(u => ({
      displayName: u.displayName, wins: u.wins, totalPredictions: u.totalPredictions,
      winnings: u.totalWinnings, rank: getUserRank(u.pts)
    }));
  res.json(leaders);
});

app.post('/auth/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  let user = users.get(username.toLowerCase().trim());
  if (!user) user = createUser(username);
  
  // Check daily bonus
  const today = new Date().toISOString().split('T')[0];
  let dailyBonus = null;
  if (user.lastLoginDate !== today) {
    user.pts += DAILY_LOGIN_BONUS;
    user.lastLoginDate = today;
    dailyBonus = { amount: DAILY_LOGIN_BONUS, newBalance: user.pts };
  }
  
  res.json({ 
    success: true, user, rank: getUserRank(user.pts), dailyBonus,
    activePredictions: Array.from(activePredictions.values()).filter(p => p.username === user.username)
  });
});

// Activity feed
app.get('/activity', (req, res) => res.json(activityFeed.slice(0, 50)));

// Core endpoints
app.get('/', async (req, res) => {
  const workerStats = await getWorkerStats() || {};
  res.json({ 
    name: "DISPATCH", version: "2.0", status: "operational", 
    cities: Object.keys(CITIES), connections: clients.size,
    totalIncidents: Object.values(localState).reduce((sum, s) => sum + s.incidents.length, 0),
    agents: detectiveBureau.getAgentStatuses(),
    predictionAccuracy: detectiveBureau.getAccuracy(),
    workerStatus: workerStats
  });
});

app.get('/incidents', (req, res) => {
  const city = req.query.city || 'nyc';
  res.json(localState[city]?.incidents || []);
});

app.get('/cameras', async (req, res) => {
  const city = req.query.city || 'nyc';
  const state = await getCityState(city);
  res.json(state?.cameras || localState[city]?.cameras || []);
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/debug', async (req, res) => {
  const workerStats = await getWorkerStats() || {};
  res.json({
    workerStats,
    connections: clients.size,
    localIncidents: Object.fromEntries(Object.entries(localState).map(([k, v]) => [k, v.incidents.length])),
    agents: detectiveBureau.getAgentStatuses(),
    predictions: detectiveBureau.getPredictionStats()
  });
});

// Scanner status (from worker)
app.get('/scanner/status', async (req, res) => {
  const workerStats = await getWorkerStats();
  if (!workerStats) {
    return res.json({ status: 'worker_offline', message: 'Worker process not reporting' });
  }
  res.json(workerStats.scanner);
});

// Camera proxy
app.get('/camera-image/:id', async (req, res) => {
  try {
    const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`);
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ============================================
// DATA API ENDPOINTS (PostgreSQL)
// ============================================

// Arrests data
app.get('/data/arrests', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available', data: [] });
  
  try {
    const { city = 'nyc', limit = 100, offset = 0, borough, date } = req.query;
    let query = 'SELECT * FROM arrests WHERE city = $1';
    const params = [city];
    let paramIndex = 2;
    
    if (borough) {
      query += ` AND borough ILIKE $${paramIndex++}`;
      params.push(`%${borough}%`);
    }
    if (date) {
      query += ` AND arrest_date >= $${paramIndex++}`;
      params.push(date);
    }
    
    query += ` ORDER BY arrest_date DESC NULLS LAST, created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM arrests WHERE city = $1', [city]);
    
    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[DATA] Arrests query error:', error.message);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// 911 Calls data
app.get('/data/911-calls', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available', data: [] });
  
  try {
    const { city = 'nyc', limit = 100, offset = 0, borough, type, since } = req.query;
    let query = 'SELECT * FROM calls_911 WHERE city = $1';
    const params = [city];
    let paramIndex = 2;
    
    if (borough) {
      query += ` AND borough ILIKE $${paramIndex++}`;
      params.push(`%${borough}%`);
    }
    if (type) {
      query += ` AND incident_type ILIKE $${paramIndex++}`;
      params.push(`%${type}%`);
    }
    if (since) {
      query += ` AND created_date >= $${paramIndex++}`;
      params.push(since);
    }
    
    query += ` ORDER BY created_date DESC NULLS LAST LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM calls_911 WHERE city = $1', [city]);
    
    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[DATA] 911 calls query error:', error.message);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// Inmates/Facility data
app.get('/data/inmates', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available', data: [] });
  
  try {
    const { city = 'nyc', limit = 100, offset = 0, facility } = req.query;
    let query = 'SELECT * FROM inmates WHERE city = $1';
    const params = [city];
    let paramIndex = 2;
    
    if (facility) {
      query += ` AND facility ILIKE $${paramIndex++}`;
      params.push(`%${facility}%`);
    }
    
    query += ` ORDER BY admission_date DESC NULLS LAST, created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM inmates WHERE city = $1', [city]);
    
    // Get facility breakdown
    const facilityBreakdown = await pool.query(`
      SELECT facility, COUNT(*) as count 
      FROM inmates 
      WHERE city = $1 
      GROUP BY facility 
      ORDER BY count DESC
    `, [city]);
    
    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      byFacility: facilityBreakdown.rows
    });
  } catch (error) {
    console.error('[DATA] Inmates query error:', error.message);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// ICE Activities
app.get('/data/ice', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available', data: [] });
  
  try {
    const { city = 'nyc', limit = 100, offset = 0, type, since } = req.query;
    let query = 'SELECT * FROM ice_activities WHERE city = $1';
    const params = [city];
    let paramIndex = 2;
    
    if (type) {
      query += ` AND activity_type ILIKE $${paramIndex++}`;
      params.push(`%${type}%`);
    }
    if (since) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(since);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM ice_activities WHERE city = $1', [city]);
    
    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[DATA] ICE query error:', error.message);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// Detention Facilities
app.get('/data/facilities', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available', data: [] });
  
  try {
    const { city, state: stateParam, type } = req.query;
    let query = 'SELECT * FROM detention_facilities WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (city) {
      query += ` AND city = $${paramIndex++}`;
      params.push(city);
    }
    if (stateParam) {
      query += ` AND state = $${paramIndex++}`;
      params.push(stateParam);
    }
    if (type) {
      query += ` AND facility_type ILIKE $${paramIndex++}`;
      params.push(`%${type}%`);
    }
    
    query += ' ORDER BY name';
    
    const result = await pool.query(query, params);
    
    res.json({
      data: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    console.error('[DATA] Facilities query error:', error.message);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// Data stats summary
app.get('/data/stats', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ error: 'Database not available' });
  
  try {
    const { city = 'nyc' } = req.query;
    
    const [arrests, calls911, inmates, ice, incidents] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM arrests WHERE city = $1', [city]),
      pool.query('SELECT COUNT(*) FROM calls_911 WHERE city = $1', [city]),
      pool.query('SELECT COUNT(*) FROM inmates WHERE city = $1', [city]),
      pool.query('SELECT COUNT(*) FROM ice_activities WHERE city = $1', [city]),
      pool.query('SELECT COUNT(*) FROM incidents_db WHERE city = $1', [city])
    ]);
    
    // Get recent activity dates
    const recentArrest = await pool.query('SELECT MAX(arrest_date) as latest FROM arrests WHERE city = $1', [city]);
    const recent911 = await pool.query('SELECT MAX(created_date) as latest FROM calls_911 WHERE city = $1', [city]);
    
    res.json({
      city,
      counts: {
        arrests: parseInt(arrests.rows[0].count),
        calls_911: parseInt(calls911.rows[0].count),
        inmates: parseInt(inmates.rows[0].count),
        ice_activities: parseInt(ice.rows[0].count),
        scanner_incidents: parseInt(incidents.rows[0].count)
      },
      latestData: {
        arrests: recentArrest.rows[0].latest,
        calls_911: recent911.rows[0].latest
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[DATA] Stats query error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBSOCKET
// ============================================

wss.on('connection', (ws, req) => {
  clients.add(ws);
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedCity = url.searchParams.get('city') || 'nyc';
  ws.subscribedCity = requestedCity;
  
  if (cityClients[requestedCity]) {
    cityClients[requestedCity].add(ws);
  }
  
  const city = CITIES[requestedCity] || CITIES.nyc;
  const state = localState[requestedCity] || localState.nyc;
  
  ws.send(JSON.stringify({
    type: "init",
    city: {
      id: city.id, name: city.name, shortName: city.shortName,
      mapCenter: city.mapCenter, mapZoom: city.mapZoom,
      districts: city.districts, color: city.color
    },
    cities: Object.values(CITIES).map(c => ({ id: c.id, name: c.name, shortName: c.shortName, color: c.color })),
    incidents: state.incidents.slice(0, 20),
    cameras: state.cameras,
    transcripts: state.recentTranscripts.slice(0, 10),
    agents: detectiveBureaus[requestedCity].getAgentStatuses(),
    predictions: detectiveBureaus[requestedCity].getPredictionStats()
  }));
  
  ws.on('close', () => {
    clients.delete(ws);
    Object.values(cityClients).forEach(set => set.delete(ws));
  });
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'subscribe_city') {
        const newCity = data.city;
        if (CITIES[newCity]) {
          if (ws.subscribedCity && cityClients[ws.subscribedCity]) {
            cityClients[ws.subscribedCity].delete(ws);
          }
          ws.subscribedCity = newCity;
          cityClients[newCity].add(ws);
          
          const city = CITIES[newCity];
          const state = localState[newCity];
          
          ws.send(JSON.stringify({
            type: "city_changed",
            city: { id: city.id, name: city.name, shortName: city.shortName, mapCenter: city.mapCenter, mapZoom: city.mapZoom, districts: city.districts, color: city.color },
            incidents: state.incidents.slice(0, 20),
            cameras: state.cameras,
            transcripts: state.recentTranscripts.slice(0, 10)
          }));
        }
      }
    } catch (e) { 
      console.error('WS error:', e); 
    }
  });
});

// ============================================
// STARTUP
// ============================================

async function main() {
  console.log(`
=====================================================
  DISPATCH WEB - API & WebSocket Server
  Port: ${PORT}
=====================================================
  `);
  
  // Initialize database
  initPool();
  await initDatabase();
  
  // Initialize Redis and subscriptions
  await initRedis();
  await setupRedisSubscriptions();
  
  // Load initial state from Redis cache
  for (const cityId of Object.keys(CITIES)) {
    const cachedState = await getCityState(cityId);
    if (cachedState) {
      localState[cityId] = { ...localState[cityId], ...cachedState };
      console.log(`[${cityId.toUpperCase()}] Loaded cached state: ${cachedState.incidents?.length || 0} incidents`);
    }
  }
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[WEB] Server listening on port ${PORT}`);
  });
}

main().catch(console.error);
