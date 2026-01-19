import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import https from 'https';
import fs from 'fs';
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
// PERSISTENT MEMORY SYSTEM
// ============================================

const MEMORY_FILE = './detective_memory.json';
const MEMORY_SAVE_INTERVAL = 60000; // Save every minute

function loadMemoryFromDisk() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      console.log('[MEMORY] Loaded from disk:', data.incidents?.length || 0, 'incidents,', data.predictionStats?.total || 0, 'predictions');
      return data;
    }
  } catch (error) {
    console.error('[MEMORY] Load error:', error.message);
  }
  return null;
}

function saveMemoryToDisk(memory, predictionStats, agents) {
  try {
    const serializable = {
      incidents: memory.incidents,
      predictions: memory.predictions,
      predictionHistory: memory.predictionHistory,
      patterns: memory.patterns,
      suspectProfiles: memory.suspectProfiles,
      agentInsights: memory.agentInsights,
      collaborations: memory.collaborations,
      hotspots: Array.from(memory.hotspots.entries()),
      addressHistory: Array.from(memory.addressHistory.entries()),
      cases: Array.from(memory.cases.entries()),
      predictionStats: {
        total: predictionStats.total,
        correct: predictionStats.correct,
        pending: predictionStats.pending,
        accuracyHistory: predictionStats.accuracyHistory
      },
      agentStats: Object.fromEntries(
        Object.entries(agents).map(([k, v]) => [k, { stats: v.stats, history: v.history.slice(-100) }])
      ),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(serializable, null, 2));
  } catch (error) {
    console.error('[MEMORY] Save error:', error.message);
  }
}

// ============================================
// DETECTIVE BUREAU - 4 SPECIALIZED AGENTS
// Enhanced with persistent memory, collaboration, and feedback tracking
// ============================================

class DetectiveBureau {
  constructor(anthropicClient) {
    this.anthropic = anthropicClient;
    
    const savedMemory = loadMemoryFromDisk();
    const savedAgentStats = savedMemory?.agentStats || {};
    
    this.agents = {
      CHASE: {
        id: 'CHASE',
        name: 'CHASE',
        icon: '🚔',
        role: 'Pursuit Specialist',
        status: 'idle',
        triggers: ['pursuit', 'fled', 'fleeing', 'chase', 'vehicle pursuit', 'on foot', 'running', 'high speed', 'foot pursuit', '10-13'],
        systemPrompt: `You are CHASE, a pursuit specialist AI. You predict escape routes, containment points, and track active pursuits across NYC. You know NYC street topology intimately - one-ways, dead ends, bridge/tunnel access. Keep responses to 2-3 sentences. Be tactical and specific.`,
        stats: savedAgentStats.CHASE?.stats || { activations: 0, insights: 0, successfulContainments: 0 },
        history: savedAgentStats.CHASE?.history || []
      },
      PATTERN: {
        id: 'PATTERN',
        name: 'PATTERN',
        icon: '🔗',
        role: 'Serial Crime Analyst',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are PATTERN, a serial crime analyst AI. You find connections between incidents - matching MOs, geographic clusters, temporal patterns, suspect descriptions. You name the patterns you discover. Keep responses to 2-3 sentences. Reference specific incident details.`,
        stats: savedAgentStats.PATTERN?.stats || { activations: 0, patternsFound: 0, linkedIncidents: 0 },
        history: savedAgentStats.PATTERN?.history || []
      },
      PROPHET: {
        id: 'PROPHET',
        name: 'PROPHET',
        icon: '🔮',
        role: 'Predictive Analyst',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are PROPHET, a predictive analyst AI. You make specific, testable predictions about where and when incidents will occur. Always include location, time window, incident type, and confidence percentage. Your accuracy is tracked publicly. Learn from your hits and misses.`,
        stats: savedAgentStats.PROPHET?.stats || { activations: 0, totalPredictions: 0, hits: 0, misses: 0 },
        history: savedAgentStats.PROPHET?.history || []
      },
      HISTORIAN: {
        id: 'HISTORIAN',
        name: 'HISTORIAN',
        icon: '📚',
        role: 'Historical Context',
        status: 'idle',
        triggers: [],
        systemPrompt: `You are HISTORIAN, the memory of the Detective Bureau. You remember every incident, every address, every suspect description. When new incidents occur, you surface relevant history - "this address had 4 calls this week", "suspect matches description from yesterday". Keep responses to 2-3 sentences.`,
        stats: savedAgentStats.HISTORIAN?.stats || { activations: 0, contextsProvided: 0, repeatAddresses: 0 },
        history: savedAgentStats.HISTORIAN?.history || []
      }
    };

    // Load persistent memory or initialize fresh
    this.memory = {
      incidents: savedMemory?.incidents || [],
      cases: new Map(savedMemory?.cases || []),
      predictions: savedMemory?.predictions || [],
      predictionHistory: savedMemory?.predictionHistory || [],
      patterns: savedMemory?.patterns || [],
      suspectProfiles: savedMemory?.suspectProfiles || [],
      hotspots: new Map(savedMemory?.hotspots || []),
      addressHistory: new Map(savedMemory?.addressHistory || []),
      agentInsights: savedMemory?.agentInsights || [],
      collaborations: savedMemory?.collaborations || []
    };

    this.predictionStats = {
      total: savedMemory?.predictionStats?.total || 0,
      correct: savedMemory?.predictionStats?.correct || 0,
      pending: savedMemory?.predictionStats?.pending || [],
      accuracyHistory: savedMemory?.predictionStats?.accuracyHistory || []
    };

    // Start memory persistence
    setInterval(() => {
      saveMemoryToDisk(this.memory, this.predictionStats, this.agents);
    }, MEMORY_SAVE_INTERVAL);

    this.startProphetCycle();
    this.startPatternCycle();
    
    console.log('[DETECTIVE] Bureau initialized with', this.memory.incidents.length, 'historical incidents');
  }

  // ============================================
  // AGENT COLLABORATION
  // ============================================
  
