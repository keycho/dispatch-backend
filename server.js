import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import https from 'https';
import fs from 'fs';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { toFile } from 'openai';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

// ============================================
// DATABASE CONNECTION
// ============================================

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

if (pool) {
  console.log('[DATABASE] PostgreSQL connection configured');
} else {
  console.log('[DATABASE] No DATABASE_URL - running without persistent storage');
}

// ============================================
// MULTI-CITY CONFIGURATION
// ============================================

const CITIES = {
  nyc: {
    id: 'nyc',
    name: 'New York City',
    shortName: 'NYC',
    state: 'NY',
    mapCenter: { lat: 40.7128, lng: -74.0060 },
    mapZoom: 11,
    openmhz: { system: 'nypd', name: 'NYPD' },
    broadcastifyFeeds: [
      { id: '40184', name: 'NYPD Citywide 1' },
      { id: '40185', name: 'NYPD Citywide 2' },
      { id: '40186', name: 'NYPD Citywide 3' },
      { id: '32119', name: 'NYPD Dispatch Citywide' },
    ],
    cameraApi: 'https://webcams.nyctmc.org/api/cameras',
    districts: ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'],
    landmarks: [
      'Times Square', 'Penn Station', 'Grand Central', 'Port Authority', 'Lincoln Tunnel',
      'Holland Tunnel', 'Brooklyn Bridge', 'Manhattan Bridge', 'Williamsburg Bridge',
      'Central Park', 'Prospect Park', 'Harlem', 'SoHo', 'Tribeca', 'Chinatown',
    ],
    color: '#FF6B35', // Orange
  },
  mpls: {
    id: 'mpls',
    name: 'Minneapolis',
    shortName: 'MPLS', 
    state: 'MN',
    mapCenter: { lat: 44.9778, lng: -93.2650 },
    mapZoom: 12,
    openmhz: { system: 'mnhennco', name: 'Hennepin County' },
    broadcastifyFeeds: [
      { id: '13544', name: 'Minneapolis Police' },
      { id: '26049', name: 'Hennepin County Sheriff' },
      { id: '30435', name: 'Hennepin County Fire/EMS' },
      { id: '741', name: 'Minneapolis Fire' },
    ],
    cameraApi: 'https://511mn.org/api/getcameras', // MnDOT API
    districts: ['Downtown', 'North', 'Northeast', 'Southeast', 'South', 'Southwest', 'Calhoun-Isles', 'Camden', 'Near North', 'Phillips', 'Powderhorn', 'Nokomis', 'Longfellow'],
    landmarks: [
      'Target Center', 'US Bank Stadium', 'Mall of America', 'Minneapolis Convention Center',
      'Hennepin Avenue', 'Lake Street', 'Nicollet Mall', 'Stone Arch Bridge',
      'University of Minnesota', 'Minneapolis-Saint Paul Airport', 'Lake Calhoun', 'Lake Harriet',
    ],
    color: '#4ECDC4', // Teal
  }
};

// Per-city state storage
const cityState = {};
Object.keys(CITIES).forEach(cityId => {
  cityState[cityId] = {
    cameras: [],
    incidents: [],
    recentTranscripts: [],
    incidentId: 0,
    activeStreams: new Map(),
    streamState: new Map(),
    scannerStats: {
      activeFeeds: [],
      lastChunkTime: null,
      lastTranscript: null,
      totalChunks: 0,
      successfulTranscripts: 0,
      feedStats: {}
    },
    openMHzStats: { callsFetched: 0, callsProcessed: 0, lastPoll: null, errors: 0, disabled: false, method: null },
    lastOpenMHzTime: Date.now() - (5 * 60 * 1000), // Start 5 min ago
    clients: new Set(), // WebSocket clients subscribed to this city
    recentTranscriptHashes: new Set() // Track recent transcripts to prevent duplicates
  };
});

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

const MEMORY_BASE_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const MEMORY_SAVE_INTERVAL = 60000; // Save every minute

function getMemoryFile(cityId = 'nyc') {
  return `${MEMORY_BASE_PATH}/detective_memory_${cityId}.json`;
}

console.log(`[MEMORY] Storage base: ${MEMORY_BASE_PATH}`);
console.log(`[MEMORY] Railway volume: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'NOT CONFIGURED'}`);

function loadMemoryFromDisk(cityId = 'nyc') {
  try {
    const memFile = getMemoryFile(cityId);
    if (fs.existsSync(memFile)) {
      const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      console.log(`[MEMORY-${cityId.toUpperCase()}] Loaded from disk:`, data.incidents?.length || 0, 'incidents,', data.predictionStats?.total || 0, 'predictions');
      return data;
    }
  } catch (error) {
    console.error(`[MEMORY-${cityId.toUpperCase()}] Load error:`, error.message);
  }
  return null;
}

function saveMemoryToDisk(memory, predictionStats, agents, cityId = 'nyc') {
  try {
    const memFile = getMemoryFile(cityId);
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
    fs.writeFileSync(memFile, JSON.stringify(serializable, null, 2));
  } catch (error) {
    console.error(`[MEMORY-${cityId.toUpperCase()}] Save error:`, error.message);
  }
}

// ============================================
// DETECTIVE BUREAU - 4 SPECIALIZED AGENTS
// Enhanced with persistent memory, collaboration, and feedback tracking
// ============================================

class DetectiveBureau {
  constructor(anthropicClient, cityId = 'nyc') {
    this.anthropic = anthropicClient;
    this.cityId = cityId;
    
    const savedMemory = loadMemoryFromDisk(cityId);
    const savedAgentStats = savedMemory?.agentStats || {};
    
    // City-specific knowledge for system prompts
    const cityKnowledge = {
      nyc: {
        streets: 'NYC street topology - one-ways, dead ends, bridge/tunnel access (GW Bridge, Lincoln Tunnel, Holland Tunnel, Brooklyn Bridge)',
        landmarks: 'Times Square, Penn Station, Grand Central, Port Authority, Central Park',
        precincts: 'NYPD precincts 1-123'
      },
      mpls: {
        streets: 'Minneapolis street grid - Lake Street, Hennepin Ave, I-35W, I-94, Highway 55, one-ways in downtown',
        landmarks: 'Target Center, US Bank Stadium, Mall of America, Nicollet Mall, Stone Arch Bridge, University of Minnesota',
        precincts: 'Minneapolis Police precincts 1-5, Hennepin County Sheriff'
      }
    };
    
    const cityInfo = cityKnowledge[cityId] || cityKnowledge.nyc;
    
    this.agents = {
      CHASE: {
        id: 'CHASE',
        name: 'CHASE',
        icon: '🚔',
        role: 'Pursuit Specialist',
        status: 'idle',
        triggers: ['pursuit', 'fled', 'fleeing', 'chase', 'vehicle pursuit', 'on foot', 'running', 'high speed', 'foot pursuit', '10-13'],
        systemPrompt: `You are CHASE, a pursuit specialist AI for ${cityId.toUpperCase()}. You predict escape routes, containment points, and track active pursuits. You know ${cityInfo.streets}. Keep responses to 2-3 sentences. Be tactical and specific.`,
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
      saveMemoryToDisk(this.memory, this.predictionStats, this.agents, this.cityId);
    }, MEMORY_SAVE_INTERVAL);

    this.startProphetCycle();
    this.startPatternCycle();
    this.startHistorianCycle();
    this.startChaseCycle();
    
    console.log(`[DETECTIVE-${this.cityId.toUpperCase()}] Bureau initialized with`, this.memory.incidents.length, 'historical incidents');
  }
  
  // HISTORIAN background training
  startHistorianCycle() {
    // Run every 10 minutes
    setInterval(async () => {
      await this.runHistorianAnalysis();
    }, 10 * 60 * 1000);
    
    // Initial run after 2 minutes
    setTimeout(() => this.runHistorianAnalysis(), 2 * 60 * 1000);
  }
  