  async consultAgent(agentId, question, context = {}) {
    const agent = this.agents[agentId];
    if (!agent) return null;
    
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: agent.systemPrompt,
        messages: [{
          role: "user",
          content: `${question}\n\nContext: ${JSON.stringify(context)}`
        }]
      });
      return response.content[0].text;
    } catch (error) {
      console.error(`[${agentId}] Consultation error:`, error.message);
      return null;
    }
  }

  async crossReference(incident, sourceAgent, targetAgent) {
    const source = this.agents[sourceAgent];
    const target = this.agents[targetAgent];
    
    if (!source || !target) return null;
    
    const question = `Based on your expertise as ${target.role}, what context can you provide about this incident that might help with ${source.role.toLowerCase()} analysis?`;
    
    const insight = await this.consultAgent(targetAgent, question, { incident });
    
    if (insight) {
      const collaboration = {
        id: `collab_${Date.now()}`,
        sourceAgent,
        targetAgent,
        incidentId: incident.id,
        question,
        insight,
        timestamp: new Date().toISOString()
      };
      
      this.memory.collaborations.unshift(collaboration);
      if (this.memory.collaborations.length > 200) this.memory.collaborations.pop();
      
      return collaboration;
    }
    
    return null;
  }

  // ============================================
  // INCIDENT PROCESSING
  // ============================================

  async processIncident(incident, broadcast) {
    const insights = [];
    
    // Store incident (increased limit for better pattern analysis)
    this.memory.incidents.unshift(incident);
    if (this.memory.incidents.length > 500) this.memory.incidents.pop();
    
    // Update address history
    const addressKey = incident.location?.toLowerCase() || 'unknown';
    const addressCount = (this.memory.addressHistory.get(addressKey) || 0) + 1;
    this.memory.addressHistory.set(addressKey, addressCount);
    
    // Update hotspots
    const hotspotKey = `${incident.borough}-${incident.location}`;
    this.memory.hotspots.set(hotspotKey, (this.memory.hotspots.get(hotspotKey) || 0) + 1);
    
    // Check prediction hits
    this.checkPredictionHit(incident, broadcast);

    // CHASE - Activates on pursuits
    if (this.shouldActivateChase(incident)) {
      this.agents.CHASE.status = 'active';
      this.agents.CHASE.stats.activations++;
      
      const chaseInsight = await this.runChase(incident);
      if (chaseInsight) {
        insights.push({ agent: 'CHASE', insight: chaseInsight });
        this.agents.CHASE.stats.insights++;
        
        // Store in agent history
        this.agents.CHASE.history.unshift({
          incidentId: incident.id,
          location: incident.location,
          borough: incident.borough,
          insight: chaseInsight,
          timestamp: new Date().toISOString()
        });
        if (this.agents.CHASE.history.length > 100) this.agents.CHASE.history.pop();
        
        // Cross-reference with HISTORIAN for location history
        const historianContext = await this.crossReference(incident, 'CHASE', 'HISTORIAN');
        
        broadcast({
          type: 'agent_insight',
          agent: 'CHASE',
          agentIcon: '🚔',
          incidentId: incident.id,
          analysis: chaseInsight,
          collaboration: historianContext,
          urgency: 'critical',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.CHASE.status = 'idle';
    }

    // HISTORIAN - Always runs for known locations
    if (incident.location && incident.location !== 'Unknown') {
      this.agents.HISTORIAN.status = 'analyzing';
      this.agents.HISTORIAN.stats.activations++;
      
      const historianInsight = await this.runHistorian(incident, addressCount);
      if (historianInsight) {
        insights.push({ agent: 'HISTORIAN', insight: historianInsight });
        this.agents.HISTORIAN.stats.contextsProvided++;
        
        if (addressCount > 1) {
          this.agents.HISTORIAN.stats.repeatAddresses++;
        }
        
        this.agents.HISTORIAN.history.unshift({
          incidentId: incident.id,
          address: incident.location,
          borough: incident.borough,
          addressCount,
          insight: historianInsight,
          timestamp: new Date().toISOString()
        });
        if (this.agents.HISTORIAN.history.length > 100) this.agents.HISTORIAN.history.pop();
        
        broadcast({
          type: 'agent_insight',
          agent: 'HISTORIAN',
          agentIcon: '📚',
          incidentId: incident.id,
          analysis: historianInsight,
          addressCount,
          urgency: addressCount > 3 ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.HISTORIAN.status = 'idle';
    }

    // PATTERN - Check for connections
    if (this.memory.incidents.length >= 3) {
      this.agents.PATTERN.status = 'analyzing';
      this.agents.PATTERN.stats.activations++;
      
      const patternInsight = await this.runPattern(incident);
      if (patternInsight) {
        insights.push({ agent: 'PATTERN', insight: patternInsight });
        
        if (patternInsight.isPattern) {
          this.agents.PATTERN.stats.patternsFound++;
          this.agents.PATTERN.stats.linkedIncidents += (patternInsight.linkedIncidentIds?.length || 0);
          
          // Cross-reference with PROPHET for prediction
          const prophetContext = await this.crossReference(incident, 'PATTERN', 'PROPHET');
          
          broadcast({
            type: 'pattern_detected',
            agent: 'PATTERN',
            agentIcon: '🔗',
            pattern: patternInsight,
            collaboration: prophetContext,
            timestamp: new Date().toISOString()
          });
        }
        
        this.agents.PATTERN.history.unshift({
          incidentId: incident.id,
          isPattern: patternInsight.isPattern,
          patternName: patternInsight.patternName,
          linkedCount: patternInsight.linkedIncidentIds?.length || 0,
          timestamp: new Date().toISOString()
        });
        if (this.agents.PATTERN.history.length > 100) this.agents.PATTERN.history.pop();
        
        broadcast({
          type: 'agent_insight',
          agent: 'PATTERN',
          agentIcon: '🔗',
          incidentId: incident.id,
          analysis: patternInsight.analysis,
          urgency: patternInsight.confidence === 'HIGH' ? 'high' : 'medium',
          timestamp: new Date().toISOString()
        });
      }
      this.agents.PATTERN.status = 'idle';
    }

    // Store all insights for this incident
    this.memory.agentInsights.unshift({
      incidentId: incident.id,
      insights,
      timestamp: new Date().toISOString()
    });
    if (this.memory.agentInsights.length > 500) this.memory.agentInsights.pop();

    return insights;
  }

  shouldActivateChase(incident) {
    const text = `${incident.incidentType} ${incident.summary || ''}`.toLowerCase();
    return this.agents.CHASE.triggers.some(trigger => text.includes(trigger));
  }

  async runChase(incident) {
    try {
      // Get recent pursuits in same area for context
      const recentPursuits = this.agents.CHASE.history
        .filter(h => h.timestamp > new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .slice(0, 5);
      
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: this.agents.CHASE.systemPrompt + `\n\nYou have access to recent pursuit history for pattern analysis.`,
        messages: [{
          role: "user",
          content: `ACTIVE PURSUIT:
Type: ${incident.incidentType}
Location: ${incident.location}
Borough: ${incident.borough}
Details: ${incident.summary}
Units: ${JSON.stringify(incident.units)}

Recent pursuits in area (last 24h):
${JSON.stringify(recentPursuits)}

Predict escape routes and recommend containment. Consider historical escape patterns.`
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
      ).slice(0, 10);

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: this.agents.HISTORIAN.systemPrompt + `\n\nYou have access to complete incident history. Flag repeat problem locations and escalation patterns.`,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:
${JSON.stringify(incident)}

This address has had ${addressCount} calls total.

Related incidents at same location/borough:
${JSON.stringify(relatedIncidents)}

Is this a problem location? Any escalation pattern?`
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
        const isRecent = timeDiff < 4 * 60 * 60 * 1000; // 4 hours
        return isRecent;
      }).slice(0, 15);

      if (recentSimilar.length < 2) return null;

      // Include active patterns for context
      const activePatterns = this.memory.patterns.filter(p => p.status === 'active').slice(0, 5);

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: this.agents.PATTERN.systemPrompt + `\n\nRespond in JSON: { "isPattern": true/false, "patternName": "string (be creative and specific)", "analysis": "string", "linkedIncidentIds": [numbers], "confidence": "HIGH/MEDIUM/LOW", "prediction": { "location": "string", "timeWindow": "string", "type": "string" }, "suspectDescription": "string or null" }`,
        messages: [{
          role: "user",
          content: `NEW INCIDENT:
${JSON.stringify(incident)}

RECENT INCIDENTS (last 4 hours):
${JSON.stringify(recentSimilar)}

ACTIVE PATTERNS:
${JSON.stringify(activePatterns)}

Are these connected? Is this part of an existing pattern or a new one forming? Give the pattern a memorable name if found.`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        // Validate pattern before storing
        const isValidPattern = result.isPattern && 
          result.patternName && 
          result.patternName.trim() !== '' &&
          result.patternName.toLowerCase() !== 'unknown pattern' &&
          result.patternName.toLowerCase() !== 'unknown' &&
          Array.isArray(result.linkedIncidentIds) &&
          result.linkedIncidentIds.length > 0;
        
        if (isValidPattern) {
          const pattern = {
            ...result,
            id: `pattern_${Date.now()}`,
            detectedAt: new Date().toISOString(),
            status: 'active',
            incidentCount: (result.linkedIncidentIds?.length || 0) + 1
          };
          
          // Check if this updates an existing pattern
          const existingIndex = this.memory.patterns.findIndex(p => 
            p.patternName === result.patternName && p.status === 'active'
          );
          
          if (existingIndex >= 0) {
            this.memory.patterns[existingIndex] = {
              ...this.memory.patterns[existingIndex],
              ...pattern,
              incidentCount: this.memory.patterns[existingIndex].incidentCount + 1
            };
          } else {
            this.memory.patterns.unshift(pattern);
            console.log(`[PATTERN] New pattern detected: "${result.patternName}" with ${result.linkedIncidentIds.length} linked incidents`);
          }
          
          if (this.memory.patterns.length > 100) this.memory.patterns.pop();
        } else if (result.isPattern) {
          // Log why pattern was rejected
          console.log(`[PATTERN] Rejected invalid pattern: name="${result.patternName}", linkedIds=${result.linkedIncidentIds?.length || 0}`);
        }
        
        return { ...result, isPattern: isValidPattern };
      }
      return { isPattern: false, analysis: text };
    } catch (error) {
      console.error('[PATTERN] Error:', error.message);
      return null;
    }
  }

  // ============================================
  // PROPHET PREDICTIONS WITH FEEDBACK TRACKING
  // ============================================

  startProphetCycle() {
    // Run every 15 minutes
    setInterval(async () => {
      await this.runProphet();
    }, 15 * 60 * 1000);
    
    // Initial run after 2 minutes
    setTimeout(() => this.runProphet(), 2 * 60 * 1000);
  }

  async runProphet() {
    if (this.memory.incidents.length < 5) return;
    
    this.agents.PROPHET.status = 'analyzing';
    this.agents.PROPHET.stats.activations++;
    
    try {
      const recentIncidents = this.memory.incidents.slice(0, 30);
      const hotspots = Array.from(this.memory.hotspots.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      
      // Include prediction history for learning
      const recentPredictions = this.predictionStats.accuracyHistory.slice(0, 20);
      const activePatterns = this.memory.patterns.filter(p => p.status === 'active');

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: this.agents.PROPHET.systemPrompt + `\n\nYou have access to your prediction history. Learn from hits and misses. Respond in JSON: { "predictions": [{ "location": "specific NYC location", "borough": "string", "incidentType": "string", "timeWindowMinutes": number, "confidence": 0.0-1.0, "reasoning": "string", "basedOnPattern": "pattern name or null" }] }. Make 1-3 specific predictions.`,
        messages: [{
          role: "user",
          content: `Current time: ${new Date().toISOString()}
Hour: ${new Date().getHours()}
Day: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}

RECENT INCIDENTS (${recentIncidents.length}):
${JSON.stringify(recentIncidents.slice(0, 15))}

HOTSPOTS:
${JSON.stringify(hotspots)}

ACTIVE PATTERNS:
${JSON.stringify(activePatterns)}

YOUR RECENT PREDICTION PERFORMANCE (learn from this):
${JSON.stringify(recentPredictions)}

Based on patterns, hotspots, time of day, and your learning from past predictions, what incidents do you predict in the next 30-60 minutes? Be specific about location.`
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
          
          // Store in full history
          this.memory.predictionHistory.unshift({
            ...prediction,
            outcome: 'pending'
          });
          if (this.memory.predictionHistory.length > 500) this.memory.predictionHistory.pop();
          
          this.agents.PROPHET.history.unshift({
            predictionId: prediction.id,
            location: pred.location,
            borough: pred.borough,
            type: pred.incidentType,
            confidence: pred.confidence,
            basedOnPattern: pred.basedOnPattern,
            timestamp: new Date().toISOString()
          });
          if (this.agents.PROPHET.history.length > 100) this.agents.PROPHET.history.pop();
          
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
      
      // Check expiration
      if (now > expiresAt) {
        pred.status = 'expired';
        this.agents.PROPHET.stats.misses++;
        
        // Update full history
        const historyEntry = this.memory.predictionHistory.find(h => h.id === pred.id);
        if (historyEntry) {
          historyEntry.outcome = 'miss';
          historyEntry.resolvedAt = now.toISOString();
        }
        
        // Record in accuracy history for learning
        this.recordAccuracy('miss', pred);
        
        return false;
      }
      
      // Check for hit
      const boroughMatch = incident.borough?.toLowerCase() === pred.borough?.toLowerCase();
      const typeMatch = incident.incidentType?.toLowerCase().includes(pred.incidentType?.toLowerCase()) ||
                       pred.incidentType?.toLowerCase().includes(incident.incidentType?.toLowerCase());
      
      // Check location proximity
      const locationWords = pred.location?.toLowerCase().split(/[\s,]+/) || [];
      const incidentLocation = incident.location?.toLowerCase() || '';
      const locationMatch = locationWords.some(word => word.length > 3 && incidentLocation.includes(word));
      
      if (boroughMatch && typeMatch) {
        pred.status = 'hit';
        pred.matchedIncidentId = incident.id;
        pred.matchQuality = locationMatch ? 'exact' : 'borough';
        this.predictionStats.correct++;
        this.agents.PROPHET.stats.hits++;
        
        // Update full history
        const historyEntry = this.memory.predictionHistory.find(h => h.id === pred.id);
        if (historyEntry) {
          historyEntry.outcome = 'hit';
          historyEntry.matchedIncidentId = incident.id;
          historyEntry.matchQuality = pred.matchQuality;
          historyEntry.resolvedAt = now.toISOString();
        }
        
        // Record in accuracy history for learning
        this.recordAccuracy('hit', pred, incident);
        
        broadcast({
          type: 'prediction_hit',
          agent: 'PROPHET',
          agentIcon: '🔮',
          prediction: pred,
          matchedIncident: incident,
          accuracy: this.getAccuracy(),
          timestamp: now.toISOString()
        });
        
        console.log(`[PROPHET] PREDICTION HIT! ${pred.incidentType} at ${pred.location}`);
        return false;
      }
      
      return true;
    });
  }

  recordAccuracy(outcome, prediction, matchedIncident = null) {
    this.predictionStats.accuracyHistory.unshift({
      predictionId: prediction.id,
      outcome,
      confidence: prediction.confidence,
      location: prediction.location,
      borough: prediction.borough,
      type: prediction.incidentType,
      matchedIncidentId: matchedIncident?.id,
      matchQuality: prediction.matchQuality,
      timestamp: new Date().toISOString()
    });
    
    if (this.predictionStats.accuracyHistory.length > 200) {
      this.predictionStats.accuracyHistory.pop();
    }
  }

  // ============================================
  // PATTERN BACKGROUND ANALYSIS
  // ============================================

  startPatternCycle() {
    setInterval(async () => {
      if (this.memory.incidents.length < 10) return;
      
      this.agents.PATTERN.status = 'analyzing';
      
      try {
        // Expire old patterns (24 hours)
        this.memory.patterns = this.memory.patterns.map(p => {
          const age = Date.now() - new Date(p.detectedAt).getTime();
          if (age > 24 * 60 * 60 * 1000 && p.status === 'active') {
            return { ...p, status: 'expired' };
          }
          return p;
        });
        
        const response = await this.anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 600,
          system: this.agents.PATTERN.systemPrompt,
          messages: [{
            role: "user",
            content: `Background analysis of last 50 incidents for emerging patterns:\n${JSON.stringify(this.memory.incidents.slice(0, 50))}`
          }]
        });
        
        console.log('[PATTERN] Background analysis complete');
      } catch (error) {
        console.error('[PATTERN] Background error:', error.message);
      }
      
      this.agents.PATTERN.status = 'idle';
    }, 5 * 60 * 1000);
  }

  // ============================================
  // PUBLIC METHODS - BASIC
  // ============================================

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
      stats: agent.stats
    }));
  }

  getPredictionStats() {
    return {
      total: this.predictionStats.total,
      correct: this.predictionStats.correct,
      accuracy: this.getAccuracy(),
      pending: this.predictionStats.pending,
      recentHistory: this.predictionStats.accuracyHistory.slice(0, 20)
    };
  }

  // ============================================
  // PUBLIC METHODS - NEW DETECTIVE ENDPOINTS
  // ============================================

  // Helper to filter valid patterns
  getValidPatterns() {
    return this.memory.patterns.filter(p => 
      p.patternName && 
      p.patternName.trim() !== '' &&
      p.patternName.toLowerCase() !== 'unknown pattern' &&
      p.patternName.toLowerCase() !== 'unknown' &&
      p.incidentCount > 0
    );
  }

  // Overview endpoint - combined status of all agents
  getOverview() {
    const validPatterns = this.getValidPatterns();
    
    return {
      agents: this.getAgentStatuses(),
      predictions: {
        total: this.predictionStats.total,
        correct: this.predictionStats.correct,
        accuracy: this.getAccuracy(),
        pending: this.predictionStats.pending.length
      },
      patterns: {
        active: validPatterns.filter(p => p.status === 'active').length,
        total: validPatterns.length
      },
      memory: {
        incidents: this.memory.incidents.length,
        insights: this.memory.agentInsights.length,
        collaborations: this.memory.collaborations.length,
        addressesTracked: this.memory.addressHistory.size
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }

  // CHASE specific data
  getChaseData() {
    const recentPursuits = this.memory.incidents
      .filter(inc => this.shouldActivateChase(inc))
      .slice(0, 30);
    
    return {
      agent: {
        ...this.agents.CHASE,
        systemPrompt: undefined // Don't expose
      },
      recentPursuits,
      analysisHistory: this.agents.CHASE.history.slice(0, 50),
      stats: this.agents.CHASE.stats,
      // Hot pursuit zones based on history
      hotZones: this.calculatePursuitHotZones(),
      timestamp: new Date().toISOString()
    };
  }

  calculatePursuitHotZones() {
    const zones = {};
    this.agents.CHASE.history.forEach(h => {
      const key = h.borough || 'Unknown';
      zones[key] = (zones[key] || 0) + 1;
    });
    return Object.entries(zones)
      .map(([borough, count]) => ({ borough, count }))
      .sort((a, b) => b.count - a.count);
  }

  // PATTERN specific data
  getPatternData() {
    const validPatterns = this.getValidPatterns();
    
    return {
      agent: {
        ...this.agents.PATTERN,
        systemPrompt: undefined
      },
      activePatterns: validPatterns.filter(p => p.status === 'active'),
      expiredPatterns: validPatterns.filter(p => p.status === 'expired').slice(0, 20),
      analysisHistory: this.agents.PATTERN.history.slice(0, 50),
      stats: this.agents.PATTERN.stats,
      // Pattern timeline for visualization
      timeline: validPatterns.slice(0, 50).map(p => ({
        id: p.id,
        name: p.patternName,
        status: p.status,
        incidentCount: p.incidentCount,
        detectedAt: p.detectedAt,
        confidence: p.confidence
      })),
      timestamp: new Date().toISOString()
    };
  }

  // PROPHET specific data with accuracy charts
  getProphetData() {
    return {
      agent: {
        ...this.agents.PROPHET,
        systemPrompt: undefined
      },
      pendingPredictions: this.predictionStats.pending,
      predictionHistory: this.memory.predictionHistory.slice(0, 100),
      stats: this.agents.PROPHET.stats,
      // Accuracy over time for charts
      accuracyOverTime: this.calculateAccuracyOverTime(),
      // Accuracy by type
      accuracyByType: this.calculateAccuracyByType(),
      // Accuracy by borough
      accuracyByBorough: this.calculateAccuracyByBorough(),
      // Confidence calibration
      confidenceCalibration: this.calculateConfidenceCalibration(),
      timestamp: new Date().toISOString()
    };
  }

  calculateAccuracyOverTime() {
    const history = this.predictionStats.accuracyHistory;
    const windows = [];
    
    for (let i = 0; i < Math.min(10, Math.ceil(history.length / 10)); i++) {
      const slice = history.slice(i * 10, (i + 1) * 10);
      if (slice.length === 0) continue;
      
      const hits = slice.filter(h => h.outcome === 'hit').length;
      const total = slice.length;
      
      windows.push({
        period: i,
        accuracy: total > 0 ? (hits / total) * 100 : 0,
        hits,
        misses: total - hits,
        total,
        oldestTimestamp: slice[slice.length - 1]?.timestamp
      });
    }
    
    return windows;
  }

  calculateAccuracyByType() {
    const byType = {};
    this.predictionStats.accuracyHistory.forEach(h => {
      const type = h.type || 'unknown';
      if (!byType[type]) byType[type] = { hits: 0, total: 0 };
      byType[type].total++;
      if (h.outcome === 'hit') byType[type].hits++;
    });
    
    return Object.entries(byType).map(([type, data]) => ({
      type,
      hits: data.hits,
      total: data.total,
      accuracy: data.total > 0 ? ((data.hits / data.total) * 100).toFixed(1) : '0'
    })).sort((a, b) => b.total - a.total);
  }

  calculateAccuracyByBorough() {
    const byBorough = {};
    this.predictionStats.accuracyHistory.forEach(h => {
      const borough = h.borough || 'unknown';
      if (!byBorough[borough]) byBorough[borough] = { hits: 0, total: 0 };
      byBorough[borough].total++;
      if (h.outcome === 'hit') byBorough[borough].hits++;
    });
    
    return Object.entries(byBorough).map(([borough, data]) => ({
      borough,
      hits: data.hits,
      total: data.total,
      accuracy: data.total > 0 ? ((data.hits / data.total) * 100).toFixed(1) : '0'
    })).sort((a, b) => b.total - a.total);
  }

  calculateConfidenceCalibration() {
    // Group by confidence buckets and check actual accuracy
    const buckets = { low: [], medium: [], high: [] };
    
    this.predictionStats.accuracyHistory.forEach(h => {
      const conf = h.confidence || 0;
      if (conf < 0.4) buckets.low.push(h);
      else if (conf < 0.7) buckets.medium.push(h);
      else buckets.high.push(h);
    });
    
    return Object.entries(buckets).map(([bucket, items]) => {
      const hits = items.filter(i => i.outcome === 'hit').length;
      const avgConf = items.length > 0 
        ? items.reduce((sum, i) => sum + (i.confidence || 0), 0) / items.length 
        : 0;
      
      return {
        bucket,
        avgConfidence: (avgConf * 100).toFixed(1),
        actualAccuracy: items.length > 0 ? ((hits / items.length) * 100).toFixed(1) : '0',
        total: items.length,
        // Calibration = how close predicted confidence is to actual accuracy
        calibrationError: items.length > 0 
          ? Math.abs(avgConf * 100 - (hits / items.length) * 100).toFixed(1)
          : '0'
      };
    });
  }

  // HISTORIAN specific data
  getHistorianData() {
    const problemAddresses = Array.from(this.memory.addressHistory.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([address, count]) => ({ address, count }));
    
    const hotspots = Array.from(this.memory.hotspots.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([key, count]) => {
        const [borough, ...locationParts] = key.split('-');
        return { borough, location: locationParts.join('-'), count };
      });
    
    return {
      agent: {
        ...this.agents.HISTORIAN,
        systemPrompt: undefined
      },
      problemAddresses,
      hotspots,
      analysisHistory: this.agents.HISTORIAN.history.slice(0, 50),
      stats: this.agents.HISTORIAN.stats,
      totalAddressesTracked: this.memory.addressHistory.size,
      // Repeat offender locations
      repeatLocations: problemAddresses.filter(a => a.count >= 3),
      timestamp: new Date().toISOString()
    };
  }

  // Collaboration data
  getCollaborationData() {
    const byPair = {};
    
    this.memory.collaborations.forEach(c => {
      const key = `${c.sourceAgent}→${c.targetAgent}`;
      byPair[key] = (byPair[key] || 0) + 1;
    });
    
    return {
      recent: this.memory.collaborations.slice(0, 50),
      byPair: Object.entries(byPair).map(([pair, count]) => ({ pair, count })),
      total: this.memory.collaborations.length,
      // Collaboration graph edges for visualization
      graph: {
        nodes: Object.keys(this.agents).map(id => ({
          id,
          name: this.agents[id].name,
          icon: this.agents[id].icon
        })),
        edges: Object.entries(byPair).map(([pair, count]) => {
          const [source, target] = pair.split('→');
          return { source, target, weight: count };
        })
      },
      timestamp: new Date().toISOString()
    };
  }

  // Manual prediction feedback (for user corrections)
  recordManualFeedback(predictionId, outcome, notes = '') {
    const historyEntry = this.memory.predictionHistory.find(h => h.id === predictionId);
    if (!historyEntry) return { error: 'Prediction not found' };
    
    const wasHit = historyEntry.outcome === 'hit';
    const isNowHit = outcome === 'hit';
    
    // Update stats if outcome changed
    if (wasHit !== isNowHit) {
      if (isNowHit) {
        this.predictionStats.correct++;
        this.agents.PROPHET.stats.hits++;
        this.agents.PROPHET.stats.misses--;
      } else {
        this.predictionStats.correct--;
        this.agents.PROPHET.stats.hits--;
        this.agents.PROPHET.stats.misses++;
      }
    }
    
    historyEntry.outcome = outcome;
    historyEntry.manualFeedback = true;
    historyEntry.feedbackNotes = notes;
    historyEntry.feedbackAt = new Date().toISOString();
    
    // Also update accuracy history
    const accEntry = this.predictionStats.accuracyHistory.find(h => h.predictionId === predictionId);
    if (accEntry) {
      accEntry.outcome = outcome;
      accEntry.manualFeedback = true;
    }
    
    return { 
      success: true, 
      prediction: historyEntry,
      newAccuracy: this.getAccuracy()
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
      hotspots: Array.from(this.memory.hotspots.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5),
      agentStats: Object.fromEntries(
        Object.entries(this.agents).map(([k, v]) => [k, v.stats])
      )
    };

    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        system: `You are the Detective Bureau briefing officer. Summarize current activity, patterns, predictions, and recommendations. Be concise and actionable. Include agent performance metrics.`,
        messages: [{
          role: "user",
          content: `Generate briefing:
Stats: ${JSON.stringify(stats)}
Recent incidents: ${JSON.stringify(this.memory.incidents.slice(0, 15))}
Active patterns: ${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'))}
Pending predictions: ${JSON.stringify(this.predictionStats.pending)}
Recent collaborations: ${JSON.stringify(this.memory.collaborations.slice(0, 5))}`
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

  // Alias for endpoints
  getAgentOverview() {
    return this.getOverview();
  }

  getAgentDetail(agentId) {
    const agent = this.agents[agentId];
    if (!agent) return null;
    
    return {
      id: agent.id,
      name: agent.name,
      icon: agent.icon,
      role: agent.role,
      status: agent.status,
      stats: agent.stats,
      triggers: agent.triggers,
      recentHistory: agent.history.slice(0, 50),
      timestamp: new Date().toISOString()
    };
  }
}

const detectiveBureau = new DetectiveBureau(anthropic);

// ============================================
// BETTING SYSTEM
// ============================================

const TREASURY_WALLET = process.env.TREASURY_WALLET || 'YOUR_SOLANA_WALLET_HERE';
const HOUSE_EDGE = 0.08; // 8% house edge

const oddsEngine = {
  // Base rates: expected DETECTED incidents per hour per borough (realistic for scanner detection)
  boroughRates: { 
    'Manhattan': 2.5,      // ~2-3 detected per hour
    'Brooklyn': 2.0,       
    'Bronx': 1.8,          
    'Queens': 1.2,         
    'Staten Island': 0.3   // Very quiet
  },
  
  // Incident type rarity multipliers (applied to base rate)
  incidentTypeRarity: { 
    'any': 1.0,            // Any incident
    'traffic': 0.20,       // 20% of incidents
    'medical': 0.15,       
    'domestic': 0.12,      
    'assault': 0.08,       
    'suspicious': 0.10,    
    'theft': 0.06,         
    'robbery': 0.03,       // Rare
    'pursuit': 0.02,       // Very rare
    'shots fired': 0.01    // Extremely rare
  },
  
  // Time of day multipliers
  timeMultipliers: { 
    0: 0.6, 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.3, 5: 0.4, 
    6: 0.6, 7: 0.8, 8: 0.9, 9: 1.0, 10: 1.0, 11: 1.1, 
    12: 1.2, 13: 1.1, 14: 1.0, 15: 1.1, 16: 1.2, 17: 1.3, 
    18: 1.4, 19: 1.5, 20: 1.6, 21: 1.5, 22: 1.3, 23: 0.9 
  },
  
  calculateProbability(borough, incidentType = 'any', windowMinutes = 30) {
    const hour = new Date().getHours();
    const baseRate = this.boroughRates[borough] || 1.0;
    const timeAdjusted = baseRate * this.timeMultipliers[hour];
    const typeMultiplier = this.incidentTypeRarity[incidentType.toLowerCase()] || 0.05;
    const adjusted = timeAdjusted * typeMultiplier;
    
    // Poisson probability of at least 1 event: P(X >= 1) = 1 - e^(-λ)
    const lambda = (adjusted / 60) * windowMinutes;
    const probability = 1 - Math.exp(-lambda);
    
    // Cap probability: min 2%, max 85% (ensures house edge always works)
    return Math.max(0.02, Math.min(0.85, probability));
  },
  
  calculateMultiplier(probability) {
    const fairOdds = 1 / probability;
    const withEdge = fairOdds * (1 - HOUSE_EDGE);
    // Min 1.1x, max 45x
    return Math.max(1.1, Math.min(45.0, Math.round(withEdge * 10) / 10));
  },
  
  getOdds(borough, incidentType = 'any', windowMinutes = 30) {
    const prob = this.calculateProbability(borough, incidentType, windowMinutes);
    const mult = this.calculateMultiplier(prob);
    const expectedValue = (prob * mult) - 1; // Negative = house wins
    
    return { 
      borough, 
      incidentType, 
      windowMinutes, 
      probability: Math.round(prob * 100),      // Whole number percentage (e.g., 85)
      probabilityRaw: prob,                      // Raw decimal for calculations
      multiplier: mult,
      expectedValue: Math.round(expectedValue * 1000) / 1000,
      houseEdge: `${(HOUSE_EDGE * 100).toFixed(0)}%`
    };
  }
};

const treasury = { totalReceived: 0, totalPaidOut: 0, get netProfit() { return this.totalReceived - this.totalPaidOut; } };
const activeBets = new Map();
const userProfiles = new Map();
const betHistory = [];

// ============================================
// NYC CORRECTIONAL FACILITIES (Static Data)
// ============================================

const NYC_FACILITIES = [
  {
    id: 'rikers_island',
    name: 'Rikers Island Complex',
    shortName: 'Rikers',
    type: 'jail',
    borough: 'Queens',
    lat: 40.7932,
    lng: -73.8860,
    capacity: 10000,
    currentPopulation: 4800,
    avgDailyReleases: 95,
    releaseHours: '6:00 AM - 8:00 AM',
    subFacilities: [
      'Anna M. Kross Center (AMKC)',
      'Eric M. Taylor Center (EMTC)',
      'George R. Vierno Center (GRVC)',
      'Otis Bantum Correctional Center (OBCC)',
      'Robert N. Davoren Center (RNDC)',
      'Rose M. Singer Center (RMSC) - Women'
    ],
    hasQ100: true,
    notes: 'Main NYC jail complex. Q100 bus is only public transit access.'
  },
  {
    id: 'manhattan_detention',
    name: 'Manhattan Detention Complex',
    shortName: 'The Tombs',
    type: 'jail',
    borough: 'Manhattan',
    lat: 40.7142,
    lng: -74.0010,
    capacity: 898,
    currentPopulation: 680,
    avgDailyReleases: 25,
    releaseHours: '6:00 AM - 10:00 AM',
    subFacilities: [],
    hasQ100: false,
    notes: 'Located at 125 White Street. Near multiple subway lines.'
  },
  {
    id: 'brooklyn_detention',
    name: 'Brooklyn Detention Complex',
    shortName: 'Brooklyn MDC',
    type: 'jail',
    borough: 'Brooklyn',
    lat: 40.6912,
    lng: -73.9866,
    capacity: 759,
    currentPopulation: 590,
    avgDailyReleases: 18,
    releaseHours: '6:00 AM - 10:00 AM',
    subFacilities: [],
    hasQ100: false,
    notes: 'Located at 275 Atlantic Avenue.'
  },
  {
    id: 'vernon_bain',
    name: 'Vernon C. Bain Center',
    shortName: 'The Boat',
    type: 'jail',
    borough: 'Bronx',
    lat: 40.8054,
    lng: -73.8796,
    capacity: 800,
    currentPopulation: 650,
    avgDailyReleases: 12,
    releaseHours: '6:00 AM - 8:00 AM',
    subFacilities: [],
    hasQ100: false,
    notes: 'Floating detention center (barge) in the East River.'
  },
  {
    id: 'queens_detention',
    name: 'Queens Detention Facility',
    shortName: 'Queens',
    type: 'jail',
    borough: 'Queens',
    lat: 40.7282,
    lng: -73.8303,
    capacity: 500,
    currentPopulation: 320,
    avgDailyReleases: 10,
    releaseHours: '6:00 AM - 10:00 AM',
    subFacilities: [],
    hasQ100: false,
    notes: 'Located in Kew Gardens.'
  }
];

// Q100 Bus Schedule Calculator (Rikers Island only)
function getQ100Schedule(count = 5) {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  
  // Peak hours during release time (5 AM - 10 AM)
  const isPeak = hour >= 5 && hour < 10;
  const frequency = isPeak ? 12 : (hour >= 6 && hour < 22 ? 20 : 30);
  
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
      minutesUntil: Math.max(1, minutesUntil),
      isPeak
    });
    
    nextMinute += frequency;
  }
  
  return buses;
}

// Check if during release hours
function isDuringReleaseHours() {
  const hour = new Date().getHours();
  return hour >= 5 && hour <= 10;
}

// Get facility intelligence for a specific facility
function getFacilityIntelligence(facilityId) {
  const facility = NYC_FACILITIES.find(f => f.id === facilityId);
  if (!facility) return null;
  
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  const dayMultipliers = { Sun: 0.75, Mon: 0.95, Tue: 1.0, Wed: 1.05, Thu: 1.1, Fri: 1.2, Sat: 0.85 };
  
  // Estimate today's releases based on day of week
  const estimatedReleases = Math.round(facility.avgDailyReleases * dayMultipliers[dayOfWeek]);
  
  const result = {
    ...facility,
    estimatedReleasesToday: estimatedReleases,
    dayOfWeek,
    releaseWindowActive: isDuringReleaseHours(),
    timestamp: new Date().toISOString()
  };
  
  // Add Q100 data for Rikers only
  if (facility.hasQ100) {
    const nextBuses = getQ100Schedule(5);
    result.q100 = {
      nextBuses,
      nextBusIn: `${nextBuses[0].minutesUntil} min`,
      isPeakTime: nextBuses[0].isPeak,
      route: 'Rikers Island → Queens Plaza',
      note: 'Only public transit to/from Rikers'
    };
  }
  
  return result;
}

// Get all facilities summary
function getAllFacilitiesStatus() {
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  const dayMultipliers = { Sun: 0.75, Mon: 0.95, Tue: 1.0, Wed: 1.05, Thu: 1.1, Fri: 1.2, Sat: 0.85 };
  
  const totalPopulation = NYC_FACILITIES.reduce((sum, f) => sum + f.currentPopulation, 0);
  const totalReleases = NYC_FACILITIES.reduce((sum, f) => 
    sum + Math.round(f.avgDailyReleases * dayMultipliers[dayOfWeek]), 0);
  
  return {
    totalPopulation,
    estimatedReleasesToday: totalReleases,
    dayOfWeek,
    releaseWindowActive: isDuringReleaseHours(),
    releaseWindowHours: '5:00 AM - 10:00 AM',
    facilityCount: NYC_FACILITIES.length,
    timestamp: new Date().toISOString()
  };
}

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
  { id: '40187', name: 'NYPD Citywide 4' },
  { id: '32119', name: 'NYPD Dispatch Citywide 1' },
  { id: '9466', name: 'FDNY Citywide' }, // Fire adds more activity
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
  if (!BROADCASTIFY_PASSWORD) { 
    console.log('[SCANNER] BROADCASTIFY_PASSWORD not set'); 
    return; 
  }
  const feed = NYPD_FEEDS[currentFeedIndex];
  console.log(`[SCANNER] Connecting to: ${feed.name} (${feed.id})`);

  const options = {
    hostname: 'audio.broadcastify.com', port: 443, path: `/${feed.id}.mp3`, method: 'GET',
    auth: `${BROADCASTIFY_USERNAME}:${BROADCASTIFY_PASSWORD}`,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  };

  const req = https.request(options, (res) => {
    console.log(`[SCANNER] Response status: ${res.statusCode}`);
    if (res.statusCode === 401) {
      console.error('[SCANNER] Authentication failed - check BROADCASTIFY_PASSWORD');
      scannerStats.lastError = 'Authentication failed';
      return;
    }
    if (res.statusCode !== 200) {
      console.log(`[SCANNER] Feed ${feed.id} returned ${res.statusCode}, trying next...`);
      currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length;
      setTimeout(startBroadcastifyStream, 5000);
      return;
    }
    handleStream(res, feed);
  });
  req.on('error', (err) => { 
    console.error('[SCANNER] Connection error:', err.message);
    currentFeedIndex = (currentFeedIndex + 1) % NYPD_FEEDS.length; 
    setTimeout(startBroadcastifyStream, 10000); 
  });
  req.end();
}

function handleStream(stream, feed) {
  console.log(`[SCANNER] Connected to ${feed.name}!`);
  scannerStats.currentFeed = feed.name;
  scannerStats.connectedAt = new Date().toISOString();
  let chunks = [];
  let lastDataTime = Date.now();
  
  // Heartbeat - check if stream is still alive every 30 seconds
  const heartbeat = setInterval(() => {
    const silentTime = Date.now() - lastDataTime;
    if (silentTime > 60000) { // No data for 60 seconds
      console.log(`[SCANNER] Stream silent for ${Math.round(silentTime/1000)}s, reconnecting...`);
      clearInterval(heartbeat);
      stream.destroy();
      setTimeout(startBroadcastifyStream, 2000);
    }
  }, 30000);
  
  stream.on('data', (chunk) => {
    lastDataTime = Date.now();
    chunks.push(chunk);
    if (Date.now() - lastProcessTime >= CHUNK_DURATION) {
      const fullBuffer = Buffer.concat(chunks);
      chunks = [];
      lastProcessTime = Date.now();
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.totalChunks++;
      console.log(`[SCANNER] Processing chunk #${scannerStats.totalChunks} (${Math.round(fullBuffer.length/1024)}KB)`);
      processAudioFromStream(fullBuffer, feed.name);
    }
  });
  
  stream.on('end', () => { 
    console.log('[SCANNER] Stream ended, reconnecting...');
    clearInterval(heartbeat);
    setTimeout(startBroadcastifyStream, 2000); 
  });
  stream.on('error', (err) => { 
    console.error('[SCANNER] Stream error:', err.message);
    clearInterval(heartbeat);
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
  } catch (error) { 
    console.error('[WHISPER] Transcription error:', error.message);
    scannerStats.lastError = error.message;
    scannerStats.errorCount = (scannerStats.errorCount || 0) + 1;
    return null; 
  }
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
  if (buffer.length < 5000) {
    scannerStats.filteredSmallBuffer = (scannerStats.filteredSmallBuffer || 0) + 1;
    return;
  }
  
  const transcript = await transcribeAudio(buffer);
  if (!transcript) {
    scannerStats.filteredNoTranscript = (scannerStats.filteredNoTranscript || 0) + 1;
    return;
  }
  if (transcript.trim().length < 10) {
    scannerStats.filteredTooShort = (scannerStats.filteredTooShort || 0) + 1;
    console.log(`[SCANNER] Filtered short transcript: "${transcript.trim()}"`);
    return;
  }
  
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  
  // Filter out noise
  const noise = ['thank you', 'thanks for watching', 'subscribe', 'you', 'bye', 'music'];
  if (noise.some(n => lower === n || lower === n + '.')) {
    scannerStats.filteredNoise = (scannerStats.filteredNoise || 0) + 1;
    console.log(`[SCANNER] Filtered noise: "${clean}"`);
    return;
  }
  if (lower.includes('broadcastify') || lower.includes('fema.gov')) {
    scannerStats.filteredAd = (scannerStats.filteredAd || 0) + 1;
    console.log(`[SCANNER] Filtered ad: "${clean}"`);
    return;
  }
  
  console.log(`[SCANNER] Valid transcript: "${clean.substring(0, 100)}..."`);
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

// ============================================
// DETECTIVE BUREAU ENDPOINTS (Enhanced)
// ============================================

// Overview - Combined stats for all agents
app.get('/detective/overview', (req, res) => {
  res.json(detectiveBureau.getAgentOverview());
});

// All agent statuses (legacy compatible)
app.get('/detective/agents', (req, res) => res.json(detectiveBureau.getAgentStatuses()));

// Individual agent detail
app.get('/detective/agent/:agentId', (req, res) => {
  const { agentId } = req.params;
  const detail = detectiveBureau.getAgentDetail(agentId.toUpperCase());
  if (!detail) return res.status(404).json({ error: 'Agent not found' });
  res.json(detail);
});

// CHASE - Pursuit Specialist endpoints
app.get('/detective/chase', (req, res) => {
  res.json(detectiveBureau.getChaseData());
});

app.get('/detective/chase/history', (req, res) => {
  const { limit = 50 } = req.query;
  res.json({
    history: detectiveBureau.agents.CHASE.history.slice(0, parseInt(limit)),
    stats: detectiveBureau.agents.CHASE.stats
  });
});

app.get('/detective/chase/active', (req, res) => {
  // Get incidents from last 30 minutes that triggered CHASE
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const activePursuits = detectiveBureau.memory.incidents
    .filter(inc => {
      if (inc.timestamp < thirtyMinAgo) return false;
      const text = `${inc.incidentType} ${inc.summary || ''}`.toLowerCase();
      return detectiveBureau.agents.CHASE.triggers.some(t => text.includes(t));
    });
  res.json({ active: activePursuits, count: activePursuits.length });
});

// PATTERN - Serial Crime Analyst endpoints
app.get('/detective/pattern', (req, res) => {
  res.json(detectiveBureau.getPatternData());
});

app.get('/detective/pattern/active', (req, res) => {
  const activePatterns = detectiveBureau.memory.patterns.filter(p => p.status === 'active');
  res.json({
    patterns: activePatterns,
    count: activePatterns.length,
    stats: detectiveBureau.agents.PATTERN.stats
  });
});

app.get('/detective/pattern/:patternId', (req, res) => {
  const { patternId } = req.params;
  const pattern = detectiveBureau.memory.patterns.find(p => p.id === patternId);
  if (!pattern) return res.status(404).json({ error: 'Pattern not found' });
  
  // Get linked incidents
  const linkedIncidents = pattern.linkedIncidentIds
    ? detectiveBureau.memory.incidents.filter(inc => pattern.linkedIncidentIds.includes(inc.id))
    : [];
  
  res.json({ pattern, linkedIncidents });
});

app.get('/detective/patterns', (req, res) => {
  const { status = 'all' } = req.query;
  let patterns = detectiveBureau.getValidPatterns();
  if (status !== 'all') {
    patterns = patterns.filter(p => p.status === status);
  }
  const validPatterns = detectiveBureau.getValidPatterns();
  res.json({ 
    patterns, 
    active: validPatterns.filter(p => p.status === 'active').length,
    total: validPatterns.length 
  });
});

// PROPHET - Predictive Analyst endpoints
app.get('/detective/prophet', (req, res) => {
  res.json(detectiveBureau.getProphetData());
});

app.get('/detective/prophet/predictions', (req, res) => {
  const { status = 'all', limit = 50 } = req.query;
  let predictions = detectiveBureau.memory.predictionHistory;
  
  if (status === 'pending') {
    predictions = detectiveBureau.predictionStats.pending;
  } else if (status === 'hit') {
    predictions = predictions.filter(p => p.outcome === 'hit');
  } else if (status === 'miss') {
    predictions = predictions.filter(p => p.outcome === 'miss');
  }
  
  res.json({
    predictions: predictions.slice(0, parseInt(limit)),
    pending: detectiveBureau.predictionStats.pending.length,
    total: detectiveBureau.predictionStats.total,
    hits: detectiveBureau.predictionStats.correct,
    accuracy: detectiveBureau.getAccuracy()
  });
});

app.get('/detective/prophet/accuracy', (req, res) => {
  const accuracyHistory = detectiveBureau.predictionStats.accuracyHistory;
  const accuracyOverTime = detectiveBureau.calculateAccuracyOverTime();
  
  // Calculate confidence-based accuracy
  const byConfidence = {};
  accuracyHistory.forEach(h => {
    const bucket = Math.floor(h.confidence * 10) / 10; // Round to nearest 0.1
    if (!byConfidence[bucket]) byConfidence[bucket] = { hits: 0, total: 0 };
    byConfidence[bucket].total++;
    if (h.outcome === 'hit') byConfidence[bucket].hits++;
  });
  
  // Calculate by incident type
  const byType = {};
  accuracyHistory.forEach(h => {
    const type = h.type?.toLowerCase() || 'unknown';
    if (!byType[type]) byType[type] = { hits: 0, total: 0 };
    byType[type].total++;
    if (h.outcome === 'hit') byType[type].hits++;
  });
  
  res.json({
    overall: {
      total: detectiveBureau.predictionStats.total,
      hits: detectiveBureau.predictionStats.correct,
      accuracy: detectiveBureau.getAccuracy()
    },
    overTime: accuracyOverTime,
    byConfidence: Object.entries(byConfidence).map(([conf, data]) => ({
      confidence: parseFloat(conf),
      accuracy: data.total > 0 ? (data.hits / data.total * 100).toFixed(1) : '0',
      hits: data.hits,
      total: data.total
    })),
    byType: Object.entries(byType).map(([type, data]) => ({
      type,
      accuracy: data.total > 0 ? (data.hits / data.total * 100).toFixed(1) : '0',
      hits: data.hits,
      total: data.total
    })),
    recentHistory: accuracyHistory.slice(0, 30)
  });
});

// Manual prediction feedback (for testing/calibration)
app.post('/detective/prophet/feedback', (req, res) => {
  const { predictionId, outcome, matchedIncidentId } = req.body;
  if (!predictionId || !['hit', 'miss'].includes(outcome)) {
    return res.status(400).json({ error: 'predictionId and outcome (hit/miss) required' });
  }
  
  // Find pending prediction
  const idx = detectiveBureau.predictionStats.pending.findIndex(p => p.id === predictionId);
  if (idx === -1) return res.status(404).json({ error: 'Pending prediction not found' });
  
  const prediction = detectiveBureau.predictionStats.pending.splice(idx, 1)[0];
  prediction.status = outcome;
  prediction.manualFeedback = true;
  
  if (outcome === 'hit') {
    detectiveBureau.predictionStats.correct++;
    detectiveBureau.agents.PROPHET.stats.hits++;
    prediction.matchedIncidentId = matchedIncidentId;
  } else {
    detectiveBureau.agents.PROPHET.stats.misses++;
  }
  
  // Update history
  const historyEntry = detectiveBureau.memory.predictionHistory.find(h => h.id === predictionId);
  if (historyEntry) {
    historyEntry.outcome = outcome;
    historyEntry.manualFeedback = true;
    historyEntry.resolvedAt = new Date().toISOString();
  }
  
  detectiveBureau.recordAccuracy(outcome, prediction);
  
  res.json({ success: true, prediction, newAccuracy: detectiveBureau.getAccuracy() });
});

app.get('/detective/predictions', (req, res) => res.json(detectiveBureau.getPredictionStats()));

// HISTORIAN - Historical Context endpoints
app.get('/detective/historian', (req, res) => {
  res.json(detectiveBureau.getHistorianData());
});

app.get('/detective/historian/hotspots', (req, res) => {
  const { limit = 50, minCount = 2 } = req.query;
  const hotspots = Array.from(detectiveBureau.memory.hotspots.entries())
    .filter(([_, count]) => count >= parseInt(minCount))
    .sort((a, b) => b[1] - a[1])
    .slice(0, parseInt(limit))
    .map(([key, count]) => {
      const [borough, location] = key.split('-');
      return { borough, location, count };
    });
  res.json({ hotspots, total: detectiveBureau.memory.hotspots.size });
});

app.get('/detective/historian/address/:address', (req, res) => {
  const { address } = req.params;
  const addressKey = address.toLowerCase();
  const count = detectiveBureau.memory.addressHistory.get(addressKey) || 0;
  
  // Get all incidents at this address
  const incidentsAtAddress = detectiveBureau.memory.incidents.filter(
    inc => inc.location?.toLowerCase() === addressKey
  );
  
  // Get insights about this address
  const insights = detectiveBureau.memory.agentInsights.filter(
    ai => ai.insights?.some(i => 
      i.agent === 'HISTORIAN' && 
      detectiveBureau.memory.incidents.find(inc => inc.id === ai.incidentId)?.location?.toLowerCase() === addressKey
    )
  );
  
  res.json({
    address,
    totalCalls: count,
    incidents: incidentsAtAddress,
    insights: insights.slice(0, 10)
  });
});

app.get('/detective/hotspots', (req, res) => {
  const hotspots = Array.from(detectiveBureau.memory.hotspots.entries()).map(([key, count]) => {
    const [borough, location] = key.split('-');
    return { borough, location, count };
  }).sort((a, b) => b.count - a.count).slice(0, 50);
  res.json(hotspots);
});

// Collaboration endpoints
app.get('/detective/collaboration', (req, res) => {
  res.json(detectiveBureau.getCollaborationData());
});

app.get('/detective/collaboration/graph', (req, res) => {
  // Return data formatted for visualization (nodes + edges)
  const agents = Object.values(detectiveBureau.agents).map(a => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    role: a.role,
    activations: a.stats.activations
  }));
  
  const collaborations = detectiveBureau.memory.collaborations;
  const edgeCounts = {};
  
  collaborations.forEach(c => {
    const key = `${c.sourceAgent}-${c.targetAgent}`;
    edgeCounts[key] = (edgeCounts[key] || 0) + 1;
  });
  
  const edges = Object.entries(edgeCounts).map(([key, count]) => {
    const [source, target] = key.split('-');
    return { source, target, weight: count };
  });
  
  res.json({ nodes: agents, edges });
});

// Briefing and general queries
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

// Consult a specific agent
app.post('/detective/consult/:agentId', async (req, res) => {
  const { agentId } = req.params;
  const { question, context = {} } = req.body;
  if (!question) return res.status(400).json({ error: 'Question required' });
  
  const response = await detectiveBureau.consultAgent(agentId.toUpperCase(), question, context);
  if (!response) return res.status(404).json({ error: 'Agent not found or error occurred' });
  
  res.json({ 
    agent: agentId.toUpperCase(), 
    response, 
    timestamp: new Date().toISOString() 
  });
});

// Force PROPHET to make predictions now (for testing)
app.post('/detective/prophet/predict', async (req, res) => {
  await detectiveBureau.runProphet();
  res.json({
    success: true,
    pending: detectiveBureau.predictionStats.pending,
    message: 'PROPHET analysis triggered'
  });
});

// Memory/data export for future training
app.get('/detective/export', (req, res) => {
  const { type = 'all' } = req.query;
  
  const data = {
    exportedAt: new Date().toISOString(),
    incidents: type === 'all' || type === 'incidents' ? detectiveBureau.memory.incidents : undefined,
    patterns: type === 'all' || type === 'patterns' ? detectiveBureau.memory.patterns : undefined,
    predictions: type === 'all' || type === 'predictions' ? detectiveBureau.memory.predictionHistory : undefined,
    agentInsights: type === 'all' || type === 'insights' ? detectiveBureau.memory.agentInsights : undefined,
    collaborations: type === 'all' || type === 'collaborations' ? detectiveBureau.memory.collaborations : undefined,
    stats: {
      totalIncidents: detectiveBureau.memory.incidents.length,
      totalPatterns: detectiveBureau.memory.patterns.length,
      totalPredictions: detectiveBureau.predictionStats.total,
      predictionAccuracy: detectiveBureau.getAccuracy(),
      agentStats: Object.fromEntries(
        Object.entries(detectiveBureau.agents).map(([k, v]) => [k, v.stats])
      )
    }
  };
  
  res.json(data);
});

// Maintenance: Clean up invalid patterns from memory
app.post('/detective/cleanup', (req, res) => {
  const before = detectiveBureau.memory.patterns.length;
  
  // Remove invalid patterns
  detectiveBureau.memory.patterns = detectiveBureau.memory.patterns.filter(p => 
    p.patternName && 
    p.patternName.trim() !== '' &&
    p.patternName.toLowerCase() !== 'unknown pattern' &&
    p.patternName.toLowerCase() !== 'unknown' &&
    p.incidentCount > 0
  );
  
  const after = detectiveBureau.memory.patterns.length;
  const removed = before - after;
  
  console.log(`[CLEANUP] Removed ${removed} invalid patterns`);
  
  res.json({ 
    success: true, 
    removed, 
    before, 
    after,
    message: `Cleaned up ${removed} invalid patterns`
  });
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
  const types = ['any', 'assault', 'robbery', 'theft', 'pursuit', 'shots fired'];
  const odds = {};
  boroughs.forEach(b => { odds[b] = {}; types.forEach(t => { odds[b][t] = oddsEngine.getOdds(b, t, parseInt(window)); }); });
  
  // Calculate summary stats
  const allOdds = boroughs.flatMap(b => types.map(t => odds[b][t]));
  const avgMultiplier = allOdds.reduce((s, o) => s + o.multiplier, 0) / allOdds.length;
  
  res.json({ 
    timestamp: new Date().toISOString(), 
    windowMinutes: parseInt(window), 
    houseEdge: `${HOUSE_EDGE * 100}%`,
    currentHour: new Date().getHours(),
    summary: {
      avgMultiplier: Math.round(avgMultiplier * 10) / 10,
      lowestOdds: allOdds.reduce((min, o) => o.multiplier < min.multiplier ? o : min),
      highestOdds: allOdds.reduce((max, o) => o.multiplier > max.multiplier ? o : max)
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

// Facility endpoints
app.get('/facilities', (req, res) => {
  res.json({
    facilities: NYC_FACILITIES,
    status: getAllFacilitiesStatus(),
    timestamp: new Date().toISOString()
  });
});

app.get('/facilities/list', (req, res) => {
  res.json(NYC_FACILITIES.map(f => ({
    id: f.id,
    name: f.name,
    shortName: f.shortName,
    borough: f.borough,
    lat: f.lat,
    lng: f.lng,
    currentPopulation: f.currentPopulation
  })));
});

app.get('/facilities/status', (req, res) => {
  res.json(getAllFacilitiesStatus());
});

app.get('/facilities/q100', (req, res) => {
  const buses = getQ100Schedule(10);
  res.json({
    route: 'Q100 - Rikers Island to Queens Plaza',
    description: 'Only public transit to/from Rikers Island',
    nextBuses: buses,
    nextBusIn: `${buses[0].minutesUntil} min`,
    isPeakTime: buses[0].isPeak,
    peakHours: '5:00 AM - 10:00 AM',
    frequency: buses[0].isPeak ? 'Every 10-12 min' : 'Every 20-30 min'
  });
});

// Get incidents near all facilities
app.get('/facilities/nearby-incidents', (req, res) => {
  const radiusKm = parseFloat(req.query.radius) || 1;
  
  const result = NYC_FACILITIES.map(facility => {
    // Find incidents within radius
    const nearbyIncidents = incidents.filter(inc => {
      if (!inc.lat || !inc.lng) return false;
      const distance = Math.sqrt(
        Math.pow((facility.lat - inc.lat) * 111, 2) +
        Math.pow((facility.lng - inc.lng) * 85, 2)
      );
      return distance <= radiusKm;
    });
    
    return {
      facilityId: facility.id,
      facilityName: facility.shortName,
      lat: facility.lat,
      lng: facility.lng,
      incidentCount: nearbyIncidents.length,
      incidents: nearbyIncidents.slice(0, 10).map(i => ({
        id: i.id,
        type: i.incidentType,
        location: i.location,
        timestamp: i.timestamp,
        priority: i.priority
      }))
    };
  });
  
  res.json({
    radiusKm,
    facilities: result,
    totalNearbyIncidents: result.reduce((sum, f) => sum + f.incidentCount, 0),
    timestamp: new Date().toISOString()
  });
});

// Q100 Live Bus Tracking (MTA BusTime API)
// Note: For production, get free API key from https://bustime.mta.info/wiki/Developers/Index
const MTA_API_KEY = process.env.MTA_API_KEY || null;

// Q100 Route Polyline - actual route from Rikers to Queens Plaza via Hazen St Bridge
const Q100_ROUTE = {
  name: 'Q100',
  description: 'Rikers Island to Queens Plaza - Only public transit to/from Rikers',
  origin: { name: 'Rikers Island Bus Depot', lat: 40.7932, lng: -73.8860 },
  destination: { name: 'Queens Plaza', lat: 40.7505, lng: -73.9375 },
  // Key stops along the route
  stops: [
    { name: 'Rikers Island', lat: 40.7932, lng: -73.8860, isTerminal: true },
    { name: 'Hazen St/19 Ave', lat: 40.7780, lng: -73.8880 },
    { name: '19 Ave/Hazen St', lat: 40.7750, lng: -73.8920 },
    { name: 'Astoria Blvd/94 St', lat: 40.7680, lng: -73.8950 },
    { name: '31 Ave/83 St', lat: 40.7620, lng: -73.9050 },
    { name: 'Northern Blvd/69 St', lat: 40.7560, lng: -73.9150 },
    { name: 'Broadway/Steinway St', lat: 40.7540, lng: -73.9250 },
    { name: 'Queens Plaza', lat: 40.7505, lng: -73.9375, isTerminal: true }
  ],
  // Simplified route polyline for map display
  polyline: [
    [40.7932, -73.8860], // Rikers Island
    [40.7910, -73.8850], // Bridge approach
    [40.7870, -73.8865], // Hazen St Bridge
    [40.7820, -73.8875], // Bridge exit
    [40.7780, -73.8880], // Hazen St
    [40.7750, -73.8920], // Turn onto 19 Ave
    [40.7700, -73.8940], // 19 Ave
    [40.7680, -73.8950], // Astoria Blvd
    [40.7650, -73.9000], // Continuing
    [40.7620, -73.9050], // 31 Ave
    [40.7590, -73.9100], // Approaching Northern
    [40.7560, -73.9150], // Northern Blvd
    [40.7540, -73.9200], // Broadway
    [40.7530, -73.9250], // Near Steinway
    [40.7515, -73.9320], // Approaching Queens Plaza
    [40.7505, -73.9375]  // Queens Plaza Terminal
  ],
  // Rikers Island Bridge coordinates for highlighting
  bridge: {
    start: [40.7910, -73.8850],
    end: [40.7820, -73.8875],
    name: 'Francis R. Buono Memorial Bridge'
  },
  // Estimated travel time
  travelTimeMinutes: {
    toRikers: 25,
    fromRikers: 25
  }
};

// Calculate distance between two points
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Estimate ETA to Rikers based on bus position
function estimateETAToRikers(busLat, busLng, direction) {
  // Direction: 0 = heading to Queens Plaza (away from Rikers), 1 = heading to Rikers
  const rikersLat = Q100_ROUTE.origin.lat;
  const rikersLng = Q100_ROUTE.origin.lng;
  const queensLat = Q100_ROUTE.destination.lat;
  const queensLng = Q100_ROUTE.destination.lng;
  
  const distToRikers = haversineDistance(busLat, busLng, rikersLat, rikersLng);
  const distToQueens = haversineDistance(busLat, busLng, queensLat, queensLng);
  
  // Total route distance ~7km
  const totalRouteKm = 7;
  const avgSpeedKmh = 18; // Average bus speed with stops
  
  if (direction === '1' || direction === 1) {
    // Heading TO Rikers - direct ETA
    const etaMinutes = Math.round((distToRikers / avgSpeedKmh) * 60);
    return { minutes: Math.max(1, etaMinutes), direct: true };
  } else {
    // Heading AWAY from Rikers - needs to complete route and return
    const etaMinutes = Math.round(((distToQueens + totalRouteKm) / avgSpeedKmh) * 60);
    return { minutes: Math.max(1, etaMinutes), direct: false };
  }
}

app.get('/facilities/q100/live', async (req, res) => {
  const schedule = getQ100Schedule(5);
  const baseResponse = {
    route: Q100_ROUTE,
    schedule,
    nextBusIn: `${schedule[0].minutesUntil} min`,
    isPeakTime: schedule[0].isPeak,
    frequency: schedule[0].isPeak ? 'Every 10-12 min' : 'Every 20-30 min',
    timestamp: new Date().toISOString()
  };

  // Return schedule-based data if no MTA API key
  if (!MTA_API_KEY) {
    return res.json({
      ...baseResponse,
      live: false,
      message: 'Live tracking unavailable - add MTA_API_KEY for real-time bus positions',
      buses: [],
      busCount: 0
    });
  }
  
  try {
    // MTA BusTime SIRI API
    const response = await fetch(
      `https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=${MTA_API_KEY}&LineRef=Q100&VehicleMonitoringDetailLevel=calls`,
      { timeout: 5000 }
    );
    
    if (!response.ok) throw new Error('MTA API error');
    
    const data = await response.json();
    const vehicles = data?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery?.[0]?.VehicleActivity || [];
    
    const buses = vehicles.map(v => {
      const journey = v.MonitoredVehicleJourney;
      const location = journey?.VehicleLocation;
      const call = journey?.MonitoredCall;
      const direction = journey?.DirectionRef;
      
      const lat = parseFloat(location?.Latitude);
      const lng = parseFloat(location?.Longitude);
      
      // Calculate ETA to Rikers
      const eta = (lat && lng) ? estimateETAToRikers(lat, lng, direction) : null;
      
      return {
        vehicleId: journey?.VehicleRef,
        lat,
        lng,
        direction, // 0 = to Queens Plaza, 1 = to Rikers
        directionLabel: direction === '1' || direction === 1 ? 'To Rikers' : 'To Queens Plaza',
        bearing: parseFloat(journey?.Bearing) || null,
        nextStop: call?.StopPointName,
        expectedArrival: call?.ExpectedArrivalTime,
        distanceFromStop: call?.DistanceFromStop,
        progressRate: journey?.ProgressRate,
        etaToRikers: eta
      };
    }).filter(b => b.lat && b.lng);
    
    // Sort by ETA to Rikers (buses heading there first)
    buses.sort((a, b) => {
      if (a.direction !== b.direction) {
        return (a.direction === '1' || a.direction === 1) ? -1 : 1;
      }
      return (a.etaToRikers?.minutes || 999) - (b.etaToRikers?.minutes || 999);
    });
    
    res.json({
      ...baseResponse,
      live: true,
      buses,
      busCount: buses.length,
      busesToRikers: buses.filter(b => b.direction === '1' || b.direction === 1).length,
      busesToQueens: buses.filter(b => b.direction === '0' || b.direction === 0).length,
      nextBusToRikers: buses.find(b => b.direction === '1' || b.direction === 1) || null
    });
    
  } catch (error) {
    console.error('[Q100] Live tracking error:', error.message);
    res.json({
      ...baseResponse,
      live: false,
      error: error.message,
      buses: [],
      busCount: 0
    });
  }
});

// Dedicated route info endpoint
app.get('/facilities/q100/route', (req, res) => {
  res.json(Q100_ROUTE);
});

// ============================================
// NYC OPEN DATA - DAILY INMATES IN CUSTODY
// ============================================
// Source: https://data.cityofnewyork.us/Public-Safety/Daily-Inmates-In-Custody/7479-ugqb
// No API key required - public dataset

const NYC_OPENDATA_INMATES_URL = 'https://data.cityofnewyork.us/resource/7479-ugqb.json';

// Cache for inmate data (refresh every 6 hours - data updates daily)
let inmateDataCache = null;
let inmateDataCacheTime = 0;
const INMATE_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours

async function fetchInmateData() {
  const now = Date.now();
  
  // Return cached data if fresh
  if (inmateDataCache && (now - inmateDataCacheTime) < INMATE_CACHE_DURATION) {
    return inmateDataCache;
  }
  
  try {
    // Fetch with limit - dataset can be large
    const response = await fetch(`${NYC_OPENDATA_INMATES_URL}?$limit=50000`, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) throw new Error('NYC Open Data API error');
    
    const data = await response.json();
    inmateDataCache = data;
    inmateDataCacheTime = now;
    
    console.log(`[INMATES] Fetched ${data.length} inmate records from NYC Open Data`);
    return data;
    
  } catch (error) {
    console.error('[INMATES] Fetch error:', error.message);
    return inmateDataCache || []; // Return stale cache if available
  }
}

// Aggregate inmate stats
function aggregateInmateStats(inmates) {
  const stats = {
    total: inmates.length,
    byGender: {},
    byRace: {},
    byAge: { '18-25': 0, '26-35': 0, '36-45': 0, '46-55': 0, '56+': 0 },
    byCustodyLevel: {},
    byMentalHealth: {},
    byTopCharge: {},
    bySecurityRiskGroup: { yes: 0, no: 0 },
    byLegalStatus: {}
  };
  
  inmates.forEach(inmate => {
    // Gender
    const gender = inmate.gender || 'Unknown';
    stats.byGender[gender] = (stats.byGender[gender] || 0) + 1;
    
    // Race
    const race = inmate.race || 'Unknown';
    stats.byRace[race] = (stats.byRace[race] || 0) + 1;
    
    // Age brackets
    const age = parseInt(inmate.age) || 0;
    if (age >= 18 && age <= 25) stats.byAge['18-25']++;
    else if (age >= 26 && age <= 35) stats.byAge['26-35']++;
    else if (age >= 36 && age <= 45) stats.byAge['36-45']++;
    else if (age >= 46 && age <= 55) stats.byAge['46-55']++;
    else if (age >= 56) stats.byAge['56+']++;
    
    // Custody Level
    const custody = inmate.custody_level || 'Unknown';
    stats.byCustodyLevel[custody] = (stats.byCustodyLevel[custody] || 0) + 1;
    
    // Mental Health
    const mental = inmate.bradh || inmate.mental_designation || 'None';
    stats.byMentalHealth[mental] = (stats.byMentalHealth[mental] || 0) + 1;
    
    // Top Charge (limit to top 20)
    const charge = inmate.top_charge || 'Unknown';
    stats.byTopCharge[charge] = (stats.byTopCharge[charge] || 0) + 1;
    
    // Security Risk Group
    const srg = (inmate.srg_flg === 'Y' || inmate.srg_flg === 'Yes') ? 'yes' : 'no';
    stats.bySecurityRiskGroup[srg]++;
    
    // Legal Status
    const legal = inmate.legal_status || 'Unknown';
    stats.byLegalStatus[legal] = (stats.byLegalStatus[legal] || 0) + 1;
  });
  
  // Sort and limit top charges to top 15
  stats.byTopCharge = Object.fromEntries(
    Object.entries(stats.byTopCharge)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
  );
  
  return stats;
}

// Main inmate population endpoint
app.get('/facilities/inmates', async (req, res) => {
  try {
    const inmates = await fetchInmateData();
    const stats = aggregateInmateStats(inmates);
    
    res.json({
      source: 'NYC Open Data - Daily Inmates In Custody',
      datasetId: '7479-ugqb',
      lastUpdated: new Date(inmateDataCacheTime).toISOString(),
      stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Detailed breakdown endpoint
app.get('/facilities/inmates/breakdown', async (req, res) => {
  try {
    const inmates = await fetchInmateData();
    const { field = 'race' } = req.query;
    
    const validFields = ['gender', 'race', 'custody_level', 'top_charge', 'legal_status', 'bradh', 'age'];
    if (!validFields.includes(field)) {
      return res.status(400).json({ error: `Invalid field. Valid: ${validFields.join(', ')}` });
    }
    
    const breakdown = {};
    inmates.forEach(inmate => {
      let value = inmate[field] || 'Unknown';
      if (field === 'age') {
        const age = parseInt(value) || 0;
        if (age >= 18 && age <= 25) value = '18-25';
        else if (age >= 26 && age <= 35) value = '26-35';
        else if (age >= 36 && age <= 45) value = '36-45';
        else if (age >= 46 && age <= 55) value = '46-55';
        else if (age >= 56) value = '56+';
        else value = 'Unknown';
      }
      breakdown[value] = (breakdown[value] || 0) + 1;
    });
    
    // Sort by count descending
    const sorted = Object.entries(breakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        count,
        percent: ((count / inmates.length) * 100).toFixed(1)
      }));
    
    res.json({
      field,
      total: inmates.length,
      breakdown: sorted,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Top charges endpoint
app.get('/facilities/inmates/charges', async (req, res) => {
  try {
    const inmates = await fetchInmateData();
    const limit = parseInt(req.query.limit) || 20;
    
    const charges = {};
    inmates.forEach(inmate => {
      const charge = inmate.top_charge || 'Unknown';
      charges[charge] = (charges[charge] || 0) + 1;
    });
    
    const sorted = Object.entries(charges)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([charge, count]) => ({
        charge,
        count,
        percent: ((count / inmates.length) * 100).toFixed(1)
      }));
    
    res.json({
      total: inmates.length,
      topCharges: sorted,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Demographics summary for dashboard cards
app.get('/facilities/inmates/demographics', async (req, res) => {
  try {
    const inmates = await fetchInmateData();
    
    // Quick demographic summary
    const genderCounts = {};
    const raceCounts = {};
    let mentalHealthCount = 0;
    let srgCount = 0;
    let avgAge = 0;
    
    inmates.forEach(inmate => {
      // Gender
      const g = inmate.gender || 'Unknown';
      genderCounts[g] = (genderCounts[g] || 0) + 1;
      
      // Race
      const r = inmate.race || 'Unknown';
      raceCounts[r] = (raceCounts[r] || 0) + 1;
      
      // Mental health (has designation)
      if (inmate.bradh && inmate.bradh !== 'NO' && inmate.bradh !== 'N') {
        mentalHealthCount++;
      }
      
      // Security risk group
      if (inmate.srg_flg === 'Y' || inmate.srg_flg === 'Yes') {
        srgCount++;
      }
      
      // Age
      avgAge += parseInt(inmate.age) || 0;
    });
    
    avgAge = Math.round(avgAge / inmates.length);
    
    res.json({
      population: inmates.length,
      gender: genderCounts,
      race: raceCounts,
      mentalHealthDesignation: {
        count: mentalHealthCount,
        percent: ((mentalHealthCount / inmates.length) * 100).toFixed(1)
      },
      securityRiskGroup: {
        count: srgCount,
        percent: ((srgCount / inmates.length) * 100).toFixed(1)
      },
      averageAge: avgAge,
      dataSource: 'NYC Open Data',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Facilities summary for dashboard
app.get('/facilities/summary', (req, res) => {
  const hour = new Date().getHours();
  const releaseWindowActive = hour >= 5 && hour <= 10;
  
  const totalPopulation = NYC_FACILITIES.reduce((sum, f) => sum + f.currentPopulation, 0);
  const totalCapacity = NYC_FACILITIES.reduce((sum, f) => sum + f.capacity, 0);
  
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  const dayMultipliers = { Sun: 0.75, Mon: 0.95, Tue: 1.0, Wed: 1.05, Thu: 1.1, Fri: 1.2, Sat: 0.85 };
  
  const totalEstimatedReleases = NYC_FACILITIES.reduce((sum, f) => {
    return sum + Math.round(f.avgDailyReleases * dayMultipliers[dayOfWeek]);
  }, 0);
  
  const q100 = getQ100Schedule(1)[0];
  
  res.json({
    totalPopulation,
    totalCapacity,
    capacityPercent: Math.round((totalPopulation / totalCapacity) * 100),
    estimatedReleasesToday: totalEstimatedReleases,
    dayOfWeek,
    releaseWindow: {
      active: releaseWindowActive,
      status: releaseWindowActive ? 'ACTIVE' : 'CLOSED',
      hours: '5:00 AM - 10:00 AM',
      progress: releaseWindowActive ? Math.round(((hour - 5) / 5) * 100) : 0
    },
    q100: {
      nextBusIn: `${q100.minutesUntil} min`,
      isPeak: q100.isPeak
    },
    facilityCount: NYC_FACILITIES.length,
    timestamp: new Date().toISOString()
  });
});

// Facility by ID - MUST BE LAST (catches all /facilities/:anything)
app.get('/facilities/:id', (req, res) => {
  const intel = getFacilityIntelligence(req.params.id);
  if (!intel) {
    return res.status(404).json({ error: 'Facility not found' });
  }
  res.json(intel);
});

// Core endpoints
app.get('/', (req, res) => res.json({ name: "DISPATCH NYC", status: "operational", connections: clients.size, incidents: incidents.length, agents: detectiveBureau.getAgentStatuses(), predictionAccuracy: detectiveBureau.getAccuracy() }));
app.get('/cameras', (req, res) => res.json(cameras));
app.get('/incidents', (req, res) => res.json(incidents));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/audio/:id', (req, res) => { const buffer = audioClips.get(req.params.id); if (!buffer) return res.status(404).json({ error: 'Not found' }); res.set('Content-Type', 'audio/mpeg'); res.send(buffer); });
app.get('/camera-image/:id', async (req, res) => { try { const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`); const buffer = await response.arrayBuffer(); res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(buffer)); } catch (e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/stream/feeds', (req, res) => res.json({ feeds: NYPD_FEEDS, currentFeed: NYPD_FEEDS[currentFeedIndex], streamUrl: '/stream/live' }));
app.get('/debug', (req, res) => res.json({ 
  scanner: {
    ...scannerStats,
    feedIndex: currentFeedIndex,
    feeds: NYPD_FEEDS.map(f => f.name),
    uptime: process.uptime()
  }, 
  connections: clients.size, 
  incidents: incidents.length, 
  cameras: cameras.length, 
  agents: detectiveBureau.getAgentStatuses(), 
  predictions: detectiveBureau.getPredictionStats() 
}));

// Scanner control endpoints
app.post('/scanner/restart', (req, res) => {
  console.log('[SCANNER] Manual restart triggered');
  scannerStats.manualRestarts = (scannerStats.manualRestarts || 0) + 1;
  startBroadcastifyStream();
  res.json({ success: true, message: 'Scanner restart triggered', stats: scannerStats });
});

app.get('/scanner/status', (req, res) => {
  const lastChunk = scannerStats.lastChunkTime ? new Date(scannerStats.lastChunkTime) : null;
  const silentSeconds = lastChunk ? Math.round((Date.now() - lastChunk.getTime()) / 1000) : null;
  
  res.json({
    ...scannerStats,
    currentFeed: NYPD_FEEDS[currentFeedIndex],
    silentSeconds,
    isHealthy: silentSeconds !== null && silentSeconds < 60,
    successRate: scannerStats.totalChunks > 0 
      ? ((scannerStats.successfulTranscripts / scannerStats.totalChunks) * 100).toFixed(1) + '%'
      : '0%'
  });
});

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
    predictions: detectiveBureau.getPredictionStats(),
    facilities: NYC_FACILITIES.map(f => ({
      id: f.id,
      name: f.name,
      shortName: f.shortName,
      borough: f.borough,
      lat: f.lat,
      lng: f.lng,
      currentPopulation: f.currentPopulation
    })),
    facilityStatus: getAllFacilitiesStatus()
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