  async runHistorianAnalysis() {
    this.agents.HISTORIAN.status = 'analyzing';
    this.agents.HISTORIAN.stats.activations++;
    
    try {
      const addressCounts = Array.from(this.memory.addressHistory.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: this.agents.HISTORIAN.systemPrompt + `\n\nRespond in JSON: { "analysis": "summary", "repeatLocations": [{ "address": "...", "count": N, "concern": "HIGH/MEDIUM/LOW" }], "timePatterns": "description of time-based patterns", "recommendations": ["..."] }`,
        messages: [{
          role: "user",
          content: `Analyze address history for ${this.cityId.toUpperCase()}:
          
ADDRESS FREQUENCY (top 20):
${JSON.stringify(addressCounts)}

TOTAL INCIDENTS IN MEMORY: ${this.memory.incidents.length}

Identify repeat locations, problem areas, and time patterns. What addresses need attention?`
        }]
      });
      
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        this.agents.HISTORIAN.history.unshift({
          timestamp: new Date().toISOString(),
          addressesAnalyzed: addressCounts.length,
          repeatLocations: result.repeatLocations?.length || 0,
          analysis: result.analysis,
          recommendations: result.recommendations
        });
        
        if (this.agents.HISTORIAN.history.length > 100) {
          this.agents.HISTORIAN.history = this.agents.HISTORIAN.history.slice(0, 100);
        }
        
        console.log(`[HISTORIAN-${this.cityId.toUpperCase()}] Analysis complete: ${result.repeatLocations?.length || 0} repeat locations identified`);
      }
    } catch (error) {
      console.error(`[HISTORIAN-${this.cityId.toUpperCase()}] Error:`, error.message);
    }
    
    this.agents.HISTORIAN.status = 'idle';
  }
  
  // CHASE background readiness check
  startChaseCycle() {
    // Run every 15 minutes
    setInterval(async () => {
      await this.runChaseReadiness();
    }, 15 * 60 * 1000);
    
    // Initial run after 3 minutes
    setTimeout(() => this.runChaseReadiness(), 3 * 60 * 1000);
  }
  
  async runChaseReadiness() {
    this.agents.CHASE.status = 'analyzing';
    this.agents.CHASE.stats.activations++;
    
    try {
      // Analyze recent pursuits if any
      const recentPursuits = this.memory.incidents.filter(inc => {
        const text = `${inc.incidentType} ${inc.summary || ''}`.toLowerCase();
        return this.agents.CHASE.triggers.some(t => text.includes(t));
      }).slice(0, 10);
      
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: this.agents.CHASE.systemPrompt + `\n\nRespond in JSON: { "status": "ready/alert", "recentPursuits": N, "commonEscapeRoutes": ["..."], "highRiskAreas": ["..."], "recommendations": ["..."] }`,
        messages: [{
          role: "user",
          content: `CHASE readiness check for ${this.cityId.toUpperCase()}:

Time: ${new Date().toISOString()}
Hour: ${new Date().getHours()} (${new Date().getHours() >= 22 || new Date().getHours() <= 5 ? 'HIGH pursuit risk hours' : 'Normal hours'})

Recent pursuit-related incidents: ${recentPursuits.length}
${recentPursuits.length > 0 ? JSON.stringify(recentPursuits) : 'None recently'}

Analyze escape route patterns and high-risk areas for this time of day.`
        }]
      });
      
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        this.agents.CHASE.history.unshift({
          timestamp: new Date().toISOString(),
          status: result.status,
          recentPursuits: recentPursuits.length,
          highRiskAreas: result.highRiskAreas,
          recommendations: result.recommendations
        });
        
        if (this.agents.CHASE.history.length > 100) {
          this.agents.CHASE.history = this.agents.CHASE.history.slice(0, 100);
        }
        
        console.log(`[CHASE-${this.cityId.toUpperCase()}] Readiness: ${result.status}, watching ${result.highRiskAreas?.length || 0} areas`);
      }
    } catch (error) {
      console.error(`[CHASE-${this.cityId.toUpperCase()}] Error:`, error.message);
    }
    
    this.agents.CHASE.status = 'idle';
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
    // Run every 5 minutes (was 15)
    setInterval(async () => {
      await this.runProphet();
    }, 5 * 60 * 1000);
    
    // Initial run after 30 seconds
    setTimeout(() => this.runProphet(), 30 * 1000);
  }

  async runProphet() {
    // Run even with 0 incidents - can make predictions based on time/patterns
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
        system: this.agents.PROPHET.systemPrompt + `\n\nYou are analyzing ${this.cityId.toUpperCase()}. You have access to your prediction history. Learn from hits and misses. Respond in JSON: { "predictions": [{ "location": "specific ${this.cityId.toUpperCase()} location", "borough": "string", "incidentType": "string", "timeWindowMinutes": number, "confidence": 0.0-1.0, "reasoning": "string", "basedOnPattern": "pattern name or null" }], "analysis": "brief analysis of current situation" }. Make 1-3 specific predictions.`,
        messages: [{
          role: "user",
          content: `Current time: ${new Date().toISOString()}
Hour: ${new Date().getHours()}
Day: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}
City: ${this.cityId.toUpperCase()}

RECENT INCIDENTS (${recentIncidents.length}):
${recentIncidents.length > 0 ? JSON.stringify(recentIncidents.slice(0, 15)) : 'No incidents yet - make predictions based on time patterns and general knowledge'}

HOTSPOTS:
${hotspots.length > 0 ? JSON.stringify(hotspots) : 'No hotspots identified yet'}

ACTIVE PATTERNS:
${activePatterns.length > 0 ? JSON.stringify(activePatterns) : 'No active patterns yet'}

YOUR RECENT PREDICTION PERFORMANCE (learn from this):
${recentPredictions.length > 0 ? JSON.stringify(recentPredictions) : 'No prediction history yet - start fresh'}

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
    // Run every 3 minutes (was 5)
    setInterval(async () => {
      await this.runBackgroundPatternAnalysis();
    }, 3 * 60 * 1000);
    
    // Initial run after 1 minute
    setTimeout(() => this.runBackgroundPatternAnalysis(), 60 * 1000);
  }
  
  async runBackgroundPatternAnalysis() {
    // Run even with few incidents - can analyze time patterns, geographic focus, etc.
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
      
      const incidentCount = this.memory.incidents.length;
      const analysisPrompt = incidentCount > 0 
        ? `Analyze these ${Math.min(incidentCount, 50)} incidents for patterns:\n${JSON.stringify(this.memory.incidents.slice(0, 50))}`
        : `No incidents recorded yet. Analyze typical ${this.cityId.toUpperCase()} crime patterns for this time of day (${new Date().getHours()}:00) and day of week (${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}). What patterns should we watch for?`;
      
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: this.agents.PATTERN.systemPrompt + `\n\nRespond in JSON: { "analysis": "your analysis", "patterns": [{ "name": "pattern name", "description": "description", "confidence": "HIGH/MEDIUM/LOW" }], "watchAreas": ["areas to monitor"] }`,
        messages: [{
          role: "user",
          content: analysisPrompt
        }]
      });
      
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        // Store analysis in history
        this.agents.PATTERN.history.unshift({
          timestamp: new Date().toISOString(),
          incidentsAnalyzed: incidentCount,
          analysis: result.analysis,
          patternsFound: result.patterns?.length || 0,
          watchAreas: result.watchAreas
        });
        
        // Keep history manageable
        if (this.agents.PATTERN.history.length > 100) {
          this.agents.PATTERN.history = this.agents.PATTERN.history.slice(0, 100);
        }
        
        this.agents.PATTERN.stats.activations++;
        console.log(`[PATTERN-${this.cityId.toUpperCase()}] Analysis complete: ${result.patterns?.length || 0} patterns, watching ${result.watchAreas?.length || 0} areas`);
      }
    } catch (error) {
      console.error(`[PATTERN-${this.cityId.toUpperCase()}] Background error:`, error.message);
    }
    
    this.agents.PATTERN.status = 'idle';
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
      stats: agent.stats,
      recentHistory: agent.history?.slice(0, 10) || [],
      historyCount: agent.history?.length || 0
    }));
  }
  
  // Get full agent history for scrolling
  getAgentHistory(agentId, limit = 50) {
    const agent = this.agents[agentId];
    if (!agent) return null;
    
    return {
      id: agent.id,
      name: agent.name,
      icon: agent.icon,
      role: agent.role,
      stats: agent.stats,
      history: agent.history?.slice(0, limit) || [],
      totalHistoryCount: agent.history?.length || 0
    };
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

// Create separate DetectiveBureau per city
const detectiveBureaus = {
  nyc: new DetectiveBureau(anthropic, 'nyc'),
  mpls: new DetectiveBureau(anthropic, 'mpls')
};

// Legacy reference for backwards compatibility with existing endpoints
const detectiveBureau = detectiveBureaus.nyc;

// Initialize ICE Watcher for Minneapolis (declared in ICE tracking section)
// Will be initialized after server starts

// ============================================
// PREDICTION SYSTEM (PTS-BASED)
// ============================================

const HOUSE_EDGE = 0.08; // 8% house edge
const SIGNUP_BONUS = 500;
const DAILY_LOGIN_BONUS = 50;
const MIN_PREDICTION = 10;
const MAX_PREDICTION = 10000;

// User accounts store
const users = new Map();
const activePredictions = new Map();
const predictionHistory = [];

// ============================================
// GAMIFICATION SYSTEM
// ============================================

// --- RANKS & TITLES ---
const RANKS = [
  { minPts: 0, rank: 'Rookie', icon: '👤', color: '#6b7280' },
  { minPts: 500, rank: 'Beat Cop', icon: '👮', color: '#3b82f6' },
  { minPts: 2000, rank: 'Detective', icon: '🔍', color: '#8b5cf6' },
  { minPts: 5000, rank: 'Sergeant', icon: '⭐', color: '#f59e0b' },
  { minPts: 10000, rank: 'Lieutenant', icon: '🎖️', color: '#ef4444' },
  { minPts: 25000, rank: 'Captain', icon: '🏅', color: '#ec4899' },
  { minPts: 50000, rank: 'Commander', icon: '👑', color: '#f97316' },
  { minPts: 100000, rank: 'Commissioner', icon: '🏆', color: '#ffd700' }
];

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
    ...currentRank,
    currentPts: pts,
    nextRank: nextRank ? {
      rank: nextRank.rank,
      minPts: nextRank.minPts,
      ptsNeeded: nextRank.minPts - pts
    } : null,
    progress: Math.min(100, Math.round(progress))
  };
}

// --- STREAK SYSTEM ---
const STREAK_BONUSES = {
  login: [
    { days: 1, bonus: 50, label: 'Daily' },
    { days: 3, bonus: 75, label: '3-Day Streak' },
    { days: 7, bonus: 150, label: 'Week Warrior' },
    { days: 14, bonus: 300, label: 'Dedicated' },
    { days: 30, bonus: 500, label: 'Monthly Master' }
  ],
  prediction: [
    { streak: 2, multiplier: 1.1, label: 'Double Down' },
    { streak: 3, multiplier: 1.25, label: 'Hot Streak' },
    { streak: 5, multiplier: 1.5, label: 'On Fire' },
    { streak: 10, multiplier: 2.0, label: 'Unstoppable' }
  ]
};

function calculateLoginStreak(user) {
  const today = new Date().toISOString().split('T')[0];
  const lastLogin = user.lastLoginDate;
  
  if (!lastLogin) return { streak: 1, isNewDay: true };
  
  const lastDate = new Date(lastLogin);
  const todayDate = new Date(today);
  const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return { streak: user.loginStreak || 1, isNewDay: false };
  if (diffDays === 1) return { streak: (user.loginStreak || 0) + 1, isNewDay: true };
  return { streak: 1, isNewDay: true };
}

function getLoginBonus(streak) {
  let bonus = STREAK_BONUSES.login[0].bonus;
  let label = STREAK_BONUSES.login[0].label;
  
  for (const tier of STREAK_BONUSES.login) {
    if (streak >= tier.days) { bonus = tier.bonus; label = tier.label; }
  }
  return { bonus, label, streak };
}

function getPredictionStreakMultiplier(winStreak) {
  let multiplier = 1.0;
  let label = null;
  
  for (const tier of STREAK_BONUSES.prediction) {
    if (winStreak >= tier.streak) { multiplier = tier.multiplier; label = tier.label; }
  }
  return { multiplier, label, streak: winStreak };
}

// --- LIVE ACTIVITY FEED ---
const activityFeed = [];
const MAX_FEED_ITEMS = 100;

function addToActivityFeed(activity) {
  const item = {
    id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    ...activity,
    timestamp: new Date().toISOString()
  };
  
  activityFeed.unshift(item);
  if (activityFeed.length > MAX_FEED_ITEMS) activityFeed.pop();
  
  broadcast({ type: 'activity_feed', activity: item });
  return item;
}

// --- BOUNTY BOARD ---
const bounties = new Map();
const bountyHistory = [];
const BOUNTY_TYPES = {
  PHOTO: { label: 'Photo Request', icon: '📸', basePts: 200 },
  VERIFY: { label: 'Verification', icon: '✅', basePts: 150 },
  TRANSLATE: { label: 'Translation', icon: '🌐', basePts: 300 },
  INTEL: { label: 'Local Intel', icon: '🔍', basePts: 175 },
  LOCATION: { label: 'Location Check', icon: '📍', basePts: 100 }
};

function createBounty(data) {
  const { type, title, description, location, city, reward, expiresInMinutes = 60, createdBy } = data;
  const bountyId = `bounty_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const bounty = {
    id: bountyId, type, typeInfo: BOUNTY_TYPES[type] || BOUNTY_TYPES.INTEL,
    title, description, location, city: city || 'nyc',
    reward: reward || BOUNTY_TYPES[type]?.basePts || 100,
    createdBy, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    status: 'ACTIVE', claimedBy: null, claimedAt: null,
    submission: null, completedAt: null, verifications: []
  };
  
  bounties.set(bountyId, bounty);
  addToActivityFeed({ type: 'bounty_created', bountyId, title, reward: bounty.reward, location, user: createdBy });
  return bounty;
}

function claimBounty(bountyId, username) {
  const bounty = bounties.get(bountyId);
  if (!bounty) return { error: 'Bounty not found' };
  if (bounty.status !== 'ACTIVE') return { error: 'Bounty not available' };
  if (new Date() > new Date(bounty.expiresAt)) { bounty.status = 'EXPIRED'; return { error: 'Bounty expired' }; }
  
  bounty.status = 'CLAIMED';
  bounty.claimedBy = username;
  bounty.claimedAt = new Date().toISOString();
  bounty.submissionDeadline = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  
  addToActivityFeed({ type: 'bounty_claimed', bountyId, title: bounty.title, user: username });
  return { success: true, bounty };
}

function submitBounty(bountyId, username, submission) {
  const bounty = bounties.get(bountyId);
  if (!bounty) return { error: 'Bounty not found' };
  if (bounty.claimedBy !== username) return { error: 'Not your bounty' };
  if (bounty.status !== 'CLAIMED') return { error: 'Invalid bounty status' };
  
  bounty.submission = { content: submission.content, imageUrl: submission.imageUrl || null, submittedAt: new Date().toISOString() };
  bounty.status = 'PENDING_VERIFICATION';
  return { success: true, bounty };
}

function verifyBountySubmission(bountyId, verifierUsername, approved) {
  const bounty = bounties.get(bountyId);
  if (!bounty) return { error: 'Bounty not found' };
  if (bounty.status !== 'PENDING_VERIFICATION') return { error: 'Not pending verification' };
  if (bounty.claimedBy === verifierUsername) return { error: 'Cannot verify your own submission' };
  if (bounty.verifications.some(v => v.username === verifierUsername)) return { error: 'Already verified' };
  
  bounty.verifications.push({ username: verifierUsername, approved, timestamp: new Date().toISOString() });
  
  const verifier = getUserByUsername(verifierUsername);
  if (verifier) { verifier.pts += 10; verifier.verificationsGiven = (verifier.verificationsGiven || 0) + 1; }
  
  const approvals = bounty.verifications.filter(v => v.approved).length;
  const rejections = bounty.verifications.filter(v => !v.approved).length;
  
  if (approvals >= 3) completeBounty(bountyId);
  else if (rejections >= 3) {
    bounty.status = 'ACTIVE'; bounty.claimedBy = null; bounty.claimedAt = null;
    bounty.submission = null; bounty.verifications = [];
  }
  
  return { success: true, bounty, approvals, rejections };
}

function completeBounty(bountyId) {
  const bounty = bounties.get(bountyId);
  if (!bounty) return { error: 'Bounty not found' };
  
  bounty.status = 'COMPLETED';
  bounty.completedAt = new Date().toISOString();
  
  const user = getUserByUsername(bounty.claimedBy);
  if (user) {
    user.pts += bounty.reward;
    user.bountiesCompleted = (user.bountiesCompleted || 0) + 1;
    user.totalBountyEarnings = (user.totalBountyEarnings || 0) + bounty.reward;
  }
  
  bountyHistory.unshift(bounty);
  bounties.delete(bountyId);
  
  addToActivityFeed({ type: 'bounty_completed', bountyId, title: bounty.title, reward: bounty.reward, user: bounty.claimedBy });
  broadcast({ type: 'bounty_completed', bounty, user: bounty.claimedBy });
  
  return { success: true, bounty };
}

// Expire stale bounties
setInterval(() => {
  const now = Date.now();
  bounties.forEach((bounty, id) => {
    if (bounty.status === 'ACTIVE' && now > new Date(bounty.expiresAt).getTime()) {
      bounty.status = 'EXPIRED'; bountyHistory.unshift(bounty); bounties.delete(id);
    }
    if (bounty.status === 'CLAIMED' && bounty.submissionDeadline && now > new Date(bounty.submissionDeadline).getTime()) {
      bounty.status = 'ACTIVE'; bounty.claimedBy = null; bounty.claimedAt = null; bounty.submissionDeadline = null;
    }
  });
}, 30000);

// --- TRANSCRIPTION BOUNTIES ---
const transcriptionQueue = [];
const MAX_TRANSCRIPTION_QUEUE = 50;
const TRANSCRIPTION_REWARD = 25;

function addTranscriptionForVerification(transcript, audioId, source) {
  const item = {
    id: `trans_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    originalText: transcript, audioId, source,
    timestamp: new Date().toISOString(),
    status: 'PENDING', corrections: [], verifications: []
  };
  
  transcriptionQueue.unshift(item);
  if (transcriptionQueue.length > MAX_TRANSCRIPTION_QUEUE) transcriptionQueue.pop();
  return item;
}

function submitTranscriptionCorrection(transcriptId, username, correctedText, corrections) {
  const item = transcriptionQueue.find(t => t.id === transcriptId);
  if (!item) return { error: 'Transcript not found' };
  if (item.status !== 'PENDING') return { error: 'Already processed' };
  if (item.corrections.some(c => c.username === username)) return { error: 'Already submitted correction' };
  
  item.corrections.push({ username, correctedText, corrections, timestamp: new Date().toISOString() });
  
  if (item.corrections.length >= 3) processTranscriptionCorrections(item);
  return { success: true, item };
}

function processTranscriptionCorrections(item) {
  const textCounts = {};
  item.corrections.forEach(c => {
    const key = c.correctedText.toLowerCase().trim();
    textCounts[key] = (textCounts[key] || 0) + 1;
  });
  
  let consensusText = item.originalText;
  let maxCount = 0;
  Object.entries(textCounts).forEach(([text, count]) => {
    if (count > maxCount) { maxCount = count; consensusText = text; }
  });
  
  if (maxCount >= 2 && consensusText !== item.originalText.toLowerCase().trim()) {
    item.status = 'VERIFIED';
    item.finalText = consensusText;
    
    item.corrections.forEach(c => {
      if (c.correctedText.toLowerCase().trim() === consensusText) {
        const user = getUserByUsername(c.username);
        if (user) {
          user.pts += TRANSCRIPTION_REWARD;
          user.transcriptionsVerified = (user.transcriptionsVerified || 0) + 1;
          addToActivityFeed({ type: 'transcription_verified', user: c.username, reward: TRANSCRIPTION_REWARD });
        }
      }
    });
  } else if (item.corrections.length >= 5) {
    item.status = 'DISPUTED';
  }
}

function verifyTranscription(transcriptId, username, isCorrect) {
  const item = transcriptionQueue.find(t => t.id === transcriptId);
  if (!item) return { error: 'Transcript not found' };
  if (item.verifications.some(v => v.username === username)) return { error: 'Already verified' };
  
  item.verifications.push({ username, isCorrect, timestamp: new Date().toISOString() });
  
  const user = getUserByUsername(username);
  if (user) user.pts += 5;
  
  const correctVotes = item.verifications.filter(v => v.isCorrect).length;
  const incorrectVotes = item.verifications.filter(v => !v.isCorrect).length;
  
  if (correctVotes >= 3) item.status = 'VERIFIED';
  else if (incorrectVotes >= 3) item.needsCorrection = true;
  
  return { success: true, item, correctVotes, incorrectVotes };
}

// ============================================
// END GAMIFICATION SYSTEM
// ============================================

// ============================================
// DATABASE SCHEMA & HELPERS
// ============================================

async function initDatabase() {
  if (!pool) return;
  
  try {
    await pool.query(`
      -- Users
      CREATE TABLE IF NOT EXISTS users_db (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(50),
        pts INTEGER DEFAULT 500,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        total_predictions INTEGER DEFAULT 0,
        login_streak INTEGER DEFAULT 1,
        last_login_date DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Incidents (permanent archive)
      CREATE TABLE IF NOT EXISTS incidents_db (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        incident_type VARCHAR(100),
        location TEXT,
        borough VARCHAR(100),
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        priority VARCHAR(20),
        summary TEXT,
        transcript TEXT,
        units TEXT[],
        source VARCHAR(100),
        audio_url TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_city ON incidents_db(city);
      CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents_db(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_borough ON incidents_db(borough);

      -- Arrests (NYC Open Data)
      CREATE TABLE IF NOT EXISTS arrests (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        arrest_date DATE,
        offense_description TEXT,
        offense_category VARCHAR(100),
        law_category VARCHAR(50),
        borough VARCHAR(100),
        precinct VARCHAR(20),
        age_group VARCHAR(20),
        sex VARCHAR(10),
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_arrests_city ON arrests(city);
      CREATE INDEX IF NOT EXISTS idx_arrests_date ON arrests(arrest_date DESC);

      -- Inmates
      CREATE TABLE IF NOT EXISTS inmates (
        id SERIAL PRIMARY KEY,
        external_id VARCHAR(100),
        city VARCHAR(10) NOT NULL,
        facility VARCHAR(100),
        admission_date DATE,
        status VARCHAR(50),
        top_charge TEXT,
        age INTEGER,
        sex VARCHAR(10),
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(city, external_id)
      );

      -- ICE Activities
      CREATE TABLE IF NOT EXISTS ice_activities (
        id SERIAL PRIMARY KEY,
        city VARCHAR(10) NOT NULL,
        activity_type VARCHAR(50),
        location TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        description TEXT,
        agencies TEXT[],
        source VARCHAR(50),
        source_url TEXT,
        reported_by VARCHAR(50),
        verified BOOLEAN DEFAULT FALSE,
        verification_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ice_city ON ice_activities(city);
      CREATE INDEX IF NOT EXISTS idx_ice_created ON ice_activities(created_at DESC);

      -- Detention Facilities
      CREATE TABLE IF NOT EXISTS detention_facilities (
        id SERIAL PRIMARY KEY,
        facility_id VARCHAR(100) UNIQUE,
        name VARCHAR(200),
        city VARCHAR(10),
        state VARCHAR(10),
        address TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        facility_type VARCHAR(50),
        capacity INTEGER,
        last_updated TIMESTAMP DEFAULT NOW()
      );

      -- Address History (problem locations)
      CREATE TABLE IF NOT EXISTS address_history (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        city VARCHAR(10) NOT NULL,
        incident_count INTEGER DEFAULT 1,
        last_incident_at TIMESTAMP,
        flagged BOOLEAN DEFAULT FALSE,
        UNIQUE(address, city)
      );

      -- Community Reports
      CREATE TABLE IF NOT EXISTS community_reports (
        id SERIAL PRIMARY KEY,
        city VARCHAR(10) NOT NULL,
        report_type VARCHAR(50),
        location TEXT,
        lat DECIMAL(10, 7),
        lng DECIMAL(10, 7),
        description TEXT,
        reported_by VARCHAR(50),
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Data Sync Log
      CREATE TABLE IF NOT EXISTS data_sync_log (
        id SERIAL PRIMARY KEY,
        source VARCHAR(100),
        city VARCHAR(10),
        records_fetched INTEGER,
        records_inserted INTEGER,
        status VARCHAR(20),
        error_message TEXT,
        completed_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('[DATABASE] Tables initialized');
    
    // Seed detention facilities
    await seedDetentionFacilities();
  } catch (error) {
    console.error('[DATABASE] Init error:', error.message);
  }
}

async function seedDetentionFacilities() {
  if (!pool) return;
  
  const facilities = [
    { facility_id: 'sherburne_mn', name: 'Sherburne County Jail', city: 'mpls', state: 'MN', address: '13880 Business Center Dr NW, Elk River, MN', lat: 45.3036, lng: -93.5672, facility_type: 'ice_contract', capacity: 700 },
    { facility_id: 'freeborn_mn', name: 'Freeborn County Jail', city: 'mpls', state: 'MN', address: '411 S Broadway Ave, Albert Lea, MN', lat: 43.6480, lng: -93.3683, facility_type: 'ice_contract', capacity: 104 },
    { facility_id: 'hudson_nj', name: 'Hudson County Correctional', city: 'nyc', state: 'NJ', address: '30 Hackensack Ave, Kearny, NJ', lat: 40.7618, lng: -74.1185, facility_type: 'ice_detention', capacity: 750 },
    { facility_id: 'bergen_nj', name: 'Bergen County Jail', city: 'nyc', state: 'NJ', address: '160 S River St, Hackensack, NJ', lat: 40.8826, lng: -74.0435, facility_type: 'ice_contract', capacity: 1200 }
  ];
  
  for (const f of facilities) {
    try {
      await pool.query(`
        INSERT INTO detention_facilities (facility_id, name, city, state, address, lat, lng, facility_type, capacity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (facility_id) DO NOTHING
      `, [f.facility_id, f.name, f.city, f.state, f.address, f.lat, f.lng, f.facility_type, f.capacity]);
    } catch (e) { /* ignore */ }
  }
}

// Save incident to database
async function saveIncidentToDb(incident) {
  if (!pool) return null;
  
  try {
    const result = await pool.query(`
      INSERT INTO incidents_db (external_id, city, incident_type, location, borough, lat, lng, priority, summary, transcript, units, source, audio_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (city, external_id) DO NOTHING
      RETURNING id
    `, [
      `inc_${incident.id}`, incident.city || 'nyc', incident.incidentType, incident.location,
      incident.borough, incident.lat, incident.lng, incident.priority, incident.summary,
      incident.transcript, incident.units || [], incident.source, incident.audioUrl,
      incident.timestamp || new Date()
    ]);
    
    // Update address history
    if (incident.location && incident.location !== 'Unknown') {
      await updateAddressHistory(incident.location, incident.city || 'nyc');
    }
    
    return result.rows[0]?.id;
  } catch (error) {
    console.error('[DB] Save incident error:', error.message);
    return null;
  }
}

// Update address history for problem location tracking
async function updateAddressHistory(address, city) {
  if (!pool) return;
  
  try {
    await pool.query(`
      INSERT INTO address_history (address, city, incident_count, last_incident_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (address, city) DO UPDATE SET
        incident_count = address_history.incident_count + 1,
        last_incident_at = NOW(),
        flagged = CASE WHEN address_history.incident_count >= 9 THEN TRUE ELSE address_history.flagged END
    `, [address.toLowerCase().trim(), city]);
  } catch (error) {
    console.error('[DB] Address history error:', error.message);
  }
}

// ============================================
// PUBLIC DATA SYNC FUNCTIONS
// ============================================

// NYC Open Data - Arrests
async function fetchNYCArrestData() {
  if (!pool) return;
  console.log('[DATA SYNC] Fetching NYC arrests...');
  
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const url = `https://data.cityofnewyork.us/resource/uip8-fykc.json?$where=arrest_date>='${thirtyDaysAgo}'&$limit=2000&$order=arrest_date DESC`;
    
    const response = await fetch(url, {
      headers: { 'X-App-Token': process.env.NYC_OPEN_DATA_TOKEN || '' }
    });
    
    if (!response.ok) return;
    const data = await response.json();
    let inserted = 0;
    
    for (const arrest of data) {
      try {
        const result = await pool.query(`
          INSERT INTO arrests (external_id, city, arrest_date, offense_description, offense_category, law_category, borough, precinct, age_group, sex, lat, lng, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (city, external_id) DO NOTHING
          RETURNING id
        `, [arrest.arrest_key, 'nyc', arrest.arrest_date, arrest.pd_desc, arrest.ofns_desc, arrest.law_cat_cd, arrest.arrest_boro, arrest.arrest_precinct, arrest.age_group, arrest.perp_sex, arrest.latitude, arrest.longitude, 'nyc_open_data']);
        if (result.rows[0]) inserted++;
      } catch (e) { /* skip */ }
    }
    
    await pool.query('INSERT INTO data_sync_log (source, city, records_fetched, records_inserted, status) VALUES ($1, $2, $3, $4, $5)', ['nyc_arrests', 'nyc', data.length, inserted, 'success']);
    console.log(`[DATA SYNC] NYC arrests: ${inserted}/${data.length} inserted`);
  } catch (error) {
    console.error('[DATA SYNC] NYC arrests error:', error.message);
  }
}

// NYC DOC - Inmates
async function fetchNYCInmateData() {
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
      try {
        const result = await pool.query(`
          INSERT INTO inmates (external_id, city, facility, admission_date, status, top_charge, age, sex, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (city, external_id) DO NOTHING
          RETURNING id
        `, [inmate.inmateid, 'nyc', inmate.custody_level || 'Unknown', inmate.admitted_dt, 'in_custody', inmate.top_charge, inmate.age, inmate.gender, 'nyc_doc']);
        if (result.rows[0]) inserted++;
      } catch (e) { /* skip */ }
    }
    
    await pool.query('INSERT INTO data_sync_log (source, city, records_fetched, records_inserted, status) VALUES ($1, $2, $3, $4, $5)', ['nyc_inmates', 'nyc', data.length, inserted, 'success']);
    console.log(`[DATA SYNC] NYC inmates: ${inserted}/${data.length} inserted`);
  } catch (error) {
    console.error('[DATA SYNC] NYC inmates error:', error.message);
  }
}

// Start data sync scheduler
function startDataSyncScheduler() {
  if (!pool) {
    console.log('[DATA SYNC] Skipping - no database configured');
    return;
  }
  
  // NYC arrests - every 6 hours
  setInterval(fetchNYCArrestData, 6 * 60 * 60 * 1000);
  
  // NYC inmates - every 4 hours  
  setInterval(fetchNYCInmateData, 4 * 60 * 60 * 1000);
  
  // Initial sync after startup
  setTimeout(fetchNYCArrestData, 15000);
  setTimeout(fetchNYCInmateData, 45000);
  
  console.log('[DATA SYNC] Scheduler started');
}

// Initialize database on startup
initDatabase().then(() => {
  startDataSyncScheduler();
});

// ============================================
// END DATABASE SYSTEM
// ============================================

const oddsEngine = {
  // City-specific district rates
  districtRates: {
    nyc: { 
      'Manhattan': 2.5, 'Brooklyn': 2.0, 'Bronx': 1.8, 'Queens': 1.2, 'Staten Island': 0.3
    },
    mpls: {
      'Downtown': 1.8, 'North': 1.5, 'Northeast': 1.0, 'Southeast': 0.8, 'South': 1.2,
      'Southwest': 0.7, 'Calhoun-Isles': 0.5, 'Camden': 1.3, 'Near North': 1.6,
      'Phillips': 1.4, 'Powderhorn': 1.1, 'Nokomis': 0.6, 'Longfellow': 0.8
    }
  },
  
  incidentTypeRarity: { 
    'any': 1.0, 'traffic': 0.20, 'medical': 0.15, 'domestic': 0.12,
    'assault': 0.08, 'suspicious': 0.10, 'theft': 0.06, 'robbery': 0.03,
    'pursuit': 0.02, 'shots fired': 0.01
  },
  
  timeMultipliers: { 
    0: 0.6, 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.3, 5: 0.4, 
    6: 0.6, 7: 0.8, 8: 0.9, 9: 1.0, 10: 1.0, 11: 1.1, 
    12: 1.2, 13: 1.1, 14: 1.0, 15: 1.1, 16: 1.2, 17: 1.3, 
    18: 1.4, 19: 1.5, 20: 1.6, 21: 1.5, 22: 1.3, 23: 0.9 
  },
  
  getDistricts(cityId = 'nyc') {
    return Object.keys(this.districtRates[cityId] || this.districtRates.nyc);
  },
  
  calculateProbability(district, incidentType = 'any', windowMinutes = 30, cityId = 'nyc') {
    const hour = new Date().getHours();
    const cityRates = this.districtRates[cityId] || this.districtRates.nyc;
    const baseRate = cityRates[district] || 1.0;
    const timeAdjusted = baseRate * this.timeMultipliers[hour];
    const typeMultiplier = this.incidentTypeRarity[incidentType.toLowerCase()] || 0.05;
    const adjusted = timeAdjusted * typeMultiplier;
    const lambda = (adjusted / 60) * windowMinutes;
    const probability = 1 - Math.exp(-lambda);
    return Math.max(0.02, Math.min(0.85, probability));
  },
  
  calculateMultiplier(probability) {
    const fairOdds = 1 / probability;
    const withEdge = fairOdds * (1 - HOUSE_EDGE);
    return Math.max(1.1, Math.min(45.0, Math.round(withEdge * 10) / 10));
  },
  
  getOdds(district, incidentType = 'any', windowMinutes = 30, cityId = 'nyc') {
    const prob = this.calculateProbability(district, incidentType, windowMinutes, cityId);
    const mult = this.calculateMultiplier(prob);
    return { 
      district,
      borough: district, // Legacy compatibility
      incidentType, 
      windowMinutes, 
      probability: Math.round(prob * 100),
      probabilityRaw: prob,
      multiplier: mult,
      houseEdge: `${(HOUSE_EDGE * 100).toFixed(0)}%`
    };
  }
};

const pool = { 
  totalPredictions: 0, 
  totalPtsWagered: 0, 
  totalPtsPaidOut: 0,
  get netPool() { return this.totalPtsWagered - this.totalPtsPaidOut; }
};

// User management helpers
function createUser(username) {
  const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const user = {
    id: userId,
    username: username.toLowerCase().trim(),
    displayName: username.trim(),
    pts: SIGNUP_BONUS,
    
    // Predictions
    totalPredictions: 0,
    wins: 0,
    losses: 0,
    totalWinnings: 0,
    totalLosses: 0,
    currentWinStreak: 0,
    bestWinStreak: 0,
    
    // Streaks
    loginStreak: 1,
    bestLoginStreak: 1,
    lastLoginDate: new Date().toISOString().split('T')[0],
    
    // Bounties
    bountiesCompleted: 0,
    bountiesCreated: 0,
    totalBountyEarnings: 0,
    
    // Transcriptions
    transcriptionsVerified: 0,
    verificationsGiven: 0,
    
    createdAt: new Date().toISOString()
  };
  users.set(user.username, user);
  
  addToActivityFeed({ type: 'user_joined', user: user.displayName });
  
  return user;
}

function getUserByUsername(username) {
  return users.get(username.toLowerCase().trim());
}

function checkDailyBonus(user) {
  const today = new Date().toISOString().split('T')[0];
  if (user.lastLoginDate !== today) {
    user.pts += DAILY_LOGIN_BONUS;
    user.lastLoginDate = today;
    return { awarded: true, amount: DAILY_LOGIN_BONUS, newBalance: user.pts };
  }
  return { awarded: false, amount: 0, newBalance: user.pts };
}

// Check predictions when incident occurs
function checkPredictionsForIncident(incident) {
  const now = Date.now();
  const incidentCity = incident.city || 'nyc'; // Default to nyc for backwards compatibility
  
  activePredictions.forEach((pred, predId) => {
    if (pred.status !== 'ACTIVE') return;
    
    if (now > new Date(pred.expiresAt).getTime()) {
      pred.status = 'LOST';
      pred.resolvedAt = new Date().toISOString();
      pred.result = 'expired';
      const user = users.get(pred.username);
      if (user) { 
        user.losses++; 
        user.totalLosses += pred.amount;
        user.currentWinStreak = 0; // Reset streak on loss
      }
      predictionHistory.unshift(pred);
      activePredictions.delete(predId);
      
      addToActivityFeed({ type: 'prediction_lost', user: pred.displayName, district: pred.district, amount: pred.amount });
      return;
    }
    
    // Must match city first
    const predCity = pred.city || 'nyc';
    if (predCity !== incidentCity) return;
    
    // Match district/borough (handle both field names)
    const predDistrict = (pred.district || pred.borough || '').toLowerCase();
    const incidentDistrict = (incident.district || incident.borough || '').toLowerCase();
    const districtMatch = predDistrict === incidentDistrict;
    
    const typeMatch = pred.incidentType === 'any' || 
      incident.incidentType?.toLowerCase().includes(pred.incidentType.toLowerCase());
    
    if (districtMatch && typeMatch) {
      pred.status = 'WON';
      pred.resolvedAt = new Date().toISOString();
      pred.result = 'matched';
      pred.matchedIncident = { id: incident.id, type: incident.incidentType, location: incident.location };
      
      const user = users.get(pred.username);
      
      // Calculate base winnings
      let winnings = Math.floor(pred.amount * pred.multiplier);
      
      if (user) {
        // Update win streak
        user.currentWinStreak = (user.currentWinStreak || 0) + 1;
        if (user.currentWinStreak > (user.bestWinStreak || 0)) {
          user.bestWinStreak = user.currentWinStreak;
        }
        
        // Apply streak bonus multiplier
        const streakBonus = getPredictionStreakMultiplier(user.currentWinStreak);
        if (streakBonus.multiplier > 1) {
          winnings = Math.floor(winnings * streakBonus.multiplier);
          pred.streakBonus = {
            multiplier: streakBonus.multiplier,
            label: streakBonus.label,
            streak: user.currentWinStreak
          };
        }
        
        user.pts += winnings;
        user.wins++;
        user.totalWinnings += winnings;
        
        // Check for rank up
        const oldRank = getUserRank(user.pts - winnings);
        const newRank = getUserRank(user.pts);
        if (newRank.rank !== oldRank.rank) {
          pred.rankUp = { from: oldRank.rank, to: newRank.rank, icon: newRank.icon };
          addToActivityFeed({ type: 'rank_up', user: user.displayName, newRank: newRank.rank, newRankIcon: newRank.icon });
        }
      }
      
      pred.winnings = winnings;
      pool.totalPtsPaidOut += winnings;
      predictionHistory.unshift(pred);
      activePredictions.delete(predId);
      
      // Add to activity feed
      addToActivityFeed({
        type: 'prediction_won',
        user: pred.displayName,
        district: pred.district,
        amount: pred.amount,
        winnings: winnings,
        multiplier: pred.multiplier,
        streakBonus: pred.streakBonus
      });
      
      // Broadcast win with animation data
      broadcast({
        type: 'prediction_won',
        prediction: { 
          id: pred.id, user: pred.displayName, city: pred.city, district: pred.district, 
          amount: pred.amount, winnings, multiplier: pred.multiplier,
          streakBonus: pred.streakBonus, rankUp: pred.rankUp
        },
        incident: { id: incident.id, type: incident.incidentType, location: incident.location },
        animation: {
          showConfetti: winnings >= 500,
          showRankUp: !!pred.rankUp,
          streakFire: user?.currentWinStreak >= 3
        },
        timestamp: new Date().toISOString()
      });
      
      console.log(`[PREDICTION] WIN! ${pred.displayName} won ${winnings} PTS (${user?.currentWinStreak || 1}x streak)`);
    }
  });
}

// Periodic check for expired predictions
setInterval(() => {
  const now = Date.now();
  activePredictions.forEach((pred, predId) => {
    if (pred.status === 'ACTIVE' && now > new Date(pred.expiresAt).getTime()) {
      pred.status = 'LOST';
      pred.resolvedAt = new Date().toISOString();
      pred.result = 'expired';
      const user = users.get(pred.username);
      if (user) { 
        user.losses++; 
        user.totalLosses += pred.amount;
        user.currentWinStreak = 0;
      }
      predictionHistory.unshift(pred);
      activePredictions.delete(predId);
      addToActivityFeed({ type: 'prediction_lost', user: pred.displayName, district: pred.district, amount: pred.amount });
    }
  });
}, 10000);

// Legacy compatibility - keep old variable names pointing to new ones
const activeBets = activePredictions;
const userProfiles = users;
const betHistory = predictionHistory;

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
// MINNEAPOLIS ICE TRACKING SYSTEM
// ============================================

// ICE Detention Facilities in Minneapolis/St. Paul Area of Responsibility
const MPLS_ICE_FACILITIES = [
  {
    id: 'whipple_federal',
    name: 'Bishop Henry Whipple Federal Building',
    shortName: 'Whipple (ICE HQ)',
    type: 'ice_headquarters',
    district: 'Fort Snelling',
    lat: 44.8808,
    lng: -93.2108,
    address: '1 Federal Dr, Suite 1640, Fort Snelling, MN 55111',
    phone: '(612) 843-8600',
    bondPhone: '(612) 843-8600',
    bondHours: 'Mon-Fri 9:00 AM - 3:00 PM',
    description: 'ICE Enforcement and Removal Operations (ERO) St. Paul Field Office. Manages 26 jail arrangements across MN, IA, NE, ND, SD.',
    isActiveRaid: true,
    hasProtestActivity: true,
    program287g: 'Jail Enforcement Model',
    notes: 'Primary deployment point for "Operation Metro Surge". Heavy community monitoring/counter-surveillance presence. Only location in MN to post immigration bonds in person.'
  },
  {
    id: 'sherburne_county',
    name: 'Sherburne County Jail',
    shortName: 'Sherburne',
    type: 'detention_center',
    agreementType: 'IGSA',
    district: 'Elk River',
    lat: 45.3036,
    lng: -93.5672,
    address: '13880 Business Center Dr NW, Elk River, MN 55330',
    phone: '(763) 765-3800',
    capacity: 700,
    iceDetainees: 200,
    mandatoryDetainees: 120,
    perDiem: 165,
    program287g: 'Jail Enforcement Model (Oct 2025)',
    visitationInfo: 'Video visits available via NCIC.com. 5 remote visits/day allowed.',
    description: 'Largest ICE detention facility in Minnesota. IGSA contract with ICE.',
    notes: 'Joined 287(g) Jail Enforcement Model in October 2025. Video visitation 8:30 AM - 9:30 PM daily.'
  },
  {
    id: 'freeborn_county',
    name: 'Freeborn County Jail',
    shortName: 'Freeborn',
    type: 'detention_center',
    agreementType: 'IGSA',
    district: 'Albert Lea',
    lat: 43.6480,
    lng: -93.3683,
    address: '411 S Broadway Ave, Albert Lea, MN 56007',
    phone: '(507) 377-5200',
    capacity: 133,
    iceDetainees: 84,
    mandatoryDetainees: 52,
    perDiem: 165,
    program287g: 'Warrant Service Officer',
    annualRevenue: '$2.1M (2024)',
    revenuePercent: '42% of jail expenses',
    visitationInfo: 'In-person or via inmatecanteen.com',
    description: 'IGSA detention facility in southern Minnesota. ICE revenue covers 42% of expenses.',
    notes: 'ACLU lawsuit filed against county for "illegal agreement with ICE". Warrant Service Officer program.'
  },
  {
    id: 'kandiyohi_county',
    name: 'Kandiyohi County Jail',
    shortName: 'Kandiyohi',
    type: 'detention_center',
    agreementType: 'IGSA',
    district: 'Willmar',
    lat: 45.1219,
    lng: -95.0433,
    address: '2201 23rd St NE, Willmar, MN 56201',
    phone: '(320) 214-6700',
    capacity: 190,
    iceDetainees: 108,
    mandatoryDetainees: 68,
    perDiem: 165,
    program287g: 'Warrant Service Officer (Mar 2025)',
    annualRevenue: '$5.8M (2025)',
    revenuePercent: '55% of jail expenses',
    description: 'IGSA detention facility in west-central Minnesota. 22+ years ICE contract. Inspected 4x/year.',
    notes: 'Revenue increased significantly under Operation Metro Surge. Over half of jail expenses covered by ICE.'
  },
  {
    id: 'crow_wing_county',
    name: 'Crow Wing County Jail',
    shortName: 'Crow Wing',
    type: 'detention_center',
    agreementType: 'USMS IGA',
    district: 'Brainerd',
    lat: 46.3522,
    lng: -94.2008,
    address: '313 Laurel St, Brainerd, MN 56401',
    phone: '(218) 829-4749',
    capacity: 200,
    iceDetainees: 50,
    mandatoryDetainees: 0,
    perDiem: 102,
    program287g: 'Task Force + Warrant Service (Mar 2025)',
    description: 'USMS IGA facility, began holding ICE detainees late November 2024.',
    notes: 'First ICE detainee arrived Nov 2024. Received $102/day per detainee. 7 deputies trained for 287(g).'
  },
  {
    id: 'nw_regional',
    name: 'Northwest Regional Corrections Center',
    shortName: 'NW Regional',
    type: 'detention_center',
    agreementType: 'USMS IGA',
    district: 'Crookston',
    lat: 47.7742,
    lng: -96.6089,
    address: '816 Marin Ave, Crookston, MN 56716',
    phone: '(218) 470-8282',
    capacity: 150,
    iceDetainees: 11,
    mandatoryDetainees: 5,
    perDiem: 165,
    description: 'USMS IGA facility in northwest Minnesota near North Dakota border.',
    notes: 'Passed operational review self-assessment Oct 2024. Small ICE population.'
  },
  {
    id: 'mille_lacs_county',
    name: 'Mille Lacs County Jail',
    shortName: 'Mille Lacs',
    type: 'participating_agency',
    agreementType: '287(g) Task Force',
    district: 'Milaca',
    lat: 45.7558,
    lng: -93.6544,
    address: '635 2nd St SE, Milaca, MN 56353',
    phone: '(320) 983-8250',
    capacity: 96,
    iceDetainees: 0,
    program287g: 'Task Force Model (Jun 2025)',
    description: '287(g) Task Force agreement. Not actively holding ICE detainees but staff can assist operations.',
    notes: 'Sheriff stated "not directly involved in joint operations with ICE since signing".'
  },
  {
    id: 'itasca_county',
    name: 'Itasca County Jail',
    shortName: 'Itasca',
    type: 'participating_agency',
    agreementType: '287(g) Task Force',
    district: 'Grand Rapids',
    lat: 47.2372,
    lng: -93.5302,
    address: '123 NE 4th St, Grand Rapids, MN 55744',
    phone: '(218) 327-2870',
    capacity: 120,
    iceDetainees: 0,
    program287g: 'Task Force Model (Feb 2025)',
    description: '287(g) Task Force agreement signed February 2025.',
    notes: 'Task Force Model allows staff to assist ICE field operations.'
  },
  {
    id: 'cass_county',
    name: 'Cass County Jail',
    shortName: 'Cass',
    type: 'participating_agency',
    agreementType: '287(g) Task Force',
    district: 'Walker',
    lat: 47.1011,
    lng: -94.5872,
    address: '303 Minnesota Ave W, Walker, MN 56484',
    phone: '(218) 547-1424',
    capacity: 80,
    iceDetainees: 0,
    program287g: 'Task Force Model (Feb 2025)',
    description: '287(g) Task Force agreement signed February 2025.',
    notes: 'Northern Minnesota facility with Task Force agreement.'
  },
  {
    id: 'carver_county',
    name: 'Carver County Jail',
    shortName: 'Carver (DECLINED)',
    type: 'declined_facility',
    district: 'Chaska',
    lat: 44.7894,
    lng: -93.6022,
    address: '606 E 4th St, Chaska, MN 55318',
    phone: '(952) 361-1212',
    capacity: 200,
    iceDetainees: 0,
    description: 'DECLINED ICE agreement. ICE requirements exceeded facility capacity.',
    notes: 'Declined to work with ICE - requirements would need >50% of jail space. Listed on some ICE facility lists but NOT currently holding detainees.'
  }
];

// ICE Statistics for St. Paul Area of Responsibility (from deportationdata.org)
const ICE_STATS_STPAUL = {
  areaOfResponsibility: 'St. Paul',
  coverage: ['Minnesota', 'North Dakota', 'South Dakota'],
  lastUpdated: '2026-01-15',
  
  // Arrest statistics (Jan 2025 - Jan 2026)
  arrests: {
    total: 22700,
    byCriminality: {
      criminalConviction: 7400,
      immigrationViolation: 13100,
      pendingCharges: 2200
    },
    byMethod: {
      custodial: 11500,  // At jails/prisons
      atLarge: 9200,     // In community ("Operation Metro Surge")
      other: 2000
    },
    trend: 'increasing',
    changeFromLastPeriod: '+77%'
  },
  
  // Detention statistics
  detentions: {
    total: 9800,
    byCriminality: {
      criminalConviction: 6200,
      immigrationViolation: 2400,
      pendingCharges: 1200
    },
    averageLengthDays: 41
  },
  
  // Detainer requests
  detainers: {
    issued: 8500,
    honored: 6200,
    declined: 2300,
    honorRate: '73%'
  },
  
  // Time periods for comparison
  periods: {
    period1: { start: '2025-01-20', end: '2025-07-20', arrests: 8200 },
    period2: { start: '2025-07-21', end: '2026-01-15', arrests: 14500 }
  }
};

// Community ICE Reports Storage
const iceReports = [];
const MAX_ICE_REPORTS = 500;

// ICE News/Events from verified sources
const iceNewsEvents = [];
const MAX_ICE_NEWS = 100;

// ICE Activity Hotspots (known areas of frequent activity)
const ICE_HOTSPOTS_MPLS = [
  { id: 'lake_street', name: 'Lake Street Corridor', lat: 44.9486, lng: -93.2590, level: 'high', description: 'High immigrant population, frequent patrols' },
  { id: 'east_lake', name: 'East Lake Street', lat: 44.9486, lng: -93.2300, level: 'high', description: 'Commercial district, workplace raids reported' },
  { id: 'cedar_riverside', name: 'Cedar-Riverside', lat: 44.9697, lng: -93.2543, level: 'high', description: 'Large Somali community, frequent surveillance' },
  { id: 'phillips', name: 'Phillips Neighborhood', lat: 44.9550, lng: -93.2616, level: 'high', description: 'Diverse immigrant community' },
  { id: 'powderhorn', name: 'Powderhorn', lat: 44.9366, lng: -93.2590, level: 'medium', description: 'Residential area, door knocks reported' },
  { id: 'north_minneapolis', name: 'North Minneapolis', lat: 45.0050, lng: -93.2950, level: 'medium', description: 'Mixed activity levels' },
  { id: 'south_minneapolis', name: 'South Minneapolis', lat: 44.9200, lng: -93.2680, level: 'medium', description: 'Residential surveillance' },
  { id: 'downtown', name: 'Downtown Minneapolis', lat: 44.9778, lng: -93.2650, level: 'medium', description: 'Transit hubs, occasional checkpoints' },
  { id: 'st_paul_west', name: 'West St. Paul', lat: 44.9163, lng: -93.1066, level: 'medium', description: 'Latino community areas' },
  { id: 'fort_snelling', name: 'Fort Snelling Area', lat: 44.8808, lng: -93.2108, level: 'critical', description: 'ICE HQ - all deployments originate here' }
];

// ============================================
// MINNEAPOLIS GEOCODER - Convert locations to coordinates
// ============================================

const MPLS_KNOWN_LOCATIONS = {
  // ICE Facilities
  'whipple': { lat: 44.8808, lng: -93.2108, name: 'Whipple Federal Building' },
  'whipple federal': { lat: 44.8808, lng: -93.2108, name: 'Whipple Federal Building' },
  'fort snelling': { lat: 44.8808, lng: -93.2108, name: 'Fort Snelling' },
  'sherburne': { lat: 45.4441, lng: -93.7677, name: 'Sherburne County Jail' },
  'sherburne county': { lat: 45.4441, lng: -93.7677, name: 'Sherburne County Jail' },
  'freeborn': { lat: 43.6480, lng: -93.3677, name: 'Freeborn County Jail' },
  'kandiyohi': { lat: 45.1219, lng: -95.0403, name: 'Kandiyohi County Jail' },
  
  // Major Streets
  'lake street': { lat: 44.9486, lng: -93.2590, name: 'Lake Street' },
  'east lake': { lat: 44.9486, lng: -93.2300, name: 'East Lake Street' },
  'lake st': { lat: 44.9486, lng: -93.2590, name: 'Lake Street' },
  'hennepin': { lat: 44.9778, lng: -93.2780, name: 'Hennepin Avenue' },
  'hennepin ave': { lat: 44.9778, lng: -93.2780, name: 'Hennepin Avenue' },
  'nicollet': { lat: 44.9650, lng: -93.2780, name: 'Nicollet Avenue' },
  'nicollet mall': { lat: 44.9750, lng: -93.2720, name: 'Nicollet Mall' },
  'lyndale': { lat: 44.9500, lng: -93.2880, name: 'Lyndale Avenue' },
  'franklin': { lat: 44.9625, lng: -93.2700, name: 'Franklin Avenue' },
  'franklin ave': { lat: 44.9625, lng: -93.2700, name: 'Franklin Avenue' },
  'broadway': { lat: 45.0000, lng: -93.2900, name: 'Broadway' },
  'central ave': { lat: 45.0000, lng: -93.2470, name: 'Central Avenue' },
  'washington ave': { lat: 44.9800, lng: -93.2600, name: 'Washington Avenue' },
  'university ave': { lat: 44.9550, lng: -93.2300, name: 'University Avenue' },
  'chicago ave': { lat: 44.9400, lng: -93.2616, name: 'Chicago Avenue' },
  'portland ave': { lat: 44.9366, lng: -93.2616, name: 'Portland Avenue' },
  'bloomington ave': { lat: 44.9400, lng: -93.2450, name: 'Bloomington Avenue' },
  '38th street': { lat: 44.9340, lng: -93.2616, name: '38th Street' },
  '38th st': { lat: 44.9340, lng: -93.2616, name: '38th Street' },
  '46th street': { lat: 44.9220, lng: -93.2616, name: '46th Street' },
  
  // Neighborhoods
  'cedar riverside': { lat: 44.9697, lng: -93.2543, name: 'Cedar-Riverside' },
  'cedar-riverside': { lat: 44.9697, lng: -93.2543, name: 'Cedar-Riverside' },
  'west bank': { lat: 44.9697, lng: -93.2543, name: 'West Bank' },
  'phillips': { lat: 44.9550, lng: -93.2616, name: 'Phillips' },
  'powderhorn': { lat: 44.9366, lng: -93.2590, name: 'Powderhorn' },
  'uptown': { lat: 44.9480, lng: -93.2980, name: 'Uptown' },
  'downtown': { lat: 44.9778, lng: -93.2650, name: 'Downtown' },
  'north minneapolis': { lat: 45.0050, lng: -93.2950, name: 'North Minneapolis' },
  'north mpls': { lat: 45.0050, lng: -93.2950, name: 'North Minneapolis' },
  'northeast': { lat: 45.0000, lng: -93.2470, name: 'Northeast Minneapolis' },
  'northeast minneapolis': { lat: 45.0000, lng: -93.2470, name: 'Northeast Minneapolis' },
  'south minneapolis': { lat: 44.9200, lng: -93.2680, name: 'South Minneapolis' },
  'south mpls': { lat: 44.9200, lng: -93.2680, name: 'South Minneapolis' },
  'longfellow': { lat: 44.9400, lng: -93.2200, name: 'Longfellow' },
  'nokomis': { lat: 44.9100, lng: -93.2400, name: 'Nokomis' },
  'calhoun': { lat: 44.9480, lng: -93.3100, name: 'Calhoun/Bde Maka Ska' },
  'bde maka ska': { lat: 44.9480, lng: -93.3100, name: 'Bde Maka Ska' },
  'loring park': { lat: 44.9690, lng: -93.2850, name: 'Loring Park' },
  'elliot park': { lat: 44.9680, lng: -93.2600, name: 'Elliot Park' },
  'midtown': { lat: 44.9486, lng: -93.2590, name: 'Midtown' },
  'seward': { lat: 44.9550, lng: -93.2350, name: 'Seward' },
  
  // Landmarks
  'target center': { lat: 44.9795, lng: -93.2761, name: 'Target Center' },
  'us bank stadium': { lat: 44.9736, lng: -93.2575, name: 'US Bank Stadium' },
  'mall of america': { lat: 44.8549, lng: -93.2422, name: 'Mall of America' },
  'msp airport': { lat: 44.8848, lng: -93.2223, name: 'MSP Airport' },
  'minneapolis airport': { lat: 44.8848, lng: -93.2223, name: 'MSP Airport' },
  'target field': { lat: 44.9817, lng: -93.2776, name: 'Target Field' },
  'stone arch bridge': { lat: 44.9808, lng: -93.2558, name: 'Stone Arch Bridge' },
  'minnehaha falls': { lat: 44.9153, lng: -93.2110, name: 'Minnehaha Falls' },
  'george floyd square': { lat: 44.9340, lng: -93.2616, name: 'George Floyd Square' },
  'cup foods': { lat: 44.9340, lng: -93.2616, name: '38th & Chicago' },
  
  // St. Paul
  'st paul': { lat: 44.9537, lng: -93.0900, name: 'St. Paul' },
  'saint paul': { lat: 44.9537, lng: -93.0900, name: 'St. Paul' },
  'west st paul': { lat: 44.9163, lng: -93.1066, name: 'West St. Paul' },
  'east side st paul': { lat: 44.9700, lng: -93.0500, name: 'East Side St. Paul' },
  
  // Transit
  'lake street station': { lat: 44.9486, lng: -93.2040, name: 'Lake Street Station' },
  'target field station': { lat: 44.9830, lng: -93.2770, name: 'Target Field Station' },
  'warehouse district': { lat: 44.9830, lng: -93.2750, name: 'Warehouse District' },
  
  // Generic Minneapolis
  'minneapolis': { lat: 44.9778, lng: -93.2650, name: 'Minneapolis' },
  'mpls': { lat: 44.9778, lng: -93.2650, name: 'Minneapolis' },
  'twin cities': { lat: 44.9600, lng: -93.1700, name: 'Twin Cities' },
  'minnesota': { lat: 44.9778, lng: -93.2650, name: 'Minnesota' }
};

// Note: extractLocationFromText is defined below with MPLS_LOCATION_PATTERNS (regex-based)
// This geocodeNewsItems function works with that version

// Geocode a batch of news items (uses the regex-based extractLocationFromText defined later)
async function geocodeNewsItems(newsItems) {
  return newsItems.map(item => {
    // If already has coordinates, skip
    if (item.lat && item.lng) return item;
    
    // Try to extract location from title/text using the regex-based function
    const location = extractLocationFromTextRegex(item.title) || 
                     extractLocationFromTextRegex(item.summary) ||
                     extractLocationFromTextRegex(item.description);
    
    if (location) {
      return {
        ...item,
        lat: location.lat,
        lng: location.lng,
        locationName: location.name,
        locationConfidence: location.confidence,
        locationSource: 'extracted'
      };
    }
    
    return item;
  });
}

// ============================================
// ICE WATCHER - AI Agent for ICE Activity Detection
// ============================================

class ICEWatcher {
  constructor(anthropicClient) {
    this.anthropic = anthropicClient;
    this.status = 'monitoring';
    this.stats = {
      activations: 0,
      alertsGenerated: 0,
      reportsProcessed: 0
    };
    this.recentAlerts = [];
    this.scannerMentions = [];
    
    // Keywords that might indicate ICE activity on scanner
    this.triggers = [
      'federal', 'immigration', 'ice', 'i.c.e.', 'border patrol', 'cbp',
      'detainer', 'deportation', 'homeland', 'dhs', 'warrant', 'federal agents',
      'unmarked', 'plain clothes', 'federal building', 'whipple', 'fort snelling',
      'interpreter', 'translator', 'spanish speaking', 'somali speaking',
      'federal custody', 'transfer', 'immigration hold', 'civil arrest'
    ];
    
    this.systemPrompt = `You are ICE WATCHER, an AI agent monitoring police scanner traffic for potential ICE (Immigration and Customs Enforcement) activity in Minneapolis.

Your job is to analyze scanner transcripts and identify:
1. Direct mentions of ICE, federal agents, immigration enforcement
2. Indirect indicators: unmarked vehicles, plain clothes officers, federal warrants
3. Coordination with federal agencies
4. Activity near known ICE facilities (Whipple Federal Building, detention centers)
5. Mentions of interpreters or specific immigrant communities that might indicate targeted enforcement

KNOWN ICE LOCATIONS IN MINNEAPOLIS:
- Whipple Federal Building, Fort Snelling (ICE HQ)
- Sherburne County Jail (primary detention)
- Lake Street corridor (high enforcement area)
- Cedar-Riverside (Somali community)

When you detect potential ICE activity, respond with JSON:
{
  "isICEActivity": true/false,
  "confidence": "HIGH/MEDIUM/LOW",
  "activityType": "raid/checkpoint/surveillance/arrest/transport/patrol/unknown",
  "location": "specific location if mentioned",
  "description": "brief description",
  "urgency": "critical/high/medium/low",
  "indicators": ["list", "of", "indicators"]
}

Be cautious - not every federal mention is ICE. Focus on immigration-specific activity.`;
  }
  
  shouldAnalyze(transcript) {
    const lower = transcript.toLowerCase();
    return this.triggers.some(trigger => lower.includes(trigger));
  }
  
  async analyzeTranscript(transcript, cityId = 'mpls') {
    if (cityId !== 'mpls') return null;
    if (!this.shouldAnalyze(transcript)) return null;
    
    this.status = 'analyzing';
    this.stats.activations++;
    
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        system: this.systemPrompt,
        messages: [{
          role: "user",
          content: `Analyze this Minneapolis police scanner transcript for potential ICE activity:\n\n"${transcript}"`
        }]
      });
      
      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        if (result.isICEActivity && result.confidence !== 'LOW') {
          const alert = {
            id: `ice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...result,
            transcript: transcript.substring(0, 200),
            timestamp: new Date().toISOString(),
            source: 'scanner'
          };
          
          this.recentAlerts.unshift(alert);
          if (this.recentAlerts.length > 50) this.recentAlerts.pop();
          
          this.scannerMentions.unshift({
            transcript: transcript.substring(0, 300),
            analysis: result,
            timestamp: new Date().toISOString()
          });
          if (this.scannerMentions.length > 100) this.scannerMentions.pop();
          
          this.stats.alertsGenerated++;
          console.log(`[ICE WATCHER] ⚠️ ALERT: ${result.activityType} at ${result.location || 'unknown'} (${result.confidence})`);
          
          return alert;
        }
      }
      
      return null;
    } catch (error) {
      console.error('[ICE WATCHER] Error:', error.message);
      return null;
    } finally {
      this.status = 'monitoring';
    }
  }
  
  getStatus() {
    return {
      id: 'ICEWATCHER',
      name: 'ICE WATCHER',
      icon: '🚨',
      role: 'Immigration Enforcement Monitor',
      status: this.status,
      stats: this.stats,
      recentAlerts: this.recentAlerts.slice(0, 10),
      lastActivity: this.recentAlerts[0]?.timestamp || null
    };
  }
  
  getAlerts(limit = 20) {
    return this.recentAlerts.slice(0, limit);
  }
  
  getScannerMentions(limit = 50) {
    return this.scannerMentions.slice(0, limit);
  }
}

// Initialize ICE Watcher
const iceWatcher = new ICEWatcher(anthropic);
console.log('[ICE WATCHER] 🚨 Minneapolis ICE activity monitoring initialized');

// ============================================
// ICE COMMUNITY REPORTING SYSTEM
// ============================================

function addICEReport(report) {
  const newReport = {
    id: `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    ...report,
    verified: false,
    verificationCount: 0,
    timestamp: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() // 4 hours
  };
  
  iceReports.unshift(newReport);
  if (iceReports.length > MAX_ICE_REPORTS) iceReports.pop();
  
  console.log(`[ICE REPORT] New report: ${report.activityType} at ${report.location}`);
  
  return newReport;
}

function verifyICEReport(reportId, isVerified) {
  const report = iceReports.find(r => r.id === reportId);
  if (report) {
    if (isVerified) {
      report.verificationCount++;
      if (report.verificationCount >= 2) {
        report.verified = true;
      }
    }
    return report;
  }
  return null;
}

function getActiveICEReports() {
  const now = new Date();
  return iceReports.filter(r => new Date(r.expiresAt) > now);
}

// Function to get ICE facility status
function getICEFacilityStatus(facilityId) {
  const facility = MPLS_ICE_FACILITIES.find(f => f.id === facilityId);
  if (!facility) return null;
  
  const hour = new Date().getHours();
  const isBusinessHours = hour >= 6 && hour < 22;
  
  return {
    ...facility,
    operationalStatus: isBusinessHours ? 'active' : 'reduced',
    lastKnownActivity: new Date().toISOString(),
    nearbyReports: getActiveICEReports().filter(r => {
      // Check if report is within ~5 miles of facility
      const dist = Math.sqrt(
        Math.pow(r.lat - facility.lat, 2) + Math.pow(r.lng - facility.lng, 2)
      );
      return dist < 0.1; // Roughly 5-7 miles
    }).length
  };
}

// Get all ICE facilities status
function getAllICEFacilitiesStatus() {
  const activeReports = getActiveICEReports();
  const totalDetainees = MPLS_ICE_FACILITIES
    .filter(f => f.type === 'detention_center')
    .reduce((sum, f) => sum + (f.iceDetainees || 0), 0);
  
  return {
    facilities: MPLS_ICE_FACILITIES.map(f => ({
      ...f,
      recentReportsNearby: activeReports.filter(r => {
        if (!r.lat || !r.lng) return false;
        const dist = Math.sqrt(Math.pow(r.lat - f.lat, 2) + Math.pow(r.lng - f.lng, 2));
        return dist < 0.1;
      }).length
    })),
    totalDetainees,
    totalFacilities: MPLS_ICE_FACILITIES.length,
    detentionFacilities: MPLS_ICE_FACILITIES.filter(f => f.type === 'detention_center').length,
    activeReportsCount: activeReports.length,
    stats: ICE_STATS_STPAUL,
    hotspots: ICE_HOTSPOTS_MPLS,
    timestamp: new Date().toISOString()
  };
}

// ============================================
// CAMERAS & SCANNER - MULTI-CITY
// ============================================

// Legacy variables for backwards compatibility (default to NYC)
let cameras = [];
const incidents = [];
let incidentId = 0;
const recentTranscripts = [];
const MAX_TRANSCRIPTS = 20;
const audioClips = new Map();
const MAX_AUDIO_CLIPS = 50;

// Fetch cameras for a specific city
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
      // Also set legacy variable
      cameras = cityState[cityId].cameras;
      console.log(`[${city.shortName}] Loaded ${cityState[cityId].cameras.length} traffic cameras`);
    } 
    else if (cityId === 'mpls') {
      // MnDOT 511 API for Minnesota cameras - try multiple endpoints
      try {
        // Try the MnDOT CCTV GeoJSON endpoint
        let cameras = [];
        
        // Primary: MnDOT Open Data Portal
        const endpoints = [
          'https://511mn.org/api/getcameras?format=json',
          'https://services.arcgis.com/BG6nSlhZSAWtExvp/arcgis/rest/services/MnDOT_CCTV_Camera_Locations/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson',
        ];
        
        for (const endpoint of endpoints) {
          try {
            const response = await fetch(endpoint, { 
              timeout: 10000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (response.ok) {
              const data = await response.json();
              const features = data.features || data.cameraData || data || [];
              
              if (features.length > 0) {
                // Filter to Minneapolis metro area
                const mplsLat = 44.9778, mplsLng = -93.2650, radiusMiles = 30;
                
                cameras = features
                  .filter(cam => {
                    const lat = cam.geometry?.coordinates?.[1] || cam.attributes?.LAT || cam.latitude || cam.lat;
                    const lng = cam.geometry?.coordinates?.[0] || cam.attributes?.LONG || cam.longitude || cam.lng;
                    if (!lat || !lng) return false;
                    const distance = Math.sqrt(Math.pow(lat - mplsLat, 2) + Math.pow(lng - mplsLng, 2)) * 69;
                    return distance < radiusMiles;
                  })
                  .map(cam => {
                    const id = cam.attributes?.DEVICEID || cam.properties?.id || cam.id || `mpls-${Math.random().toString(36).substr(2, 6)}`;
                    const lat = cam.geometry?.coordinates?.[1] || cam.attributes?.LAT || cam.latitude;
                    const lng = cam.geometry?.coordinates?.[0] || cam.attributes?.LONG || cam.longitude;
                    const name = cam.attributes?.DESCRIPTION || cam.properties?.description || cam.properties?.name || cam.name || 'MnDOT Camera';
                    const imageUrl = cam.attributes?.IMAGEURL || cam.properties?.imageUrl || `https://video.dot.state.mn.us/public/${id}.jpg`;
                    
                    return {
                      id,
                      location: name,
                      lat,
                      lng,
                      area: 'Minneapolis',
                      imageUrl,
                      isOnline: true,
                      city: 'mpls'
                    };
                  });
                
                if (cameras.length > 0) {
                  console.log(`[${city.shortName}] Loaded ${cameras.length} cameras from ${endpoint.split('/')[2]}`);
                  break;
                }
              }
            }
          } catch (e) {
            // Try next endpoint
          }
        }
        
        if (cameras.length > 0) {
          cityState[cityId].cameras = cameras;
        } else {
          throw new Error('No cameras from any endpoint');
        }
        
        console.log(`[${city.shortName}] Loaded ${cityState[cityId].cameras.length} traffic cameras`);
      } catch (e) {
        console.log(`[${city.shortName}] MnDOT API error, using expanded fallback cameras`);
        // MnDOT camera IDs - correct URL format: https://video.dot.state.mn.us/video/image/metro/{ID}
        cityState[cityId].cameras = [
          // Downtown Minneapolis - I-394/I-94 interchange area
          { id: 'C856', location: 'I-394 at Penn Ave', lat: 44.9697, lng: -93.3100, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C856' },
          { id: 'C852', location: 'I-394 at Dunwoody', lat: 44.9680, lng: -93.2898, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C852' },
          { id: 'C107', location: 'I-94 at Hennepin Ave', lat: 44.9738, lng: -93.2780, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C107' },
          { id: 'C103', location: 'I-94 at 5th St N', lat: 44.9798, lng: -93.2690, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C103' },
          // I-35W Corridor
          { id: 'C620', location: 'I-35W at Washington Ave', lat: 44.9738, lng: -93.2590, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C620' },
          { id: 'C615', location: 'I-35W at University Ave', lat: 44.9700, lng: -93.2473, area: 'Downtown', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C615' },
          { id: 'C633', location: 'I-35W at Lake St', lat: 44.9486, lng: -93.2505, area: 'South', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C633' },
          { id: 'C637', location: 'I-35W at 46th St', lat: 44.9220, lng: -93.2505, area: 'South', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C637' },
          { id: 'C645', location: 'I-35W at 66th St', lat: 44.8780, lng: -93.2505, area: 'Richfield', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C645' },
          // I-94 West/North
          { id: 'C113', location: 'I-94 at Lowry Ave', lat: 45.0050, lng: -93.2850, area: 'North', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C113' },
          { id: 'C117', location: 'I-94 at Dowling Ave', lat: 45.0150, lng: -93.2980, area: 'North', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C117' },
          { id: 'C121', location: 'I-94 at Brooklyn Blvd', lat: 45.0280, lng: -93.3350, area: 'Brooklyn Center', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C121' },
          // I-494 South Metro
          { id: 'C381', location: 'I-494 at France Ave', lat: 44.8650, lng: -93.3340, area: 'Bloomington', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C381' },
          { id: 'C385', location: 'I-494 at Lyndale Ave', lat: 44.8650, lng: -93.2878, area: 'Bloomington', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C385' },
          { id: 'C389', location: 'I-494 at 34th Ave S', lat: 44.8550, lng: -93.2200, area: 'Bloomington', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C389' },
          // St Paul / I-94 East
          { id: 'C177', location: 'I-94 at Snelling Ave', lat: 44.9550, lng: -93.1670, area: 'St Paul', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C177' },
          { id: 'C181', location: 'I-94 at Lexington Pkwy', lat: 44.9550, lng: -93.1470, area: 'St Paul', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C181' },
          { id: 'C681', location: 'I-35E at Maryland Ave', lat: 44.9780, lng: -93.0920, area: 'St Paul', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C681' },
          // I-694 North
          { id: 'C245', location: 'I-694 at Rice St', lat: 45.0650, lng: -93.1050, area: 'Roseville', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C245' },
          { id: 'C249', location: 'I-694 at Lexington Ave', lat: 45.0650, lng: -93.1470, area: 'Shoreview', city: 'mpls', imageUrl: 'https://video.dot.state.mn.us/video/image/metro/C249' },
        ];
        console.log(`[${city.shortName}] Using ${cityState[cityId].cameras.length} fallback cameras`);
      }
    }
  } catch (error) {
    console.error(`[${city.shortName}] Failed to fetch cameras:`, error.message);
  }
}

// Load cameras for all cities
async function initAllCityCameras() {
  for (const cityId of Object.keys(CITIES)) {
    await fetchCamerasForCity(cityId);
  }
}
initAllCityCameras();

// Throttling for transcript broadcasts
const lastTranscriptBroadcast = { nyc: 0, mpls: 0 };
const TRANSCRIPT_THROTTLE_MS = 500; // Min 500ms between transcript broadcasts

// City-specific broadcast
function broadcastToCity(cityId, data) {
  // Throttle transcript broadcasts to prevent flashing
  if (data.type === 'transcript') {
    const now = Date.now();
    if (now - lastTranscriptBroadcast[cityId] < TRANSCRIPT_THROTTLE_MS) {
      return; // Skip this broadcast, too soon after last one
    }
    lastTranscriptBroadcast[cityId] = now;
  }
  
  const message = JSON.stringify({ ...data, city: cityId });
  const cityClients = cityState[cityId]?.clients || new Set();
  cityClients.forEach(client => { 
    if (client.readyState === 1) client.send(message); 
  });
}

// Global broadcast (all cities)
function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => { if (client.readyState === 1) client.send(message); });
}

// Broadcastify Scanner - MULTI-STREAM for maximum coverage
const BROADCASTIFY_USERNAME = 'whitefang123';
const BROADCASTIFY_PASSWORD = process.env.BROADCASTIFY_PASSWORD;

// NYC Feeds
const NYPD_FEEDS = [
  { id: '40184', name: 'NYPD Citywide 1', city: 'nyc' },
  { id: '40185', name: 'NYPD Citywide 2', city: 'nyc' },
  { id: '40186', name: 'NYPD Citywide 3', city: 'nyc' },
  { id: '32119', name: 'NYPD Dispatch Citywide', city: 'nyc' },
];

// Minneapolis Feeds
const MPLS_FEEDS = [
  { id: '13544', name: 'Minneapolis Police', city: 'mpls' },
  { id: '26049', name: 'Hennepin County Sheriff', city: 'mpls' },
  { id: '741', name: 'Minneapolis Fire Dispatch', city: 'mpls' },
];

// Combined feeds for multi-city streaming
const ALL_FEEDS = [...NYPD_FEEDS, ...MPLS_FEEDS];

// Run 4 streams simultaneously for 4x the coverage
const MAX_CONCURRENT_STREAMS = 4;
let activeStreams = new Map();
let streamStats = {};

// ============================================
// OPENMHZ - MULTI-CITY SUPPORT
// ============================================
const OPENMHZ_SYSTEMS = {
  nyc: { system: 'nypd', name: 'NYPD' },
  mpls: { system: 'mnhennco', name: 'Hennepin County' }
};
const OPENMHZ_POLL_INTERVAL = 20000;

// Per-city OpenMHz state
const openMHzState = {
  nyc: { lastTime: Date.now() - (5 * 60 * 1000), stats: { callsFetched: 0, callsProcessed: 0, lastPoll: null, errors: 0, disabled: false, method: null } },
  mpls: { lastTime: Date.now() - (5 * 60 * 1000), stats: { callsFetched: 0, callsProcessed: 0, lastPoll: null, errors: 0, disabled: false, method: null } }
};

// Legacy reference for backwards compatibility
let lastOpenMHzTime = Date.now() - (5 * 60 * 1000);
let openMHzStats = openMHzState.nyc.stats;

// Socket.IO for real-time (preferred method) - tries both cities
async function startOpenMHzSocketIO() {
  try {
    const { io } = await import('socket.io-client');
    
    for (const [cityId, config] of Object.entries(OPENMHZ_SYSTEMS)) {
      console.log(`[OPENMHZ-${cityId.toUpperCase()}] Connecting via Socket.IO...`);
      
      const socket = io('https://api.openmhz.com', {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 5000
      });
      
      socket.on('connect', () => {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] ✓ Socket.IO connected!`);
        openMHzState[cityId].stats.method = 'socketio';
        socket.emit('subscribe', { system: config.system });
      });
      
      socket.on('new message', async (call) => {
        openMHzState[cityId].stats.callsFetched++;
        const tg = call.talkgroupNum || call.talkgroup || 'unknown';
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Real-time call: TG ${tg}`);
        
        if (call.url) {
          processOpenMHzCall(call, cityId);
        }
      });
      
      socket.on('disconnect', (reason) => {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Socket.IO disconnected:`, reason);
      });
      
      socket.on('connect_error', (error) => {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Socket.IO error:`, error.message);
        openMHzState[cityId].stats.errors++;
        socket.disconnect();
      });
    }
  } catch (error) {
    console.log('[OPENMHZ] Socket.IO not available, using polling');
    startOpenMHzPolling();
  }
}

async function startOpenMHzPolling() {
  console.log('[OPENMHZ] Starting polling mode for all cities...');
  
  // Poll each city's system
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
      
      if (!state.stats.method) {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Polling: ${url}`);
      }
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Origin': 'https://openmhz.com',
          'Referer': 'https://openmhz.com/'
        }
      });
      
      if (!response.ok) {
        consecutiveErrors++;
        state.stats.errors++;
        
        if (consecutiveErrors <= 3) {
          console.log(`[OPENMHZ-${cityId.toUpperCase()}] API error ${response.status}: ${response.statusText}`);
        }
        
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
      
      if (state.stats.callsFetched === 0 && calls.length === 0) {
        console.log(`[OPENMHZ-${cityId.toUpperCase()}] Polling... (waiting for new calls)`);
      }
      
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
      if (consecutiveErrors < 3) {
        console.error(`[OPENMHZ-${cityId.toUpperCase()}] Poll error:`, error.message);
      }
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
    
    const talkgroupName = call.talkgroupDescription || call.talkgroupTag || `TG ${call.talkgroupNum}`;
    console.log(`[OPENMHZ-${cityId.toUpperCase()}] (${talkgroupName}): "${clean.substring(0, 80)}..."`);
    
    // Duplicate detection
    const state = cityState[cityId];
    const transcriptHash = clean.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (state.recentTranscriptHashes.has(transcriptHash)) {
      console.log(`[OPENMHZ-${cityId.toUpperCase()}] Skipping duplicate: "${clean.substring(0, 40)}..."`);
      return;
    }
    state.recentTranscriptHashes.add(transcriptHash);
    if (state.recentTranscriptHashes.size > 100) {
      const hashArray = Array.from(state.recentTranscriptHashes);
      state.recentTranscriptHashes = new Set(hashArray.slice(-50));
    }
    
    const transcriptEntry = { 
      text: clean, 
      source: `OpenMHz: ${talkgroupName}`,
      talkgroup: call.talkgroupNum,
      city: cityId,
      timestamp: call.time || new Date().toISOString()
    };
    
    // Store in city-specific state
    state.recentTranscripts.unshift(transcriptEntry);
    if (state.recentTranscripts.length > MAX_TRANSCRIPTS) state.recentTranscripts.pop();
    
    // Also store in global for backwards compatibility (NYC only)
    if (cityId === 'nyc') {
      recentTranscripts.unshift(transcriptEntry);
      if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
    }
    
    broadcastToCity(cityId, { type: "transcript", ...transcriptEntry });
    
    const parsed = await parseTranscriptForCity(clean, cityId);
    
    if (parsed.hasIncident) {
      state.incidentId++;
      const camera = findNearestCameraForCity(parsed.location, parsed.borough, cityId);
      
      const incident = {
        id: state.incidentId, ...parsed, transcript: clean,
        source: `OpenMHz: ${talkgroupName}`, camera,
        lat: camera?.lat, lng: camera?.lng,
        city: cityId,
        timestamp: call.time || new Date().toISOString()
      };
      
      state.incidents.unshift(incident);
      if (state.incidents.length > 50) state.incidents.pop();
      
      // Also store in global for backwards compatibility (NYC only)
      if (cityId === 'nyc') {
        incidents.unshift(incident);
        if (incidents.length > 50) incidents.pop();
      }
      
      detectiveBureaus[cityId].processIncident(incident, (data) => broadcastToCity(cityId, data));
      if (cityId === 'nyc') checkBetsForIncident(incident);
      
      broadcastToCity(cityId, { type: "incident", incident });
      if (camera) broadcastToCity(cityId, { type: "camera_switch", camera, reason: `${parsed.incidentType} at ${parsed.location}` });
      
      console.log(`[OPENMHZ-${cityId.toUpperCase()} INCIDENT]`, incident.incidentType, '@', incident.location, `(${incident.borough})`);
    }
    
    // ICE WATCHER: Analyze Minneapolis transcripts for ICE activity
    if (cityId === 'mpls' && iceWatcher) {
      const iceAlert = await iceWatcher.analyzeTranscript(clean, cityId);
      if (iceAlert) {
        broadcastToCity(cityId, {
          type: 'ice_alert',
          alert: iceAlert,
          timestamp: new Date().toISOString()
        });
        console.log(`[ICE WATCHER] 🚨 Alert: ${iceAlert.activityType} - ${iceAlert.description}`);
      }
    }
  } catch (error) { /* silent */ }
}

// Try Socket.IO first, fall back to polling
setTimeout(() => {
  startOpenMHzSocketIO().catch(() => startOpenMHzPolling());
}, 3000);

// Per-stream state tracking
const streamState = new Map(); // feedId -> { chunks, lastDataTime, lastProcessTime }
const CHUNK_DURATION = 15000; // Reduced to 15s for more frequent processing

let scannerStats = { 
  activeFeeds: [], 
  lastChunkTime: null, 
  lastTranscript: null, 
  totalChunks: 0, 
  successfulTranscripts: 0,
  feedStats: {}
};

// Connect to a single feed
function connectToFeed(feed) {
  if (!BROADCASTIFY_PASSWORD) return;
  if (activeStreams.has(feed.id)) return; // Already connected
  
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
      // Try to replace with another feed
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
  
  // Initialize state for this stream
  streamState.set(feed.id, {
    chunks: [],
    lastDataTime: Date.now(),
    lastProcessTime: Date.now()
  });
  
  scannerStats.activeFeeds = Array.from(activeStreams.keys()).map(id => 
    NYPD_FEEDS.find(f => f.id === id)?.name || id
  );
  
  if (!scannerStats.feedStats[feed.id]) {
    scannerStats.feedStats[feed.id] = { name: feed.name, chunks: 0, incidents: 0 };
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
      
      scannerStats.lastChunkTime = new Date().toISOString();
      scannerStats.totalChunks++;
      scannerStats.feedStats[feed.id].chunks++;
      
      if (fullBuffer.length > 5000) { // Only process if substantial audio
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
  
  // Prefer NYC feeds first, then Minneapolis
  const availableFeeds = ALL_FEEDS.filter(f => !activeStreams.has(f.id));
  if (availableFeeds.length === 0) return;
  
  connectToFeed(availableFeeds[0]);
}

// Start multiple streams for both cities
function startMultiStreamBroadcastify() {
  if (!BROADCASTIFY_PASSWORD) { 
    console.log('[MULTI-STREAM] BROADCASTIFY_PASSWORD not set'); 
    return; 
  }
  
  console.log(`[MULTI-STREAM] Starting ${MAX_CONCURRENT_STREAMS} simultaneous feeds (NYC + MPLS)...`);
  console.log(`[MULTI-STREAM] Auth: ${BROADCASTIFY_USERNAME} / ${'*'.repeat(BROADCASTIFY_PASSWORD.length)}`);
  
  // Balance between NYC and Minneapolis - 3 NYC, 1 MPLS
  const initialFeeds = [
    ...NYPD_FEEDS.slice(0, 3),  // 3 NYC feeds
    ...MPLS_FEEDS.slice(0, 1),  // 1 Minneapolis feed
  ].slice(0, MAX_CONCURRENT_STREAMS);
  
  initialFeeds.forEach((feed, i) => {
    setTimeout(() => connectToFeed(feed), i * 2000); // Stagger connections
  });
}

// Legacy function name for compatibility
async function startBroadcastifyStream() {
  startMultiStreamBroadcastify();
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

// City-specific camera lookup
function findNearestCameraForCity(location, borough, cityId) {
  const cityCameras = cityState[cityId]?.cameras || [];
  if (cityCameras.length === 0) return null;
  
  let searchCameras = cityCameras;
  
  // Filter by area/district
  if (borough && borough !== 'Unknown') {
    const areaCameras = cityCameras.filter(cam => 
      cam.area?.toLowerCase().includes(borough.toLowerCase())
    );
    if (areaCameras.length > 0) searchCameras = areaCameras;
  }
  
  // Try to match by location string
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

// City-specific transcript parsing
async function parseTranscriptForCity(transcript, cityId) {
  if (cityId === 'mpls') {
    return parseTranscriptMPLS(transcript);
  }
  return parseTranscript(transcript);
}

// Minneapolis-specific transcript parsing
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

COMMON MINNEAPOLIS STREETS:
- Hennepin Avenue, Lyndale Avenue, Nicollet Avenue, Lake Street, Franklin Avenue
- Broadway, Washington Avenue, University Avenue, Central Avenue
- 35th St, 38th St, 46th St, 50th St, Chicago Avenue, Portland Avenue

If NO location can be determined, set location to null.

INCIDENT TYPE MAPPING:
- Code 3: Emergency response
- Shots fired, shooting → Shots Fired
- Domestic, DV → Domestic
- Robbery, theft → Robbery/Theft
- Assault, fight → Assault
- EDP, mental health → Mental Health Crisis

Respond ONLY with valid JSON:
{
  "hasIncident": boolean,
  "incidentType": "string describing incident",
  "location": "specific location or null if none found",
  "borough": "Downtown/North/Northeast/South/Southwest/Uptown/Unknown",
  "units": ["unit IDs mentioned"],
  "priority": "CRITICAL/HIGH/MEDIUM/LOW",
  "summary": "brief summary",
  "precinctMentioned": "number or null"
}`,
      messages: [{ role: "user", content: `Parse this Minneapolis police radio transmission and extract any location information:\n\n"${transcript}"` }]
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

async function processAudioFromStream(buffer, feedName, feedId = null) {
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
    console.log(`[${feedName}] Filtered short transcript: "${transcript.trim()}"`);
    return;
  }
  
  const clean = transcript.trim();
  const lower = clean.toLowerCase();
  
  // Filter out Whisper prompt leakage (when it hallucinates the prompt back)
  const promptLeakage = [
    'addresses like', 'intersections like', 'landmarks like', 
    'nypd police radio dispatch',
    '10-4, 10-13, 10-85',  // Exact prompt phrase
    'forthwith, precinct, sector, central',  // Exact prompt phrase
    'k, forthwith, precinct',
    '42nd and lex', 'times square, penn station'  // Example phrases from prompt
  ];
  if (promptLeakage.some(p => lower.includes(p))) {
    scannerStats.filteredPromptLeak = (scannerStats.filteredPromptLeak || 0) + 1;
    console.log(`[${feedName}] Filtered prompt leak: "${clean.substring(0, 50)}"`);
    return;
  }
  
  // Also filter if it contains multiple prompt keywords (likely hallucination)
  const promptKeywords = ['10-4', '10-13', '10-85', 'forthwith', 'precinct', 'sector', 'central', 'responding'];
  const keywordCount = promptKeywords.filter(kw => lower.includes(kw)).length;
  if (keywordCount >= 5) {
    scannerStats.filteredPromptLeak = (scannerStats.filteredPromptLeak || 0) + 1;
    console.log(`[${feedName}] Filtered prompt leak (${keywordCount} keywords): "${clean.substring(0, 50)}"`);
    return;
  }
  
  // Filter out noise - only exact matches
  const noise = ['thank you', 'thanks for watching', 'subscribe', 'you', 'bye', 'music', 'you.', 'bye.'];
  if (noise.includes(lower) || noise.includes(lower.replace(/[.,!?]/g, ''))) {
    scannerStats.filteredNoise = (scannerStats.filteredNoise || 0) + 1;
    console.log(`[${feedName}] Filtered noise: "${clean}"`);
    return;
  }
  
  // Filter out radio sign-offs and acknowledgments (not real incidents)
  const signOffPatterns = [
    'have a good night', 'have a good evening', 'have a good one',
    'good night', 'good evening', 'see you', 'take care',
    '10-4', '10-7', '10-8', '10-41', '10-42',
    'copy that', 'roger', 'affirmative',
    'going off duty', 'end of shift', 'signing off',
    'every night', 'every evening'
  ];
  if (signOffPatterns.some(pattern => lower.includes(pattern)) && lower.length < 50) {
    scannerStats.filteredSignOff = (scannerStats.filteredSignOff || 0) + 1;
    console.log(`[${feedName}] Filtered sign-off: "${clean}"`);
    return;
  }
  
  // Filter out actual Broadcastify ads - but be more specific
  if ((lower.includes('broadcastify') && lower.includes('premium')) || 
      lower.includes('fema.gov') || 
      lower.includes('support this feed') ||
      lower.includes('become a subscriber')) {
    scannerStats.filteredAd = (scannerStats.filteredAd || 0) + 1;
    console.log(`[${feedName}] Filtered ad: "${clean}"`);
    return;
  }
  
  // Filter out garbage/placeholder audio (wrong stream content)
  const garbagePatterns = [
    'un.org', 'un videos', 'united nations',
    'test broadcast', 'this is a test',
    'lorem ipsum', 'placeholder',
    'stream offline', 'feed offline',
    'no audio', 'audio unavailable'
  ];
  
  if (garbagePatterns.some(pattern => lower.includes(pattern))) {
    scannerStats.filteredGarbage = (scannerStats.filteredGarbage || 0) + 1;
    console.log(`[${feedName}] ⚠️ Garbage audio detected, disconnecting this feed`);
    // Disconnect this specific feed if we have its ID
    if (feedId && activeStreams.has(feedId)) {
      const streamInfo = activeStreams.get(feedId);
      if (streamInfo.req) streamInfo.req.destroy();
      activeStreams.delete(feedId);
      streamState.delete(feedId);
      // Try to connect to a replacement feed
      setTimeout(() => startNextAvailableFeed(), 3000);
    }
    return;
  }
  
  // Detect repetitive content (same phrase repeated multiple times = bad stream)
  const words = lower.split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 20 && uniqueWords.size < words.length * 0.3) {
    scannerStats.filteredRepetitive = (scannerStats.filteredRepetitive || 0) + 1;
    console.log(`[${feedName}] ⚠️ Repetitive content detected (${uniqueWords.size}/${words.length} unique words)`);
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
  scannerStats.lastTranscript = clean.substring(0, 200);
  scannerStats.successfulTranscripts++;
  
  // Determine which city this feed belongs to
  const feed = ALL_FEEDS.find(f => f.id === feedId);
  const cityId = feed?.city || 'nyc';
  const state = cityState[cityId];
  
  // Duplicate detection - create hash from first 50 chars of transcript
  const transcriptHash = clean.substring(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (state.recentTranscriptHashes.has(transcriptHash)) {
    console.log(`[${feedName}] Skipping duplicate: "${clean.substring(0, 40)}..."`);
    return;
  }
  state.recentTranscriptHashes.add(transcriptHash);
  // Keep hash set from growing too large - clear old ones
  if (state.recentTranscriptHashes.size > 100) {
    const hashArray = Array.from(state.recentTranscriptHashes);
    state.recentTranscriptHashes = new Set(hashArray.slice(-50));
  }
  
  // Track per-feed stats
  if (feedId && scannerStats.feedStats[feedId]) {
    scannerStats.feedStats[feedId].transcripts = (scannerStats.feedStats[feedId].transcripts || 0) + 1;
  }
  
  const transcriptEntry = { text: clean, source: feedName, city: cityId, timestamp: new Date().toISOString() };
  
  // Add to transcription verification queue (random sampling - ~20% of transcripts)
  if (Math.random() < 0.2 && clean.length > 30) {
    const audioId = `audio_trans_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    audioClips.set(audioId, buffer);
    addTranscriptionForVerification(clean, audioId, feedName);
  }
  
  // Store in city-specific state
  state.recentTranscripts.unshift(transcriptEntry);
  if (state.recentTranscripts.length > MAX_TRANSCRIPTS) state.recentTranscripts.pop();
  
  // Also store in global for backwards compatibility (NYC only)
  if (cityId === 'nyc') {
    recentTranscripts.unshift(transcriptEntry);
    if (recentTranscripts.length > MAX_TRANSCRIPTS) recentTranscripts.pop();
  }
  
  broadcastToCity(cityId, { type: "transcript", ...transcriptEntry });
  
  // Use city-specific parsing
  const parsed = await parseTranscriptForCity(clean, cityId);
  
  if (parsed.hasIncident) {
    state.incidentId++;
    const camera = findNearestCameraForCity(parsed.location, parsed.borough, cityId);
    
    const audioId = `audio_${cityId}_${state.incidentId}_${Date.now()}`;
    audioClips.set(audioId, buffer);
    if (audioClips.size > MAX_AUDIO_CLIPS) audioClips.delete(audioClips.keys().next().value);
    
    const incident = {
      id: state.incidentId,
      ...parsed,
      transcript: clean,
      audioUrl: `/audio/${audioId}`,
      camera,
      lat: camera?.lat,
      lng: camera?.lng,
      source: feedName,
      city: cityId,
      timestamp: new Date().toISOString()
    };
    
    state.incidents.unshift(incident);
    if (state.incidents.length > 50) state.incidents.pop();
    
    // Save to database (permanent archive)
    saveIncidentToDb(incident);
    
    // Also store in global for backwards compatibility (NYC only)
    if (cityId === 'nyc') {
      incidents.unshift(incident);
      if (incidents.length > 50) incidents.pop();
    }
    
    // Track per-feed incidents
    if (feedId && scannerStats.feedStats[feedId]) {
      scannerStats.feedStats[feedId].incidents = (scannerStats.feedStats[feedId].incidents || 0) + 1;
    }
    
    // Process through Detective Bureau
    detectiveBureaus[cityId].processIncident(incident, (data) => broadcastToCity(cityId, data));
    
    // Check bets (NYC only for now)
    if (cityId === 'nyc') checkBetsForIncident(incident);
    
    broadcastToCity(cityId, { type: "incident", incident });
    if (camera) broadcastToCity(cityId, { type: "camera_switch", camera, reason: `${parsed.incidentType} at ${parsed.location}`, priority: parsed.priority });
    
    console.log(`[${feedName}] 🚨 INCIDENT (${cityId.toUpperCase()}): ${incident.incidentType} @ ${incident.location} (${incident.borough})`);
  } else {
    // Broadcast as monitoring even if no incident detected
    broadcastToCity(cityId, {
      type: "analysis",
      text: `[MONITORING] ${clean.substring(0, 100)}...`,
      location: 'Unknown',
      city: cityId,
      timestamp: new Date().toISOString()
    });
  }
}

setTimeout(startBroadcastifyStream, 5000);

// ============================================
// BETTING FUNCTIONS
// ============================================

// Legacy function - now calls checkPredictionsForIncident
function checkBetsForIncident(incident) {
  checkPredictionsForIncident(incident);
}

// ============================================
// API ROUTES
// ============================================

// ============================================
// DETECTIVE BUREAU ENDPOINTS (City-specific)
// ============================================

// City-specific detective overview
app.get('/city/:cityId/detective/overview', (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  res.json(bureau.getAgentOverview());
});

// City-specific agent statuses
app.get('/city/:cityId/detective/agents', (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  res.json(bureau.getAgentStatuses());
});

// Get specific agent's full history
app.get('/city/:cityId/detective/agent/:agentId/history', (req, res) => {
  const { cityId, agentId } = req.params;
  const { limit = 50 } = req.query;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  
  const history = bureau.getAgentHistory(agentId.toUpperCase(), parseInt(limit));
  if (!history) return res.status(404).json({ error: 'Agent not found' });
  
  res.json(history);
});

// Trigger manual agent training/analysis
app.post('/city/:cityId/detective/train', async (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  
  console.log(`[DETECTIVE-${cityId.toUpperCase()}] Manual training triggered`);
  
  // Run all agents
  const results = {
    timestamp: new Date().toISOString(),
    city: cityId,
    agents: {}
  };
  
  try {
    // Run PATTERN analysis
    await bureau.runBackgroundPatternAnalysis();
    results.agents.PATTERN = 'completed';
  } catch (e) {
    results.agents.PATTERN = `error: ${e.message}`;
  }
  
  try {
    // Run PROPHET predictions
    await bureau.runProphet();
    results.agents.PROPHET = 'completed';
  } catch (e) {
    results.agents.PROPHET = `error: ${e.message}`;
  }
  
  try {
    // Run HISTORIAN analysis
    await bureau.runHistorianAnalysis();
    results.agents.HISTORIAN = 'completed';
  } catch (e) {
    results.agents.HISTORIAN = `error: ${e.message}`;
  }
  
  try {
    // Run CHASE readiness
    await bureau.runChaseReadiness();
    results.agents.CHASE = 'completed';
  } catch (e) {
    results.agents.CHASE = `error: ${e.message}`;
  }
  
  res.json({
    success: true,
    message: 'Training cycle completed',
    results,
    agentStatuses: bureau.getAgentStatuses()
  });
});

// City-specific predictions
app.get('/city/:cityId/detective/predictions', (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  res.json(bureau.getPredictionStats());
});

// City-specific patterns
app.get('/city/:cityId/detective/patterns', (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  res.json({
    active: bureau.memory.patterns.filter(p => p.status === 'active'),
    total: bureau.memory.patterns.length
  });
});

// City-specific hotspots
app.get('/city/:cityId/detective/hotspots', (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  const hotspots = Array.from(bureau.memory.hotspots.entries())
    .map(([key, count]) => {
      const [borough, location] = key.split('-');
      return { borough, location, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  res.json(hotspots);
});

// City-specific briefing
app.get('/city/:cityId/detective/briefing', async (req, res) => {
  const { cityId } = req.params;
  const bureau = detectiveBureaus[cityId];
  if (!bureau) return res.status(404).json({ error: 'City not found' });
  const briefing = await bureau.generateBriefing();
  res.json(briefing);
});

// ============================================
// MINNEAPOLIS ICE TRACKING ENDPOINTS
// ============================================

// Get all ICE facilities with status
app.get('/city/mpls/ice/facilities', (req, res) => {
  res.json(getAllICEFacilitiesStatus());
});

// Get specific ICE facility
app.get('/city/mpls/ice/facility/:facilityId', (req, res) => {
  const { facilityId } = req.params;
  const status = getICEFacilityStatus(facilityId);
  if (!status) return res.status(404).json({ error: 'Facility not found' });
  res.json(status);
});

// Get ICE statistics for St. Paul AOR
app.get('/city/mpls/ice/stats', (req, res) => {
  res.json({
    ...ICE_STATS_STPAUL,
    currentDetainees: MPLS_ICE_FACILITIES
      .filter(f => f.type === 'detention_center')
      .reduce((sum, f) => sum + (f.iceDetainees || 0), 0),
    facilitiesWithDetainees: MPLS_ICE_FACILITIES.filter(f => f.iceDetainees > 0).length,
    timestamp: new Date().toISOString()
  });
});

// Get ICE activity hotspots
app.get('/city/mpls/ice/hotspots', (req, res) => {
  const activeReports = getActiveICEReports();
  
  // Enhance hotspots with recent report counts
  const enhancedHotspots = ICE_HOTSPOTS_MPLS.map(hotspot => {
    const nearbyReports = activeReports.filter(r => {
      if (!r.lat || !r.lng) return false;
      const dist = Math.sqrt(Math.pow(r.lat - hotspot.lat, 2) + Math.pow(r.lng - hotspot.lng, 2));
      return dist < 0.02; // ~1-2 miles
    });
    return {
      ...hotspot,
      recentReports: nearbyReports.length,
      lastActivity: nearbyReports[0]?.timestamp || null
    };
  });
  
  res.json({
    hotspots: enhancedHotspots,
    totalActiveReports: activeReports.length,
    timestamp: new Date().toISOString()
  });
});

// ICE WATCHER Agent status
app.get('/city/mpls/ice/watcher', (req, res) => {
  if (!iceWatcher) return res.status(503).json({ error: 'ICE Watcher not initialized' });
  res.json(iceWatcher.getStatus());
});

// ICE WATCHER alerts
app.get('/city/mpls/ice/alerts', (req, res) => {
  const { limit = 20 } = req.query;
  if (!iceWatcher) return res.status(503).json({ error: 'ICE Watcher not initialized' });
  res.json({
    alerts: iceWatcher.getAlerts(parseInt(limit)),
    scannerMentions: iceWatcher.getScannerMentions(parseInt(limit)),
    stats: iceWatcher.stats,
    timestamp: new Date().toISOString()
  });
});

// Community ICE reports - GET active reports
app.get('/city/mpls/ice/reports', (req, res) => {
  const { limit = 50, verified = 'all' } = req.query;
  let reports = getActiveICEReports();
  
  if (verified === 'true') {
    reports = reports.filter(r => r.verified);
  } else if (verified === 'false') {
    reports = reports.filter(r => !r.verified);
  }
  
  res.json({
    reports: reports.slice(0, parseInt(limit)),
    total: reports.length,
    verified: reports.filter(r => r.verified).length,
    timestamp: new Date().toISOString()
  });
});

// Community ICE reports - POST new report
app.post('/city/mpls/ice/report', (req, res) => {
  const { 
    activityType,  // raid, checkpoint, surveillance, arrest, transport, patrol
    location,      // Address or description
    lat, lng,      // Coordinates if available
    description,   // Details
    vehicleInfo,   // Vehicle descriptions
    agentCount,    // Number of agents seen
    anonymous = true
  } = req.body;
  
  if (!activityType || !location) {
    return res.status(400).json({ error: 'activityType and location are required' });
  }
  
  // Validate activity type
  const validTypes = ['raid', 'checkpoint', 'surveillance', 'arrest', 'transport', 'patrol', 'vehicle_sighting', 'door_knock', 'workplace', 'other'];
  if (!validTypes.includes(activityType)) {
    return res.status(400).json({ error: `Invalid activityType. Must be one of: ${validTypes.join(', ')}` });
  }
  
  const report = addICEReport({
    activityType,
    location,
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
    description: description || '',
    vehicleInfo: vehicleInfo || '',
    agentCount: agentCount ? parseInt(agentCount) : null,
    source: 'community'
  });
  
  // Broadcast to Minneapolis clients
  broadcastToCity('mpls', {
    type: 'ice_report',
    report,
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, report });
});

// Verify a community report
app.post('/city/mpls/ice/report/:reportId/verify', (req, res) => {
  const { reportId } = req.params;
  const { verified = true } = req.body;
  
  const report = verifyICEReport(reportId, verified);
  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }
  
  // If now verified, broadcast update
  if (report.verified) {
    broadcastToCity('mpls', {
      type: 'ice_report_verified',
      report,
      timestamp: new Date().toISOString()
    });
  }
  
  res.json({ success: true, report });
});

// Get ICE news/events from scraped sources
app.get('/city/mpls/ice/news', async (req, res) => {
  const { limit = 20, refresh = false } = req.query;
  
  try {
    // Fetch fresh news if requested or cache is stale
    const news = refresh === 'true' ? await fetchICENewsLive() : iceNewsEvents;
    
    // Group by source type
    const bySource = {};
    news.forEach(n => {
      const source = n.source || 'Unknown';
      if (!bySource[source]) bySource[source] = 0;
      bySource[source]++;
    });
    
    res.json({
      news: (news.length > 0 ? news : iceNewsEvents).slice(0, parseInt(limit)),
      sources: ['Star Tribune', 'Minnesota Reformer', 'Reddit', 'Bluesky', 'Community Reports'],
      sourceBreakdown: bySource,
      lastFetch: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      news: iceNewsEvents.slice(0, parseInt(limit)),
      error: 'Using cached data: ' + error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Force refresh news
app.post('/city/mpls/ice/news/refresh', async (req, res) => {
  try {
    console.log('[ICE NEWS] Manual refresh triggered');
    const news = await fetchICENewsLive();
    res.json({
      success: true,
      count: news.length,
      sources: [...new Set(news.map(n => n.source))],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get only geolocated news for map display
app.get('/city/mpls/ice/news/map', async (req, res) => {
  const { limit = 50 } = req.query;
  
  try {
    // Get news items that have coordinates
    const newsWithCoords = iceNewsEvents.filter(n => n.lat && n.lng);
    
    // Format for map markers
    const mapMarkers = newsWithCoords.slice(0, parseInt(limit)).map(n => ({
      id: n.id,
      type: n.type, // 'social', 'news', 'alert'
      source: n.source,
      title: n.title.substring(0, 100),
      lat: n.lat,
      lng: n.lng,
      locationName: n.locationName || n.location,
      timestamp: n.timestamp,
      imageUrl: n.imageUrl || null,
      thumbnailUrl: n.thumbnailUrl || null,
      hasMedia: n.hasMedia || false,
      verified: n.verified || false,
      url: n.url,
      // Social media specific
      upvotes: n.upvotes,
      likes: n.likes,
      comments: n.comments
    }));
    
    res.json({
      markers: mapMarkers,
      total: newsWithCoords.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message, markers: [] });
  }
});

// Combined ICE dashboard data
app.get('/city/mpls/ice/dashboard', async (req, res) => {
  const activeReports = getActiveICEReports();
  const facilitiesStatus = getAllICEFacilitiesStatus();
  
  res.json({
    overview: {
      totalDetainees: facilitiesStatus.totalDetainees,
      activeFacilities: facilitiesStatus.detentionFacilities,
      activeReports: activeReports.length,
      verifiedReports: activeReports.filter(r => r.verified).length,
      alertLevel: activeReports.length > 10 ? 'high' : activeReports.length > 5 ? 'medium' : 'low'
    },
    facilities: facilitiesStatus.facilities,
    hotspots: ICE_HOTSPOTS_MPLS,
    stats: ICE_STATS_STPAUL,
    watcher: iceWatcher ? iceWatcher.getStatus() : null,
    recentAlerts: iceWatcher ? iceWatcher.getAlerts(5) : [],
    recentReports: activeReports.slice(0, 10),
    news: iceNewsEvents.slice(0, 5),
    mapData: {
      facilities: MPLS_ICE_FACILITIES.map(f => ({
        id: f.id,
        name: f.shortName,
        type: f.type,
        lat: f.lat,
        lng: f.lng,
        detainees: f.iceDetainees || 0
      })),
      hotspots: ICE_HOTSPOTS_MPLS,
      reports: activeReports.filter(r => r.lat && r.lng).map(r => ({
        id: r.id,
        type: r.activityType,
        lat: r.lat,
        lng: r.lng,
        verified: r.verified,
        timestamp: r.timestamp
      })),
      // Social media posts with locations
      socialPosts: iceNewsEvents.filter(n => n.lat && n.lng && n.type === 'social').slice(0, 20).map(n => ({
        id: n.id,
        source: n.source,
        title: n.title.substring(0, 80),
        lat: n.lat,
        lng: n.lng,
        locationName: n.locationName,
        timestamp: n.timestamp,
        imageUrl: n.imageUrl,
        thumbnailUrl: n.thumbnailUrl,
        hasMedia: n.hasMedia,
        url: n.url
      })),
      // News articles with locations
      newsArticles: iceNewsEvents.filter(n => n.lat && n.lng && n.type === 'news').slice(0, 10).map(n => ({
        id: n.id,
        source: n.source,
        title: n.title.substring(0, 80),
        lat: n.lat,
        lng: n.lng,
        locationName: n.locationName,
        timestamp: n.timestamp,
        url: n.url,
        verified: n.verified
      }))
    },
    timestamp: new Date().toISOString()
  });
});

// ============================================
// ICE NEWS LIVE SCRAPING
// ============================================

// Minneapolis location patterns for geocoding social media posts
const MPLS_LOCATION_PATTERNS = [
  // Twin Cities Suburbs (check these first - most specific)
  { pattern: /burnsville/i, name: 'Burnsville', lat: 44.7677, lng: -93.2777 },
  { pattern: /bloomington(?!\s*ave)/i, name: 'Bloomington', lat: 44.8408, lng: -93.2983 },
  { pattern: /eden\s*prairie/i, name: 'Eden Prairie', lat: 44.8547, lng: -93.4708 },
  { pattern: /edina/i, name: 'Edina', lat: 44.8897, lng: -93.3499 },
  { pattern: /richfield/i, name: 'Richfield', lat: 44.8831, lng: -93.2669 },
  { pattern: /brooklyn\s*(center|park)/i, name: 'Brooklyn Center/Park', lat: 45.0761, lng: -93.3327 },
  { pattern: /maple\s*grove/i, name: 'Maple Grove', lat: 45.0724, lng: -93.4558 },
  { pattern: /plymouth/i, name: 'Plymouth', lat: 45.0105, lng: -93.4555 },
  { pattern: /golden\s*valley/i, name: 'Golden Valley', lat: 44.9919, lng: -93.3591 },
  { pattern: /st\.?\s*louis\s*park/i, name: 'St. Louis Park', lat: 44.9597, lng: -93.3702 },
  { pattern: /hopkins/i, name: 'Hopkins', lat: 44.9252, lng: -93.4183 },
  { pattern: /minnetonka/i, name: 'Minnetonka', lat: 44.9211, lng: -93.4687 },
  { pattern: /eagan/i, name: 'Eagan', lat: 44.8041, lng: -93.1669 },
  { pattern: /apple\s*valley/i, name: 'Apple Valley', lat: 44.7319, lng: -93.2177 },
  { pattern: /lakeville/i, name: 'Lakeville', lat: 44.6497, lng: -93.2427 },
  { pattern: /roseville/i, name: 'Roseville', lat: 45.0061, lng: -93.1566 },
  { pattern: /maplewood/i, name: 'Maplewood', lat: 44.9530, lng: -93.0252 },
  { pattern: /woodbury/i, name: 'Woodbury', lat: 44.9239, lng: -92.9594 },
  { pattern: /cottage\s*grove/i, name: 'Cottage Grove', lat: 44.8277, lng: -92.9438 },
  { pattern: /shakopee/i, name: 'Shakopee', lat: 44.7980, lng: -93.5269 },
  { pattern: /prior\s*lake/i, name: 'Prior Lake', lat: 44.7133, lng: -93.4227 },
  { pattern: /savage/i, name: 'Savage', lat: 44.7792, lng: -93.3363 },
  { pattern: /coon\s*rapids/i, name: 'Coon Rapids', lat: 45.1200, lng: -93.2878 },
  { pattern: /fridley/i, name: 'Fridley', lat: 45.0852, lng: -93.2633 },
  { pattern: /columbia\s*heights/i, name: 'Columbia Heights', lat: 45.0408, lng: -93.2472 },
  { pattern: /anoka/i, name: 'Anoka', lat: 45.1977, lng: -93.3872 },
  { pattern: /blaine/i, name: 'Blaine', lat: 45.1608, lng: -93.2349 },
  
  // Major streets
  { pattern: /lake\s*(?:st(?:reet)?|ave)/i, name: 'Lake Street', lat: 44.9486, lng: -93.2590 },
  { pattern: /east\s*lake/i, name: 'East Lake Street', lat: 44.9486, lng: -93.2300 },
  { pattern: /hennepin/i, name: 'Hennepin Avenue', lat: 44.9700, lng: -93.2780 },
  { pattern: /nicollet/i, name: 'Nicollet Avenue', lat: 44.9600, lng: -93.2710 },
  { pattern: /lyndale/i, name: 'Lyndale Avenue', lat: 44.9500, lng: -93.2880 },
  { pattern: /franklin/i, name: 'Franklin Avenue', lat: 44.9627, lng: -93.2700 },
  { pattern: /broadway/i, name: 'Broadway', lat: 45.0000, lng: -93.2900 },
  { pattern: /central\s*ave/i, name: 'Central Avenue', lat: 45.0050, lng: -93.2470 },
  { pattern: /chicago\s*ave/i, name: 'Chicago Avenue', lat: 44.9400, lng: -93.2616 },
  { pattern: /portland\s*ave/i, name: 'Portland Avenue', lat: 44.9366, lng: -93.2616 },
  { pattern: /bloomington\s*ave/i, name: 'Bloomington Avenue', lat: 44.9400, lng: -93.2450 },
  { pattern: /38th\s*(st|street|&)/i, name: '38th Street', lat: 44.9340, lng: -93.2616 },
  { pattern: /46th\s*(st|street)/i, name: '46th Street', lat: 44.9220, lng: -93.2700 },
  
  // Neighborhoods
  { pattern: /cedar[\s-]*riverside/i, name: 'Cedar-Riverside', lat: 44.9697, lng: -93.2543 },
  { pattern: /phillips/i, name: 'Phillips', lat: 44.9550, lng: -93.2616 },
  { pattern: /powderhorn/i, name: 'Powderhorn', lat: 44.9366, lng: -93.2590 },
  { pattern: /uptown/i, name: 'Uptown', lat: 44.9480, lng: -93.2980 },
  { pattern: /north\s*(?:side|minneapolis|mpls)/i, name: 'North Minneapolis', lat: 45.0050, lng: -93.2950 },
  { pattern: /south\s*(?:side|minneapolis|mpls)/i, name: 'South Minneapolis', lat: 44.9200, lng: -93.2680 },
  { pattern: /northeast|ne\s*mpls/i, name: 'Northeast Minneapolis', lat: 45.0000, lng: -93.2500 },
  { pattern: /downtown/i, name: 'Downtown', lat: 44.9778, lng: -93.2650 },
  { pattern: /longfellow/i, name: 'Longfellow', lat: 44.9400, lng: -93.2200 },
  { pattern: /nokomis/i, name: 'Nokomis', lat: 44.9100, lng: -93.2400 },
  { pattern: /seward/i, name: 'Seward', lat: 44.9550, lng: -93.2350 },
  { pattern: /whittier/i, name: 'Whittier', lat: 44.9580, lng: -93.2750 },
  { pattern: /dinkytown/i, name: 'Dinkytown', lat: 44.9810, lng: -93.2360 },
  { pattern: /stadium\s*village/i, name: 'Stadium Village', lat: 44.9750, lng: -93.2250 },
  
  // Landmarks
  { pattern: /whipple|fort\s*snelling|ice\s*(?:hq|headquarters|office)/i, name: 'Whipple Federal Building (ICE HQ)', lat: 44.8808, lng: -93.2108 },
  { pattern: /target\s*center/i, name: 'Target Center', lat: 44.9795, lng: -93.2761 },
  { pattern: /us\s*bank\s*stadium/i, name: 'US Bank Stadium', lat: 44.9738, lng: -93.2575 },
  { pattern: /mall\s*of\s*america|moa/i, name: 'Mall of America', lat: 44.8549, lng: -93.2422 },
  { pattern: /msp\s*airport|airport/i, name: 'MSP Airport', lat: 44.8848, lng: -93.2223 },
  { pattern: /u\s*of\s*m|university\s*of\s*minnesota/i, name: 'University of Minnesota', lat: 44.9740, lng: -93.2277 },
  { pattern: /midtown\s*global/i, name: 'Midtown Global Market', lat: 44.9486, lng: -93.2600 },
  { pattern: /george\s*floyd|cup\s*foods|38th\s*and\s*chicago/i, name: '38th & Chicago', lat: 44.9340, lng: -93.2616 },
  
  // St. Paul
  { pattern: /st\.?\s*paul|saint\s*paul/i, name: 'St. Paul', lat: 44.9537, lng: -93.0900 },
  { pattern: /west\s*st\.?\s*paul/i, name: 'West St. Paul', lat: 44.9163, lng: -93.1066 },
  
  // Detention facilities
  { pattern: /sherburne/i, name: 'Sherburne County Jail', lat: 45.4580, lng: -93.7650 },
  { pattern: /freeborn/i, name: 'Freeborn County Jail', lat: 43.6481, lng: -93.3677 },
  { pattern: /kandiyohi/i, name: 'Kandiyohi County Jail', lat: 45.1219, lng: -95.0403 },
  
  // General Minneapolis mention (lowest priority)
  { pattern: /minneapolis|mpls/i, name: 'Minneapolis', lat: 44.9778, lng: -93.2650 },
  { pattern: /minnesota|mn/i, name: 'Minnesota', lat: 44.9778, lng: -93.2650 }
];

// Extract location from text and return coordinates (regex-based)
function extractLocationFromTextRegex(text) {
  if (!text) return null;
  
  const lower = text.toLowerCase();
  
  // Try to match against known patterns (most specific first)
  for (const loc of MPLS_LOCATION_PATTERNS) {
    if (loc.pattern.test(text)) {
      // Add some randomness to prevent exact overlap on map
      const jitter = 0.002; // ~200m
      return {
        name: loc.name,
        lat: loc.lat + (Math.random() - 0.5) * jitter,
        lng: loc.lng + (Math.random() - 0.5) * jitter,
        confidence: loc.pattern.toString().includes('minneapolis') ? 'low' : 'medium'
      };
    }
  }
  
  return null;
}

async function fetchICENewsLive() {
  const news = [];
  
  // --- REDDIT SCRAPING ---
  try {
    // Search Reddit for ICE Minneapolis posts
    const subreddits = ['Minneapolis', 'minnesota', 'immigration'];
    
    for (const sub of subreddits) {
      try {
        const redditResponse = await fetch(
          `https://www.reddit.com/r/${sub}/search.json?q=ICE+OR+immigration+OR+deportation+OR+raid&sort=new&t=week&limit=10`,
          { 
            headers: { 'User-Agent': 'DispatchNYC/1.0' },
            timeout: 5000 
          }
        );
        
        if (redditResponse.ok) {
          const data = await redditResponse.json();
          const posts = data?.data?.children || [];
          
          for (const post of posts) {
            const p = post.data;
            if (p.title && (
              p.title.toLowerCase().includes('ice') ||
              p.title.toLowerCase().includes('immigration') ||
              p.title.toLowerCase().includes('deportation') ||
              p.title.toLowerCase().includes('raid') ||
              p.title.toLowerCase().includes('cbp') ||
              p.title.toLowerCase().includes('border patrol')
            )) {
              // Extract images from Reddit post
              let imageUrl = null;
              let thumbnailUrl = null;
              
              // Check for preview images
              if (p.preview?.images?.[0]) {
                const img = p.preview.images[0];
                imageUrl = img.source?.url?.replace(/&amp;/g, '&');
                // Get a medium resolution version if available
                const resolutions = img.resolutions || [];
                if (resolutions.length > 0) {
                  thumbnailUrl = resolutions[Math.min(2, resolutions.length - 1)]?.url?.replace(/&amp;/g, '&');
                }
              }
              
              // Check for direct image link
              if (!imageUrl && p.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(p.url)) {
                imageUrl = p.url;
              }
              
              // Check thumbnail
              if (!thumbnailUrl && p.thumbnail && p.thumbnail.startsWith('http')) {
                thumbnailUrl = p.thumbnail;
              }
              
              // Extract location from title and selftext
              const fullText = `${p.title} ${p.selftext || ''}`;
              const location = extractLocationFromTextRegex(fullText);
              
              news.push({
                id: `reddit_${p.id}`,
                type: 'social',
                source: `Reddit r/${sub}`,
                title: p.title.substring(0, 200),
                url: `https://reddit.com${p.permalink}`,
                timestamp: new Date(p.created_utc * 1000).toISOString(),
                verified: false,
                upvotes: p.ups,
                comments: p.num_comments,
                imageUrl,
                thumbnailUrl,
                hasMedia: !!imageUrl || !!p.is_video,
                // Location data for map
                location: location?.name || null,
                lat: location?.lat || null,
                lng: location?.lng || null,
                locationConfidence: location?.confidence || null,
                canMapPin: !!location
              });
            }
          }
        }
      } catch (e) {
        console.log(`[ICE NEWS] Reddit r/${sub} fetch failed:`, e.message);
      }
    }
    console.log(`[ICE NEWS] Reddit: found ${news.length} posts`);
  } catch (e) {
    console.log('[ICE NEWS] Reddit fetch failed:', e.message);
  }
  
  // --- BLUESKY SCRAPING ---
  try {
    const bskyResponse = await fetch(
      'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=ICE+Minneapolis+OR+immigration+Minnesota&limit=20',
      { 
        headers: { 'User-Agent': 'DispatchNYC/1.0' },
        timeout: 5000 
      }
    );
    
    if (bskyResponse.ok) {
      const data = await bskyResponse.json();
      const posts = data?.posts || [];
      
      for (const post of posts) {
        const text = post.record?.text || '';
        if (text.toLowerCase().includes('ice') || 
            text.toLowerCase().includes('immigration') ||
            text.toLowerCase().includes('deportation')) {
          
          // Extract images from Bluesky post
          let imageUrl = null;
          let thumbnailUrl = null;
          const images = [];
          
          // Check for embedded images
          if (post.embed?.images && post.embed.images.length > 0) {
            imageUrl = post.embed.images[0].fullsize;
            thumbnailUrl = post.embed.images[0].thumb;
            
            // Collect all images
            post.embed.images.forEach(img => {
              images.push({
                fullsize: img.fullsize,
                thumb: img.thumb,
                alt: img.alt
              });
            });
          }
          
          // Check for external embed with thumbnail
          if (!imageUrl && post.embed?.external?.thumb) {
            thumbnailUrl = post.embed.external.thumb;
          }
          
          // Extract location from post text
          const location = extractLocationFromTextRegex(text);
          
          news.push({
            id: `bsky_${post.uri.split('/').pop()}`,
            type: 'social',
            source: 'Bluesky',
            title: text.substring(0, 200),
            url: `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split('/').pop()}`,
            timestamp: post.record?.createdAt || new Date().toISOString(),
            verified: false,
            author: post.author?.displayName || post.author?.handle,
            authorAvatar: post.author?.avatar,
            imageUrl,
            thumbnailUrl,
            images: images.length > 0 ? images : null,
            hasMedia: images.length > 0,
            likes: post.likeCount || 0,
            reposts: post.repostCount || 0,
            // Location data for map
            location: location?.name || null,
            lat: location?.lat || null,
            lng: location?.lng || null,
            locationConfidence: location?.confidence || null,
            canMapPin: !!location
          });
        }
      }
      console.log(`[ICE NEWS] Bluesky: found ${posts.length} posts`);
    }
  } catch (e) {
    console.log('[ICE NEWS] Bluesky fetch failed:', e.message);
  }
  
  // --- MINNESOTA REFORMER RSS ---
  try {
    const reformerResponse = await fetch('https://minnesotareformer.com/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    
    if (reformerResponse.ok) {
      const rssText = await reformerResponse.text();
      // Simple RSS parsing for ICE-related articles
      const titleMatches = rssText.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g);
      const linkMatches = rssText.matchAll(/<link>(https:\/\/minnesotareformer\.com\/\d+\/\d+\/\d+\/[^<]+)<\/link>/g);
      
      const titles = [...titleMatches].map(m => m[1]);
      const links = [...linkMatches].map(m => m[1]);
      
      for (let i = 0; i < Math.min(titles.length, links.length, 10); i++) {
        const title = titles[i];
        if (title && (
          title.toLowerCase().includes('ice') ||
          title.toLowerCase().includes('immigration') ||
          title.toLowerCase().includes('deportation') ||
          title.toLowerCase().includes('raid') ||
          title.toLowerCase().includes('patrol') ||
          title.toLowerCase().includes('enforcement') ||
          title.toLowerCase().includes('border') ||
          title.toLowerCase().includes('undocumented') ||
          title.toLowerCase().includes('migrant')
        )) {
          news.push({
            id: `reformer_${Date.now()}_${i}`,
            type: 'news',
            source: 'Minnesota Reformer',
            title: title,
            url: links[i],
            timestamp: new Date().toISOString(),
            verified: true
          });
        }
      }
    }
  } catch (e) {
    console.log('[ICE NEWS] Minnesota Reformer fetch failed:', e.message);
  }
  
  // --- STAR TRIBUNE RSS ---
  try {
    const stribResponse = await fetch('https://www.startribune.com/local/rss/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    
    if (stribResponse.ok) {
      const rssText = await stribResponse.text();
      const titleMatches = rssText.matchAll(/<title>(.*?)<\/title>/g);
      const linkMatches = rssText.matchAll(/<link>(https:\/\/www\.startribune\.com\/[^<]+)<\/link>/g);
      
      const titles = [...titleMatches].map(m => m[1]);
      const links = [...linkMatches].map(m => m[1]);
      
      for (let i = 0; i < Math.min(titles.length, links.length, 10); i++) {
        const title = titles[i];
        if (title && (
          title.toLowerCase().includes('ice') ||
          title.toLowerCase().includes('immigration') ||
          title.toLowerCase().includes('deportation') ||
          title.toLowerCase().includes('federal') ||
          title.toLowerCase().includes('enforcement') ||
          title.toLowerCase().includes('raid')
        )) {
          news.push({
            id: `strib_${Date.now()}_${i}`,
            type: 'news',
            source: 'Star Tribune',
            title: title.replace(/<!\[CDATA\[|\]\]>/g, ''),
            url: links[i],
            timestamp: new Date().toISOString(),
            verified: true
          });
        }
      }
    }
  } catch (e) {
    console.log('[ICE NEWS] Star Tribune fetch failed:', e.message);
  }
  
  // Add hardcoded recent events (these are real and recent)
  const recentKnownEvents = [
    {
      id: 'recent_1',
      type: 'news',
      source: 'ABC News / Star Tribune',
      title: '1,500 paratroopers on alert for possible Minnesota deployment',
      summary: 'Alaska-based paratroopers put on standby as protests intensify at Whipple Federal Building. No final decision made.',
      url: 'https://www.startribune.com/ice-raids-minnesota/601546426',
      location: 'Fort Snelling / Minneapolis',
      lat: 44.8808,
      lng: -93.2108,
      timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      hasMedia: true,
      verified: true,
      severity: 'critical'
    },
    {
      id: 'recent_2',
      type: 'news',
      source: 'Minnesota Reformer',
      title: 'Community patrols monitor ICE activity across South Minneapolis neighborhoods',
      summary: 'Rapid response networks organizing neighborhood patrols to document and disrupt ICE operations in immigrant communities.',
      url: 'https://minnesotareformer.com/2026/01/13/in-the-car-with-minneapolis-community-patrols/',
      location: 'South Minneapolis',
      lat: 44.9200,
      lng: -93.2680,
      timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      hasMedia: true,
      verified: true
    },
    {
      id: 'recent_3',
      type: 'news',
      source: 'Minnesota Reformer',
      title: 'Vigil held for Renee Good, killed by ICE officer on Portland Avenue',
      summary: 'Thousands gathered at Portland Avenue near 34th Street to honor Renee Good, killed by an ICE officer. Community demands accountability.',
      url: 'https://minnesotareformer.com/2026/01/08/vigil-renee-good/',
      location: 'Portland Ave & 34th St',
      lat: 44.9366,
      lng: -93.2616,
      timestamp: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      hasMedia: true,
      verified: true,
      severity: 'critical'
    },
    {
      id: 'recent_4',
      type: 'news',
      source: 'Star Tribune',
      title: 'Federal judge prohibits ICE from using force against peaceful protesters',
      summary: 'Court order bars ICE agents from arresting, retaliating against, or using chemical irritants on peaceful protesters and observers.',
      url: 'https://www.startribune.com/ice-raids-minnesota/601546426',
      location: 'Fort Snelling',
      lat: 44.8808,
      lng: -93.2108,
      timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      hasMedia: false,
      verified: true
    },
    {
      id: 'recent_5',
      type: 'news',
      source: 'WCCO',
      title: 'Minnesota jails holding ICE detainees: Sherburne, Freeborn, Kandiyohi, Crow Wing',
      summary: 'Investigation reveals which Minnesota jails have 287(g) agreements and how much revenue they collect from ICE.',
      url: 'https://www.cbsnews.com/minnesota/news/where-federal-agents-take-people-detained-in-minnesota/',
      location: 'Minnesota',
      timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      hasMedia: false,
      verified: true
    },
    {
      id: 'recent_6',
      type: 'alert',
      source: 'Community Report',
      title: 'ICE vehicles observed near Lake Street corridor',
      summary: 'Multiple reports of unmarked federal vehicles with out-of-state plates in East Lake Street area.',
      location: 'Lake Street & Bloomington Ave',
      lat: 44.9486,
      lng: -93.2450,
      timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      hasMedia: false,
      verified: false
    },
    {
      id: 'recent_7',
      type: 'alert',
      source: 'Community Report',
      title: 'Counter-surveillance active at Whipple Federal Building',
      summary: 'Community monitors tracking ICE vehicle departures from Fort Snelling headquarters. Relay system active across neighborhoods.',
      location: 'Whipple Federal Building',
      lat: 44.8808,
      lng: -93.2108,
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      hasMedia: false,
      verified: true
    }
  ];
  
  // Combine scraped and known events
  const combined = [...news, ...recentKnownEvents];
  
  // Deduplicate by title similarity (same post from multiple subreddits)
  const seen = new Set();
  const deduplicated = combined.filter(item => {
    // Create a normalized key from the title
    const key = item.title.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 50);
    
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  
  console.log(`[ICE NEWS] Deduplicated: ${combined.length} -> ${deduplicated.length} items`);
  
  // Sort by timestamp, newest first
  deduplicated.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Geocode items that don't have coordinates
  const geocoded = await geocodeNewsItems(deduplicated);
  
  // Log geocoding stats
  const withCoords = geocoded.filter(n => n.lat && n.lng).length;
  console.log(`[ICE NEWS] Geocoded ${withCoords}/${geocoded.length} items with coordinates`);
  
  // Find new items that weren't in cache before
  const existingIds = new Set(iceNewsEvents.map(n => n.id));
  const newItems = geocoded.filter(n => !existingIds.has(n.id));
  
  // Update cache
  iceNewsEvents.length = 0;
  iceNewsEvents.push(...geocoded.slice(0, MAX_ICE_NEWS));
  
  // Broadcast new social media posts to Minneapolis clients
  if (newItems.length > 0) {
    const socialWithCoords = newItems.filter(n => n.lat && n.lng && n.type === 'social');
    if (socialWithCoords.length > 0) {
      console.log(`[ICE NEWS] Broadcasting ${socialWithCoords.length} new social posts with coordinates`);
      broadcastToCity('mpls', {
        type: 'ice_social_posts',
        posts: socialWithCoords.map(n => ({
          id: n.id,
          type: n.type,
          source: n.source,
          title: n.title,
          url: n.url,
          lat: n.lat,
          lng: n.lng,
          location: n.location,
          imageUrl: n.imageUrl,
          thumbnailUrl: n.thumbnailUrl,
          hasMedia: n.hasMedia,
          timestamp: n.timestamp
        })),
        timestamp: new Date().toISOString()
      });
    }
    
    // Also broadcast all new items
    broadcastToCity('mpls', {
      type: 'ice_news_update',
      newCount: newItems.length,
      total: geocoded.length,
      withCoordinates: withCoords,
      timestamp: new Date().toISOString()
    });
  }
  
  return geocoded;
}

// Fetch news on startup and periodically
setTimeout(() => fetchICENewsLive(), 5000); // Start faster
setInterval(() => fetchICENewsLive(), 5 * 60 * 1000); // Every 5 minutes (was 15)

// ============================================
// LEGACY DETECTIVE BUREAU ENDPOINTS (NYC default for backwards compatibility)
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
// Prediction Game endpoints (PTS-based)
app.post('/auth/login', (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  
  const cleanUsername = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Invalid username characters' });
  }
  
  let user = getUserByUsername(cleanUsername);
  let isNewUser = false;
  let bonuses = [];
  
  if (!user) {
    user = createUser(cleanUsername);
    isNewUser = true;
    bonuses.push({ type: 'signup', amount: SIGNUP_BONUS, label: 'Welcome Bonus!' });
  }
  
  // Calculate streak
  const streakInfo = calculateLoginStreak(user);
  
  if (streakInfo.isNewDay) {
    user.loginStreak = streakInfo.streak;
    user.lastLoginDate = new Date().toISOString().split('T')[0];
    
    if (user.loginStreak > (user.bestLoginStreak || 0)) {
      user.bestLoginStreak = user.loginStreak;
    }
    
    const loginBonus = getLoginBonus(user.loginStreak);
    user.pts += loginBonus.bonus;
    
    bonuses.push({
      type: 'daily_login',
      amount: loginBonus.bonus,
      label: loginBonus.label,
      streak: user.loginStreak
    });
    
    if (!isNewUser) {
      addToActivityFeed({
        type: 'streak_bonus',
        user: user.displayName,
        streak: user.loginStreak,
        bonus: loginBonus.bonus
      });
    }
  }
  
  const rank = getUserRank(user.pts);
  
  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      pts: user.pts,
      wins: user.wins,
      losses: user.losses,
      totalPredictions: user.totalPredictions,
      winRate: user.totalPredictions > 0 ? ((user.wins / user.totalPredictions) * 100).toFixed(1) + '%' : '0%',
      currentWinStreak: user.currentWinStreak || 0,
      bestWinStreak: user.bestWinStreak || 0,
      loginStreak: user.loginStreak || 1,
      bestLoginStreak: user.bestLoginStreak || 1,
      bountiesCompleted: user.bountiesCompleted || 0,
      transcriptionsVerified: user.transcriptionsVerified || 0
    },
    rank,
    isNewUser,
    bonuses,
    activePredictions: Array.from(activePredictions.values()).filter(p => p.username === user.username)
  });
});

app.get('/auth/user/:username', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const rank = getUserRank(user.pts);
  
  res.json({
    user: {
      id: user.id, username: user.username, displayName: user.displayName, pts: user.pts,
      wins: user.wins, losses: user.losses, totalPredictions: user.totalPredictions,
      winRate: user.totalPredictions > 0 ? ((user.wins / user.totalPredictions) * 100).toFixed(1) + '%' : '0%',
      currentWinStreak: user.currentWinStreak || 0,
      bestWinStreak: user.bestWinStreak || 0,
      loginStreak: user.loginStreak || 1,
      bountiesCompleted: user.bountiesCompleted || 0,
      totalBountyEarnings: user.totalBountyEarnings || 0,
      transcriptionsVerified: user.transcriptionsVerified || 0
    },
    rank,
    activePredictions: Array.from(activePredictions.values()).filter(p => p.username === user.username),
    recentHistory: predictionHistory.filter(p => p.username === user.username).slice(0, 20)
  });
});

app.get('/predict/odds', (req, res) => {
  const { type = 'any', window = 30, city = 'nyc' } = req.query;
  const districts = oddsEngine.getDistricts(city);
  res.json(districts.map(d => oddsEngine.getOdds(d, type, parseInt(window), city)));
});

app.get('/predict/all-odds', (req, res) => {
  const { window = 30, city = 'nyc' } = req.query;
  const districts = oddsEngine.getDistricts(city);
  const types = ['any', 'assault', 'robbery', 'theft', 'pursuit', 'shots fired'];
  const odds = {};
  districts.forEach(d => { odds[d] = {}; types.forEach(t => { odds[d][t] = oddsEngine.getOdds(d, t, parseInt(window), city); }); });
  
  const allOdds = districts.flatMap(d => types.map(t => odds[d][t]));
  const avgMultiplier = allOdds.reduce((s, o) => s + o.multiplier, 0) / allOdds.length;
  
  res.json({ 
    timestamp: new Date().toISOString(), 
    city,
    districts,
    windowMinutes: parseInt(window), 
    houseEdge: `${HOUSE_EDGE * 100}%`,
    currentHour: new Date().getHours(),
    currency: 'PTS',
    summary: {
      avgMultiplier: Math.round(avgMultiplier * 10) / 10,
      lowestOdds: allOdds.reduce((min, o) => o.multiplier < min.multiplier ? o : min),
      highestOdds: allOdds.reduce((max, o) => o.multiplier > max.multiplier ? o : max)
    },
    odds,
    pool: { totalPredictions: pool.totalPredictions, totalWagered: pool.totalPtsWagered, totalPaidOut: pool.totalPtsPaidOut }
  });
});

app.get('/predict/pool', (req, res) => {
  const active = Array.from(activePredictions.values()).filter(p => p.status === 'ACTIVE');
  const poolByBorough = {};
  active.forEach(pred => { 
    if (!poolByBorough[pred.borough]) poolByBorough[pred.borough] = { total: 0, count: 0 }; 
    poolByBorough[pred.borough].total += pred.amount; 
    poolByBorough[pred.borough].count++; 
  });
  res.json({ 
    currency: 'PTS',
    totalPool: active.reduce((s, p) => s + p.amount, 0), 
    totalActive: active.length, 
    poolByBorough, 
    recentWinners: predictionHistory.filter(p => p.status === 'WON').slice(0, 10).map(p => ({
      user: p.displayName, borough: p.borough, type: p.incidentType, amount: p.amount, winnings: p.winnings, multiplier: p.multiplier
    }))
  });
});

app.get('/predict/leaderboard', (req, res) => {
  const leaders = Array.from(users.values())
    .filter(u => u.totalPredictions > 0)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 50)
    .map((u, rank) => ({
      rank: rank + 1,
      displayName: u.displayName,
      pts: u.pts,
      wins: u.wins,
      losses: u.losses,
      totalPredictions: u.totalPredictions,
      winRate: u.totalPredictions > 0 ? ((u.wins / u.totalPredictions) * 100).toFixed(1) + '%' : '0%',
      netProfit: u.totalWinnings - u.totalLosses,
      ...getUserRank(u.pts)
    }));
  res.json({ currency: 'PTS', leaderboard: leaders, totalPlayers: users.size, timestamp: new Date().toISOString() });
});

// ============================================
// GAMIFICATION ENDPOINTS
// ============================================

// --- RANKS ---
app.get('/ranks', (req, res) => {
  res.json({ ranks: RANKS });
});

app.get('/user/:username/rank', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(getUserRank(user.pts));
});

// --- ACTIVITY FEED ---
app.get('/feed', (req, res) => {
  const { limit = 50 } = req.query;
  res.json({
    feed: activityFeed.slice(0, parseInt(limit)),
    total: activityFeed.length
  });
});

// --- BOUNTIES ---
app.get('/bounties', (req, res) => {
  const { city, status = 'ACTIVE' } = req.query;
  let results = Array.from(bounties.values());
  
  if (city) results = results.filter(b => b.city === city);
  if (status && status !== 'ALL') results = results.filter(b => b.status === status);
  
  res.json({
    bounties: results.sort((a, b) => b.reward - a.reward),
    types: BOUNTY_TYPES,
    total: results.length
  });
});

app.get('/bounties/history', (req, res) => {
  const { limit = 50 } = req.query;
  res.json({ history: bountyHistory.slice(0, parseInt(limit)) });
});

app.post('/bounties', (req, res) => {
  const { username, type, title, description, location, city, reward, expiresInMinutes } = req.body;
  
  if (!username || !type || !title || !description) {
    return res.status(400).json({ error: 'Missing required fields: username, type, title, description' });
  }
  
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  
  const cost = reward || BOUNTY_TYPES[type]?.basePts || 100;
  if (user.pts < cost) {
    return res.status(400).json({ error: 'Insufficient PTS to fund bounty', required: cost, balance: user.pts });
  }
  
  user.pts -= cost;
  user.bountiesCreated = (user.bountiesCreated || 0) + 1;
  
  const bounty = createBounty({ type, title, description, location, city, reward: cost, expiresInMinutes, createdBy: username });
  
  res.json({ success: true, bounty, newBalance: user.pts });
});

app.post('/bounties/:bountyId/claim', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  
  const result = claimBounty(req.params.bountyId, username);
  res.json(result);
});

app.post('/bounties/:bountyId/submit', (req, res) => {
  const { username, content, imageUrl } = req.body;
  if (!username || !content) return res.status(400).json({ error: 'Missing username or content' });
  
  const result = submitBounty(req.params.bountyId, username, { content, imageUrl });
  res.json(result);
});

app.post('/bounties/:bountyId/verify', (req, res) => {
  const { username, approved } = req.body;
  if (!username || approved === undefined) return res.status(400).json({ error: 'Missing username or approved' });
  
  const result = verifyBountySubmission(req.params.bountyId, username, approved);
  res.json(result);
});

// --- TRANSCRIPTION BOUNTIES ---
app.get('/transcriptions/queue', (req, res) => {
  const pending = transcriptionQueue.filter(t => t.status === 'PENDING');
  res.json({
    queue: pending.slice(0, 20),
    total: pending.length,
    reward: TRANSCRIPTION_REWARD
  });
});

app.post('/transcriptions/:transcriptId/correct', (req, res) => {
  const { username, correctedText, corrections } = req.body;
  if (!username || !correctedText) return res.status(400).json({ error: 'Missing fields' });
  
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  
  const result = submitTranscriptionCorrection(req.params.transcriptId, username, correctedText, corrections);
  res.json(result);
});

app.post('/transcriptions/:transcriptId/verify', (req, res) => {
  const { username, isCorrect } = req.body;
  if (!username || isCorrect === undefined) return res.status(400).json({ error: 'Missing fields' });
  
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  
  const result = verifyTranscription(req.params.transcriptId, username, isCorrect);
  res.json(result);
});

// --- ADDITIONAL LEADERBOARDS ---
app.get('/leaderboard/bounties', (req, res) => {
  const leaders = Array.from(users.values())
    .filter(u => (u.bountiesCompleted || 0) > 0)
    .sort((a, b) => (b.totalBountyEarnings || 0) - (a.totalBountyEarnings || 0))
    .slice(0, 50)
    .map((u, i) => ({
      rank: i + 1,
      displayName: u.displayName,
      bountiesCompleted: u.bountiesCompleted || 0,
      totalEarnings: u.totalBountyEarnings || 0,
      ...getUserRank(u.pts)
    }));
  res.json({ leaderboard: leaders });
});

app.get('/leaderboard/streaks', (req, res) => {
  const leaders = Array.from(users.values())
    .filter(u => (u.loginStreak || 1) > 1)
    .sort((a, b) => (b.loginStreak || 0) - (a.loginStreak || 0))
    .slice(0, 50)
    .map((u, i) => ({
      rank: i + 1,
      displayName: u.displayName,
      currentStreak: u.loginStreak || 0,
      bestStreak: u.bestLoginStreak || 0,
      currentWinStreak: u.currentWinStreak || 0,
      ...getUserRank(u.pts)
    }));
  res.json({ leaderboard: leaders });
});

app.get('/leaderboard/transcribers', (req, res) => {
  const leaders = Array.from(users.values())
    .filter(u => (u.transcriptionsVerified || 0) > 0)
    .sort((a, b) => (b.transcriptionsVerified || 0) - (a.transcriptionsVerified || 0))
    .slice(0, 50)
    .map((u, i) => ({
      rank: i + 1,
      displayName: u.displayName,
      transcriptionsVerified: u.transcriptionsVerified || 0,
      verificationsGiven: u.verificationsGiven || 0,
      ...getUserRank(u.pts)
    }));
  res.json({ leaderboard: leaders });
});

// ============================================
// END GAMIFICATION ENDPOINTS
// ============================================

// ============================================
// DATABASE ARCHIVE ENDPOINTS
// ============================================

// Search incidents archive
app.get('/archive/incidents', async (req, res) => {
  if (!pool) return res.json({ incidents: [], total: 0, error: 'Database not configured' });
  
  const { city, borough, type, from, to, location, limit = 50, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM incidents_db WHERE 1=1';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    if (borough) { query += ` AND borough ILIKE $${i++}`; params.push(`%${borough}%`); }
    if (type) { query += ` AND incident_type ILIKE $${i++}`; params.push(`%${type}%`); }
    if (location) { query += ` AND location ILIKE $${i++}`; params.push(`%${location}%`); }
    if (from) { query += ` AND created_at >= $${i++}`; params.push(from); }
    if (to) { query += ` AND created_at <= $${i++}`; params.push(to); }
    
    query += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    let countQuery = 'SELECT COUNT(*) FROM incidents_db WHERE 1=1';
    const countParams = [];
    let j = 1;
    if (city) { countQuery += ` AND city = $${j++}`; countParams.push(city); }
    if (borough) { countQuery += ` AND borough ILIKE $${j++}`; countParams.push(`%${borough}%`); }
    
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      incidents: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      hasMore: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('[API] Archive incidents error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Search arrests
app.get('/archive/arrests', async (req, res) => {
  if (!pool) return res.json({ arrests: [], total: 0, error: 'Database not configured' });
  
  const { city, borough, category, from, to, limit = 50, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM arrests WHERE 1=1';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    if (borough) { query += ` AND borough ILIKE $${i++}`; params.push(`%${borough}%`); }
    if (category) { query += ` AND (offense_category ILIKE $${i} OR offense_description ILIKE $${i++})`; params.push(`%${category}%`); }
    if (from) { query += ` AND arrest_date >= $${i++}`; params.push(from); }
    if (to) { query += ` AND arrest_date <= $${i++}`; params.push(to); }
    
    query += ` ORDER BY arrest_date DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    let countQuery = 'SELECT COUNT(*) FROM arrests WHERE 1=1';
    const countParams = [];
    let j = 1;
    if (city) { countQuery += ` AND city = $${j++}`; countParams.push(city); }
    
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      arrests: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[API] Archive arrests error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Search inmates
app.get('/archive/inmates', async (req, res) => {
  if (!pool) return res.json({ inmates: [], total: 0, error: 'Database not configured' });
  
  const { city, facility, status, limit = 50, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM inmates WHERE 1=1';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    if (facility) { query += ` AND facility ILIKE $${i++}`; params.push(`%${facility}%`); }
    if (status) { query += ` AND status = $${i++}`; params.push(status); }
    
    query += ` ORDER BY admission_date DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM inmates');
    
    res.json({
      inmates: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[API] Archive inmates error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ICE activities archive
app.get('/archive/ice', async (req, res) => {
  if (!pool) return res.json({ activities: [], total: 0, error: 'Database not configured' });
  
  const { city, type, verified, from, to, limit = 50, offset = 0 } = req.query;
  
  try {
    let query = 'SELECT * FROM ice_activities WHERE 1=1';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    if (type) { query += ` AND activity_type = $${i++}`; params.push(type); }
    if (verified === 'true') { query += ` AND verified = true`; }
    if (verified === 'false') { query += ` AND verified = false`; }
    if (from) { query += ` AND created_at >= $${i++}`; params.push(from); }
    if (to) { query += ` AND created_at <= $${i++}`; params.push(to); }
    
    query += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    const countResult = await pool.query('SELECT COUNT(*) FROM ice_activities');
    
    res.json({
      activities: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('[API] Archive ICE error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Detention facilities
app.get('/archive/detention-facilities', async (req, res) => {
  if (!pool) return res.json({ facilities: [] });
  
  const { city, type } = req.query;
  
  try {
    let query = 'SELECT * FROM detention_facilities WHERE 1=1';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    if (type) { query += ` AND facility_type = $${i++}`; params.push(type); }
    
    query += ' ORDER BY name';
    
    const result = await pool.query(query, params);
    res.json({ facilities: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Location lookup (problem addresses)
app.get('/archive/location', async (req, res) => {
  if (!pool) return res.json({ error: 'Database not configured' });
  
  const { address, city = 'nyc' } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });
  
  try {
    const historyResult = await pool.query(
      'SELECT * FROM address_history WHERE address ILIKE $1 AND city = $2',
      [`%${address}%`, city]
    );
    
    const incidentsResult = await pool.query(
      'SELECT * FROM incidents_db WHERE location ILIKE $1 AND city = $2 ORDER BY created_at DESC LIMIT 50',
      [`%${address}%`, city]
    );
    
    const iceResult = await pool.query(
      'SELECT * FROM ice_activities WHERE location ILIKE $1 ORDER BY created_at DESC LIMIT 20',
      [`%${address}%`]
    );
    
    res.json({
      address,
      city,
      history: historyResult.rows[0] || null,
      incidents: incidentsResult.rows,
      iceActivities: iceResult.rows,
      isFlagged: historyResult.rows[0]?.flagged || false,
      totalIncidents: historyResult.rows[0]?.incident_count || incidentsResult.rows.length
    });
  } catch (error) {
    console.error('[API] Location lookup error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Problem locations (flagged addresses)
app.get('/archive/problem-locations', async (req, res) => {
  if (!pool) return res.json({ locations: [] });
  
  const { city, limit = 50 } = req.query;
  
  try {
    let query = 'SELECT * FROM address_history WHERE incident_count >= 5';
    const params = [];
    let i = 1;
    
    if (city) { query += ` AND city = $${i++}`; params.push(city); }
    query += ` ORDER BY incident_count DESC LIMIT $${i++}`;
    params.push(parseInt(limit));
    
    const result = await pool.query(query, params);
    res.json({ locations: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Statistics overview
app.get('/archive/stats', async (req, res) => {
  if (!pool) return res.json({ error: 'Database not configured' });
  
  const { city } = req.query;
  
  try {
    const cityFilter = city ? `WHERE city = '${city}'` : '';
    
    const [incidents, arrests, inmates, ice] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d FROM incidents_db ${cityFilter}`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE arrest_date > CURRENT_DATE - INTERVAL '7 days') as last_7d FROM arrests ${cityFilter}`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'in_custody') as in_custody FROM inmates ${cityFilter}`),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE verified = true) as verified FROM ice_activities ${city ? `WHERE city = '${city}'` : ''}`)
    ]);
    
    const topTypes = await pool.query(`SELECT incident_type, COUNT(*) as count FROM incidents_db ${cityFilter} GROUP BY incident_type ORDER BY count DESC LIMIT 10`);
    const byBorough = await pool.query(`SELECT borough, COUNT(*) as count FROM incidents_db ${cityFilter} GROUP BY borough ORDER BY count DESC LIMIT 10`);
    
    res.json({
      city: city || 'all',
      incidents: { total: parseInt(incidents.rows[0].total), last24h: parseInt(incidents.rows[0].last_24h), last7d: parseInt(incidents.rows[0].last_7d) },
      arrests: { total: parseInt(arrests.rows[0].total), last7d: parseInt(arrests.rows[0].last_7d) },
      inmates: { total: parseInt(inmates.rows[0].total), inCustody: parseInt(inmates.rows[0].in_custody) },
      iceActivities: { total: parseInt(ice.rows[0].total), verified: parseInt(ice.rows[0].verified) },
      topIncidentTypes: topTypes.rows,
      byBorough: byBorough.rows,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('[API] Stats error:', error.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// Data sync status
app.get('/archive/sync-status', async (req, res) => {
  if (!pool) return res.json({ syncs: [] });
  
  try {
    const result = await pool.query(`SELECT DISTINCT ON (source) * FROM data_sync_log ORDER BY source, completed_at DESC`);
    res.json({ syncs: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Manual sync trigger (admin)
app.post('/archive/sync', async (req, res) => {
  const { source, adminKey } = req.body;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  try {
    switch (source) {
      case 'nyc_arrests': await fetchNYCArrestData(); break;
      case 'nyc_inmates': await fetchNYCInmateData(); break;
      case 'all':
        await fetchNYCArrestData();
        await fetchNYCInmateData();
        break;
      default:
        return res.status(400).json({ error: 'Unknown source' });
    }
    res.json({ success: true, source, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit community report
app.post('/archive/report', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  
  const { city, reportType, location, lat, lng, description, reportedBy } = req.body;
  
  if (!city || !reportType || !description) {
    return res.status(400).json({ error: 'Missing required fields: city, reportType, description' });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO community_reports (city, report_type, location, lat, lng, description, reported_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [city, reportType, location, lat, lng, description, reportedBy]);
    
    res.json({ success: true, reportId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// Submit ICE activity report
app.post('/archive/ice', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  
  const { city, activityType, location, lat, lng, description, agencies, source, sourceUrl, reportedBy } = req.body;
  
  if (!city || !activityType || !location) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const result = await pool.query(`
      INSERT INTO ice_activities (city, activity_type, location, lat, lng, description, agencies, source, source_url, reported_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [city, activityType, location, lat, lng, description, agencies || [], source || 'community_report', sourceUrl, reportedBy]);
    
    res.json({ success: true, activityId: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save ICE activity' });
  }
});

// Verify ICE activity
app.post('/archive/ice/:id/verify', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  
  const { username } = req.body;
  const { id } = req.params;
  
  try {
    const result = await pool.query(`
      UPDATE ice_activities 
      SET verification_count = verification_count + 1,
          verified = CASE WHEN verification_count >= 2 THEN TRUE ELSE verified END
      WHERE id = $1
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }
    
    res.json({ success: true, activity: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify' });
  }
});

// ============================================
// END DATABASE ARCHIVE ENDPOINTS
// ============================================

app.post('/predict/place', (req, res) => {
  const { username, borough, district, incidentType, amount, timeWindow, city = 'nyc' } = req.body;
  const selectedDistrict = district || borough; // Support both district and borough names
  
  if (!username || !selectedDistrict || !amount) return res.status(400).json({ error: 'Missing required fields' });
  
  // Validate district exists for this city
  const validDistricts = oddsEngine.getDistricts(city);
  if (!validDistricts.includes(selectedDistrict)) {
    return res.status(400).json({ error: `Invalid district for ${city}`, validDistricts });
  }
  
  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'User not found. Please login first.' });
  
  const pts = parseInt(amount);
  if (isNaN(pts) || pts < MIN_PREDICTION || pts > MAX_PREDICTION) {
    return res.status(400).json({ error: `Prediction must be ${MIN_PREDICTION}-${MAX_PREDICTION} PTS` });
  }
  
  if (user.pts < pts) return res.status(400).json({ error: 'Insufficient PTS', balance: user.pts, required: pts });
  
  const existing = Array.from(activePredictions.values()).find(p => p.username === user.username && p.status === 'ACTIVE');
  if (existing) return res.status(400).json({ error: 'You already have an active prediction', prediction: existing });
  
  const type = incidentType || 'any';
  const window = parseInt(timeWindow) || 30;
  const odds = oddsEngine.getOdds(selectedDistrict, type, window, city);
  const potentialWin = Math.floor(pts * odds.multiplier);
  
  user.pts -= pts;
  user.totalPredictions++;
  
  const predId = `pred_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const prediction = {
    id: predId, username: user.username, displayName: user.displayName,
    city, district: selectedDistrict, borough: selectedDistrict, // Store both for compatibility
    incidentType: type, amount: pts, timeWindow: window,
    multiplier: odds.multiplier, probability: odds.probability, potentialWin,
    status: 'ACTIVE', createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + window * 60 * 1000).toISOString()
  };
  
  activePredictions.set(predId, prediction);
  pool.totalPredictions++;
  pool.totalPtsWagered += pts;
  
  // Add to activity feed
  addToActivityFeed({
    type: 'prediction_placed',
    user: user.displayName,
    district: selectedDistrict,
    city,
    incidentType: type,
    amount: pts,
    multiplier: odds.multiplier
  });
  
  broadcast({ type: 'new_prediction', prediction: { id: prediction.id, user: user.displayName, city, district: selectedDistrict, incidentType: type, amount: pts, multiplier: odds.multiplier, potentialWin }, timestamp: new Date().toISOString() });
  
  res.json({ success: true, prediction, odds, newBalance: user.pts });
});

app.delete('/predict/cancel/:predictionId', (req, res) => {
  const { username } = req.body;
  const pred = activePredictions.get(req.params.predictionId);
  
  if (!pred) return res.status(404).json({ error: 'Prediction not found' });
  if (pred.username !== username) return res.status(403).json({ error: 'Not your prediction' });
  if (pred.status !== 'ACTIVE') return res.status(400).json({ error: 'Prediction already resolved' });
  
  const elapsed = Date.now() - new Date(pred.createdAt).getTime();
  if (elapsed > 30000) return res.status(400).json({ error: 'Can only cancel within 30 seconds' });
  
  const user = users.get(pred.username);
  if (user) { user.pts += pred.amount; user.totalPredictions--; }
  
  pool.totalPtsWagered -= pred.amount;
  activePredictions.delete(req.params.predictionId);
  
  res.json({ success: true, refunded: pred.amount, newBalance: user?.pts });
});

app.get('/predict/history', (req, res) => {
  const { limit = 50 } = req.query;
  res.json({
    history: predictionHistory.slice(0, parseInt(limit)).map(p => ({
      id: p.id, user: p.displayName, borough: p.borough, incidentType: p.incidentType,
      amount: p.amount, multiplier: p.multiplier, status: p.status, winnings: p.winnings || 0,
      createdAt: p.createdAt, resolvedAt: p.resolvedAt
    })),
    stats: { totalPredictions: pool.totalPredictions, totalWagered: pool.totalPtsWagered, totalPaidOut: pool.totalPtsPaidOut }
  });
});

// Legacy bet endpoints (redirect to predict)
app.get('/bet/odds', (req, res) => res.redirect('/predict/odds' + (req.query ? '?' + new URLSearchParams(req.query).toString() : '')));
app.get('/bet/all-odds', (req, res) => res.redirect('/predict/all-odds' + (req.query ? '?' + new URLSearchParams(req.query).toString() : '')));
app.get('/bet/leaderboard', (req, res) => res.redirect('/predict/leaderboard'));

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

// ============================================
// MULTI-CITY API ENDPOINTS
// ============================================

// Get list of available cities
app.get('/cities', (req, res) => {
  res.json({
    cities: Object.values(CITIES).map(city => ({
      id: city.id,
      name: city.name,
      shortName: city.shortName,
      state: city.state,
      mapCenter: city.mapCenter,
      mapZoom: city.mapZoom,
      color: city.color,
      cameraCount: cityState[city.id]?.cameras?.length || 0,
      incidentCount: cityState[city.id]?.incidents?.length || 0,
      isActive: (cityState[city.id]?.scannerStats?.totalChunks || 0) > 0 || 
                (cityState[city.id]?.openMHzStats?.callsFetched || 0) > 0
    }))
  });
});

// Get city config
app.get('/city/:cityId', (req, res) => {
  const city = CITIES[req.params.cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  const state = cityState[req.params.cityId];
  res.json({
    ...city,
    stats: {
      cameras: state.cameras.length,
      incidents: state.incidents.length,
      scannerStats: state.scannerStats,
      openMHzStats: state.openMHzStats
    }
  });
});

// Get cameras for a city
app.get('/city/:cityId/cameras', (req, res) => {
  const city = CITIES[req.params.cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  res.json(cityState[req.params.cityId].cameras);
});

// Get incidents for a city
app.get('/city/:cityId/incidents', (req, res) => {
  const city = CITIES[req.params.cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  res.json(cityState[req.params.cityId].incidents);
});

// Get transcripts for a city
app.get('/city/:cityId/transcripts', (req, res) => {
  const city = CITIES[req.params.cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  res.json(cityState[req.params.cityId].recentTranscripts);
});

// Get scanner status for a city
app.get('/city/:cityId/scanner/status', (req, res) => {
  const city = CITIES[req.params.cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  const state = cityState[req.params.cityId];
  res.json({
    city: city.shortName,
    scannerStats: state.scannerStats,
    openMHzStats: state.openMHzStats,
    activeStreams: state.activeStreams.size,
    isHealthy: state.scannerStats.totalChunks > 0 || state.openMHzStats.callsFetched > 0
  });
});

// Camera image proxy for any city
app.get('/city/:cityId/camera-image/:camId', async (req, res) => {
  const { cityId, camId } = req.params;
  const city = CITIES[cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  try {
    if (cityId === 'nyc') {
      const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${camId}/image`);
      const buffer = await response.arrayBuffer();
      res.set('Content-Type', 'image/jpeg');
      res.send(Buffer.from(buffer));
    } else if (cityId === 'mpls') {
      // MnDOT camera image - find the camera and get its image URL
      const cam = cityState[cityId].cameras.find(c => c.id === camId);
      if (cam && cam.imageUrl) {
        try {
          const response = await fetch(cam.imageUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'image/*',
              'Referer': 'https://511mn.org/'
            },
            timeout: 5000
          });
          
          // Check if MnDOT is under maintenance
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('text/html')) {
            console.log(`[MPLS CAM] MnDOT appears to be under maintenance`);
            return res.status(503).json({ 
              error: 'MnDOT cameras under maintenance',
              message: 'Minnesota DOT camera system is currently under seasonal maintenance. Please try again later.'
            });
          }
          
          if (!response.ok) {
            console.log(`[MPLS CAM] Failed to fetch ${camId}: ${response.status}`);
            return res.status(response.status).json({ error: `Camera unavailable: ${response.status}` });
          }
          const buffer = await response.arrayBuffer();
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.send(Buffer.from(buffer));
        } catch (fetchError) {
          console.log(`[MPLS CAM] Network error for ${camId}:`, fetchError.message);
          return res.status(503).json({ 
            error: 'Camera feed unavailable',
            message: 'MnDOT camera system may be under maintenance'
          });
        }
      } else {
        res.status(404).json({ error: 'Camera not found' });
      }
    }
  } catch (e) {
    console.error(`[CAM ERROR] ${cityId}/${camId}:`, e.message);
    res.status(500).json({ error: 'Failed to fetch camera image' });
  }
});

// Full init data for a city (for WebSocket alternative)
app.get('/city/:cityId/init', (req, res) => {
  const cityId = req.params.cityId;
  const city = CITIES[cityId];
  if (!city) return res.status(404).json({ error: 'City not found' });
  
  const state = cityState[cityId];
  const bureau = detectiveBureaus[cityId];
  
  // Minneapolis cameras may be under MnDOT seasonal maintenance
  const cameraStatus = cityId === 'mpls' ? {
    status: 'maintenance',
    message: 'MnDOT camera system may be under seasonal maintenance. Camera feeds may be temporarily unavailable.',
    lastChecked: new Date().toISOString()
  } : { status: 'operational' };
  
  // Base response
  const response = {
    city: {
      id: city.id,
      name: city.name,
      shortName: city.shortName,
      mapCenter: city.mapCenter,
      mapZoom: city.mapZoom,
      districts: city.districts,
      color: city.color
    },
    cameras: state.cameras,
    cameraStatus,
    incidents: state.incidents.slice(0, 20),
    transcripts: state.recentTranscripts.slice(0, 10),
    scannerStats: state.scannerStats,
    agents: bureau.getAgentStatuses(),
    predictions: bureau.getPredictionStats()
  };
  
  // Add ICE data for Minneapolis
  if (cityId === 'mpls') {
    const activeReports = getActiveICEReports();
    response.ice = {
      enabled: true,
      facilities: MPLS_ICE_FACILITIES.map(f => ({
        id: f.id,
        name: f.name,
        shortName: f.shortName,
        type: f.type,
        lat: f.lat,
        lng: f.lng,
        detainees: f.iceDetainees || 0,
        address: f.address
      })),
      hotspots: ICE_HOTSPOTS_MPLS,
      stats: {
        totalDetainees: MPLS_ICE_FACILITIES
          .filter(f => f.type === 'detention_center')
          .reduce((sum, f) => sum + (f.iceDetainees || 0), 0),
        totalArrests: ICE_STATS_STPAUL.arrests.total,
        activeReports: activeReports.length,
        verifiedReports: activeReports.filter(r => r.verified).length
      },
      watcher: iceWatcher ? {
        status: iceWatcher.status,
        alertCount: iceWatcher.recentAlerts.length,
        lastAlert: iceWatcher.recentAlerts[0] || null
      } : null,
      recentReports: activeReports.slice(0, 5),
      recentAlerts: iceWatcher ? iceWatcher.getAlerts(5) : [],
      mapLayers: {
        facilities: true,
        hotspots: true,
        reports: true
      }
    };
  }
  
  res.json(response);
});

// ============================================
// LEGACY ENDPOINTS (default to NYC for backwards compatibility)
// ============================================

// Core endpoints
app.get('/', (req, res) => res.json({ 
  name: "DISPATCH", 
  version: "2.0",
  status: "operational", 
  cities: Object.keys(CITIES),
  connections: clients.size, 
  totalIncidents: Object.values(cityState).reduce((sum, s) => sum + s.incidents.length, 0),
  agents: detectiveBureau.getAgentStatuses(), 
  predictionAccuracy: detectiveBureau.getAccuracy() 
}));
app.get('/cameras', (req, res) => res.json(cameras));
app.get('/incidents', (req, res) => res.json(incidents));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/audio/:id', (req, res) => { const buffer = audioClips.get(req.params.id); if (!buffer) return res.status(404).json({ error: 'Not found' }); res.set('Content-Type', 'audio/mpeg'); res.send(buffer); });
app.get('/camera-image/:id', async (req, res) => { try { const response = await fetch(`https://webcams.nyctmc.org/api/cameras/${req.params.id}/image`); const buffer = await response.arrayBuffer(); res.set('Content-Type', 'image/jpeg'); res.send(Buffer.from(buffer)); } catch (e) { res.status(500).json({ error: 'Failed' }); } });
app.get('/stream/feeds', (req, res) => res.json({ feeds: NYPD_FEEDS, currentFeed: NYPD_FEEDS[currentFeedIndex], streamUrl: '/stream/live' }));
app.get('/debug', (req, res) => res.json({ 
  scanner: {
    ...scannerStats,
    activeStreamCount: activeStreams.size,
    maxConcurrent: MAX_CONCURRENT_STREAMS,
    activeFeeds: Array.from(activeStreams.keys()).map(id => {
      const feed = NYPD_FEEDS.find(f => f.id === id);
      return { id, name: feed?.name || 'Unknown' };
    }),
    allFeeds: NYPD_FEEDS.map(f => f.name),
    uptime: process.uptime()
  },
  openMHz: openMHzStats,
  connections: clients.size, 
  incidents: incidents.length, 
  cameras: cameras.length, 
  agents: detectiveBureau.getAgentStatuses(), 
  predictions: detectiveBureau.getPredictionStats() 
}));

// Scanner control endpoints
app.post('/scanner/restart', (req, res) => {
  console.log('[MULTI-STREAM] Manual restart triggered');
  // Close all existing streams
  activeStreams.forEach((info, id) => {
    if (info.req) info.req.destroy();
  });
  activeStreams.clear();
  streamState.clear();
  // Restart
  scannerStats.manualRestarts = (scannerStats.manualRestarts || 0) + 1;
  startBroadcastifyStream();
  res.json({ success: true, message: 'Multi-stream restart triggered', stats: scannerStats });
});

app.get('/scanner/status', (req, res) => {
  const lastChunk = scannerStats.lastChunkTime ? new Date(scannerStats.lastChunkTime) : null;
  const silentSeconds = lastChunk ? Math.round((Date.now() - lastChunk.getTime()) / 1000) : null;
  
  res.json({
    ...scannerStats,
    mode: 'multi-stream',
    activeStreams: activeStreams.size,
    maxStreams: MAX_CONCURRENT_STREAMS,
    activeFeeds: Array.from(activeStreams.keys()).map(id => {
      const feed = NYPD_FEEDS.find(f => f.id === id);
      const state = streamState.get(id);
      return { 
        id, 
        name: feed?.name || 'Unknown',
        chunksBuffered: state?.chunks?.length || 0,
        lastData: state?.lastDataTime ? Math.round((Date.now() - state.lastDataTime) / 1000) + 's ago' : 'never'
      };
    }),
    silentSeconds,
    isHealthy: activeStreams.size > 0 && silentSeconds !== null && silentSeconds < 60,
    filteredGarbage: scannerStats.filteredGarbage || 0,
    filteredRepetitive: scannerStats.filteredRepetitive || 0,
    successRate: scannerStats.totalChunks > 0 
      ? ((scannerStats.successfulTranscripts / scannerStats.totalChunks) * 100).toFixed(1) + '%'
      : '0%',
    openMHz: openMHzStats
  });
});

// Add/remove feeds from active streams
app.post('/scanner/add-feed', (req, res) => {
  const { feedId } = req.body;
  const feed = NYPD_FEEDS.find(f => f.id === feedId);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  if (activeStreams.has(feedId)) return res.json({ message: 'Feed already active' });
  
  connectToFeed(feed);
  res.json({ success: true, message: `Connecting to ${feed.name}` });
});

app.post('/scanner/remove-feed', (req, res) => {
  const { feedId } = req.body;
  if (!activeStreams.has(feedId)) return res.status(404).json({ error: 'Feed not active' });
  
  const info = activeStreams.get(feedId);
  if (info.req) info.req.destroy();
  activeStreams.delete(feedId);
  streamState.delete(feedId);
  
  res.json({ success: true, message: `Disconnected from feed ${feedId}` });
});

// WebSocket with city subscription support
wss.on('connection', (ws, req) => {
  clients.add(ws);
  
  // Parse city from query string: ws://host/ws?city=mpls
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedCity = url.searchParams.get('city') || 'nyc';
  ws.subscribedCity = requestedCity;
  
  // Add to city-specific client list
  if (cityState[requestedCity]) {
    cityState[requestedCity].clients.add(ws);
  }
  
  const city = CITIES[requestedCity] || CITIES.nyc;
  const state = cityState[requestedCity] || cityState.nyc;
  
  // Send city-specific init data
  const cameraStatus = requestedCity === 'mpls' ? {
    status: 'maintenance',
    message: 'MnDOT camera system may be under seasonal maintenance. Camera feeds may be temporarily unavailable.'
  } : { status: 'operational' };
  
  ws.send(JSON.stringify({
    type: "init",
    city: {
      id: city.id,
      name: city.name,
      shortName: city.shortName,
      mapCenter: city.mapCenter,
      mapZoom: city.mapZoom,
      districts: city.districts,
      color: city.color
    },
    cities: Object.values(CITIES).map(c => ({ id: c.id, name: c.name, shortName: c.shortName, color: c.color })),
    incidents: state.incidents.slice(0, 20),
    cameras: state.cameras,
    cameraStatus,
    transcripts: state.recentTranscripts.slice(0, 10),
    activeFeeds: Array.from(state.activeStreams?.keys() || []),
    streamCount: state.activeStreams?.size || 0,
    agents: detectiveBureaus[requestedCity].getAgentStatuses(),
    predictions: detectiveBureaus[requestedCity].getPredictionStats(),
    facilities: requestedCity === 'nyc' ? NYC_FACILITIES.map(f => ({
      id: f.id, name: f.name, shortName: f.shortName, borough: f.borough,
      lat: f.lat, lng: f.lng, currentPopulation: f.currentPopulation
    })) : [],
    facilityStatus: requestedCity === 'nyc' ? getAllFacilitiesStatus() : null
  }));
  
  ws.on('close', () => {
    clients.delete(ws);
    Object.values(cityState).forEach(state => state.clients.delete(ws));
  });
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Allow switching cities
      if (data.type === 'subscribe_city') {
        const newCity = data.city;
        if (CITIES[newCity]) {
          if (ws.subscribedCity && cityState[ws.subscribedCity]) {
            cityState[ws.subscribedCity].clients.delete(ws);
          }
          ws.subscribedCity = newCity;
          cityState[newCity].clients.add(ws);
          
          const city = CITIES[newCity];
          const state = cityState[newCity];
          
          ws.send(JSON.stringify({
            type: "city_changed",
            city: { id: city.id, name: city.name, shortName: city.shortName, mapCenter: city.mapCenter, mapZoom: city.mapZoom, districts: city.districts, color: city.color },
            incidents: state.incidents.slice(0, 20),
            cameras: state.cameras,
            transcripts: state.recentTranscripts.slice(0, 10)
          }));
        }
      }
      
      if (data.type === 'manual_transcript') {
        const cityId = ws.subscribedCity || 'nyc';
        broadcastToCity(cityId, { type: "transcript", text: data.text, timestamp: new Date().toISOString() });
        const parsed = await parseTranscript(data.text);
        if (parsed.hasIncident) {
          const state = cityState[cityId];
          state.incidentId++;
          const cam = findNearestCamera(parsed.location, null, null, parsed.borough);
          const incident = { id: state.incidentId, ...parsed, camera: cam, lat: cam?.lat, lng: cam?.lng, city: cityId, timestamp: new Date().toISOString() };
          state.incidents.unshift(incident);
          if (state.incidents.length > 50) state.incidents.pop();
          detectiveBureaus[cityId].processIncident(incident, (d) => broadcastToCity(cityId, d));
          checkBetsForIncident(incident);
          broadcastToCity(cityId, { type: "incident", incident });
          if (cam) broadcastToCity(cityId, { type: "camera_switch", camera: cam, reason: `${parsed.incidentType} at ${parsed.location}` });
        }
      }
    } catch (e) { console.error('WS error:', e); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
=====================================================
  DISPATCH - Multi-City Police Scanner Intelligence
  Port: ${PORT}
  Cities: ${Object.keys(CITIES).map(c => CITIES[c].shortName).join(', ')}
  Agents: CHASE | PATTERN | PROPHET | HISTORIAN
=====================================================
  `);
});
