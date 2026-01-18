// ============================================
// DETECTIVE BUREAU - Multi-Agent Crime Analysis
// ============================================
// Drop this into your server.js or import as module

import Anthropic from '@anthropic-ai/sdk';

export class DetectiveBureau {
  constructor(anthropicClient) {
    this.anthropic = anthropicClient;
    
    // Agent registry
    this.agents = new Map();
    
    // Shared memory across agents
    this.memory = {
      incidents: [],           // Last 200 incidents
      cases: new Map(),        // Active case files
      predictions: [],         // Predictions with outcomes
      patterns: [],            // Detected patterns
      suspectProfiles: [],     // Running suspect descriptions
      hotspots: new Map(),     // Location -> activity count
    };
    
    // Prediction tracking
    this.predictionStats = {
      total: 0,
      correct: 0,
      pending: []
    };
    
    // Initialize specialized agents
    this.initializeAgents();
    
    // Run agent cycles
    this.startAgentLoops();
  }

  initializeAgents() {
    // CHASE - Pursuit & Active Situation Specialist
    this.agents.set('CHASE', {
      name: 'CHASE',
      role: 'Pursuit Specialist',
      icon: '🚔',
      status: 'idle',
      currentCase: null,
      systemPrompt: `You are CHASE, an AI specialist in vehicle pursuits and active situations.

Your expertise:
- Predicting escape routes based on NYC street network
- Tracking suspect movement patterns
- Coordinating multi-unit responses
- Identifying when situations will escalate

You speak in short, urgent bursts during active pursuits. You're laser-focused on the immediate tactical situation.

When analyzing a pursuit, consider:
- Street directions (one-ways, dead ends)
- Likely exit points (bridges, tunnels, highways)
- Time of day traffic patterns
- Historical pursuit data in the area`,
    });

    // PATTERN - Serial Crime Analyst
    this.agents.set('PATTERN', {
      name: 'PATTERN',
      role: 'Serial Crime Analyst',
      icon: '🔍',
      status: 'monitoring',
      activePatterns: [],
      systemPrompt: `You are PATTERN, an AI analyst specializing in detecting serial crimes and criminal patterns.

Your expertise:
- Identifying MO (modus operandi) similarities
- Geographic clustering analysis
- Temporal pattern recognition
- Linking seemingly unrelated incidents

You're methodical and data-driven. You don't jump to conclusions - you build cases with evidence. You track multiple potential patterns simultaneously.

When you detect a pattern:
1. Identify the common elements
2. Estimate confidence level
3. Predict likely next occurrence
4. Suggest investigative actions`,
    });

    // PROPHET - Predictive Analyst
    this.agents.set('PROPHET', {
      name: 'PROPHET',
      role: 'Predictive Analyst', 
      icon: '🔮',
      status: 'analyzing',
      activePredictions: [],
      systemPrompt: `You are PROPHET, an AI specializing in predictive crime analysis.

Your expertise:
- Forecasting crime hotspots based on historical patterns
- Predicting escalation likelihood
- Time-based crime probability modeling
- Resource allocation recommendations

You make specific, testable predictions with confidence levels. You track your accuracy rigorously. You're honest about uncertainty.

Prediction format:
- Location (specific intersection or block)
- Time window (e.g., "next 2 hours")
- Incident type
- Confidence percentage
- Reasoning`,
    });

    // HISTORIAN - Long-term Memory & Context
    this.agents.set('HISTORIAN', {
      name: 'HISTORIAN',
      role: 'Historical Analyst',
      icon: '📚',
      status: 'monitoring',
      knownLocations: new Map(),
      knownSuspects: [],
      systemPrompt: `You are HISTORIAN, an AI with perfect memory of all past incidents.

Your expertise:
- Recognizing repeat addresses and locations
- Tracking suspect descriptions across time
- Identifying escalation patterns at specific locations
- Providing historical context for new incidents

When a new incident comes in, you check:
1. Has this address had previous calls? What kind?
2. Does this suspect description match anyone from the past week?
3. Is this part of an ongoing situation?
4. What happened last time at this location?

You provide crucial context that helps other agents make better decisions.`,
    });
  }

  startAgentLoops() {
    // PROPHET makes predictions every 15 minutes
    setInterval(() => this.prophetCycle(), 15 * 60 * 1000);
    
    // PATTERN scans for patterns every 5 minutes
    setInterval(() => this.patternCycle(), 5 * 60 * 1000);
    
    // Check prediction outcomes every minute
    setInterval(() => this.checkPredictionOutcomes(), 60 * 1000);
  }

  // ============================================
  // MAIN INCIDENT PROCESSING
  // ============================================
  
  async processIncident(incident, broadcast) {
    // Add to memory
    this.memory.incidents.unshift(incident);
    if (this.memory.incidents.length > 200) this.memory.incidents.pop();
    
    // Update hotspot tracking
    const locationKey = `${incident.borough}-${incident.location}`;
    this.memory.hotspots.set(
      locationKey, 
      (this.memory.hotspots.get(locationKey) || 0) + 1
    );
    
    // Route to appropriate agents in parallel
    const agentPromises = [];
    
    // HISTORIAN always checks for context
    agentPromises.push(this.historianAnalyze(incident));
    
    // CHASE activates for pursuits
    if (this.isPursuit(incident)) {
      agentPromises.push(this.chaseActivate(incident, broadcast));
    }
    
    // PATTERN checks for pattern matches
    agentPromises.push(this.patternCheck(incident));
    
    // PROPHET checks if this validates any predictions
    this.checkPredictionHit(incident);
    
    // Gather all agent insights
    const insights = await Promise.all(agentPromises);
    
    // Broadcast agent insights
    insights.filter(Boolean).forEach(insight => {
      broadcast({
        type: 'agent_insight',
        ...insight,
        timestamp: new Date().toISOString()
      });
    });
    
    return insights.filter(Boolean);
  }

  isPursuit(incident) {
    const pursuitKeywords = [
      'pursuit', 'fled', 'fleeing', 'chase', 'vehicle fled',
      'failed to stop', 'refusing to pull over', 'high speed'
    ];
    const text = `${incident.incidentType} ${incident.summary}`.toLowerCase();
    return pursuitKeywords.some(kw => text.includes(kw));
  }

  // ============================================
  // CHASE AGENT - Pursuit Specialist
  // ============================================
  
  async chaseActivate(incident, broadcast) {
    const agent = this.agents.get('CHASE');
    agent.status = 'active';
    agent.currentCase = incident.id;
    
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        system: agent.systemPrompt,
        messages: [{
          role: 'user',
          content: `ACTIVE PURSUIT DETECTED:
${JSON.stringify(incident, null, 2)}

Recent incidents (for context):
${JSON.stringify(this.memory.incidents.slice(0, 5), null, 2)}

Provide:
1. Likely escape routes (be specific to NYC streets)
2. Recommended containment points
3. Escalation risk assessment
4. What to watch for next

Keep it tactical and urgent.`
        }]
      });

      const analysis = response.content[0].text;
      
      // Try to extract structured prediction
      let predictedRoute = null;
      const routeMatch = analysis.match(/likely.*(north|south|east|west|FDR|West Side|BQE|LIE)/i);
      if (routeMatch) {
        predictedRoute = {
          direction: routeMatch[1],
          confidence: 0.7,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        };
        
        // Track this prediction
        this.predictionStats.pending.push({
          agent: 'CHASE',
          type: 'pursuit_route',
          prediction: predictedRoute,
          incidentId: incident.id,
          createdAt: new Date().toISOString()
        });
      }

      return {
        agent: 'CHASE',
        agentIcon: agent.icon,
        type: 'pursuit_analysis',
        incidentId: incident.id,
        analysis,
        predictedRoute,
        urgency: 'critical'
      };
      
    } catch (error) {
      console.error('[CHASE] Error:', error.message);
      return null;
    } finally {
      // Reset after 30 min
      setTimeout(() => {
        if (agent.currentCase === incident.id) {
          agent.status = 'idle';
          agent.currentCase = null;
        }
      }, 30 * 60 * 1000);
    }
  }

  // ============================================
  // PATTERN AGENT - Serial Crime Analysis
  // ============================================
  
  async patternCheck(incident) {
    const agent = this.agents.get('PATTERN');
    
    // Find similar incidents in last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentSimilar = this.memory.incidents.filter(inc => {
      if (inc.id === incident.id) return false;
      if (new Date(inc.timestamp) < oneDayAgo) return false;
      
      // Check for similarity
      const sameType = inc.incidentType?.toLowerCase() === incident.incidentType?.toLowerCase();
      const sameBorough = inc.borough === incident.borough;
      const similarDesc = this.textSimilarity(inc.summary, incident.summary) > 0.3;
      
      return sameType || (sameBorough && similarDesc);
    });
    
    if (recentSimilar.length < 2) return null;
    
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: agent.systemPrompt,
        messages: [{
          role: 'user',
          content: `New incident that may be part of a pattern:
${JSON.stringify(incident, null, 2)}

Similar recent incidents:
${JSON.stringify(recentSimilar.slice(0, 10), null, 2)}

Analyze:
1. Is this part of a pattern? (be skeptical, require real evidence)
2. If yes, what connects them?
3. Predicted next occurrence (location, time, type)
4. Confidence level (LOW/MEDIUM/HIGH)

Respond in JSON:
{
  "patternDetected": true/false,
  "patternName": "string (creative name if pattern exists)",
  "connections": ["list of connecting factors"],
  "involvedIncidents": [ids],
  "prediction": {
    "location": "specific area",
    "timeWindow": "e.g., next 4 hours",
    "confidence": 0.0-1.0
  },
  "analysis": "string explanation"
}`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        if (result.patternDetected) {
          // Store the pattern
          this.memory.patterns.push({
            ...result,
            detectedAt: new Date().toISOString(),
            status: 'active'
          });
          
          // Track prediction if made
          if (result.prediction && result.prediction.confidence > 0.5) {
            this.predictionStats.pending.push({
              agent: 'PATTERN',
              type: 'pattern_prediction',
              prediction: result.prediction,
              patternName: result.patternName,
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
            });
          }
          
          return {
            agent: 'PATTERN',
            agentIcon: agent.icon,
            type: 'pattern_detected',
            pattern: result,
            urgency: result.prediction?.confidence > 0.7 ? 'high' : 'medium'
          };
        }
      }
      
      return null;
      
    } catch (error) {
      console.error('[PATTERN] Error:', error.message);
      return null;
    }
  }
  
  async patternCycle() {
    // Periodic deep pattern analysis
    if (this.memory.incidents.length < 10) return;
    
    const agent = this.agents.get('PATTERN');
    agent.status = 'analyzing';
    
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: agent.systemPrompt,
        messages: [{
          role: 'user',
          content: `Deep pattern analysis of recent activity:

${JSON.stringify(this.memory.incidents.slice(0, 50), null, 2)}

Known active patterns:
${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'), null, 2)}

Perform comprehensive analysis:
1. New patterns not yet detected
2. Updates to existing patterns  
3. Patterns that should be closed (no new activity)
4. Cross-pattern connections

Be thorough but skeptical. Only report real patterns.`
        }]
      });
      
      // Store analysis results
      const analysis = response.content[0].text;
      console.log('[PATTERN] Cycle complete:', analysis.substring(0, 200));
      
    } catch (error) {
      console.error('[PATTERN] Cycle error:', error.message);
    } finally {
      agent.status = 'monitoring';
    }
  }

  // ============================================
  // PROPHET AGENT - Predictions
  // ============================================
  
  async prophetCycle() {
    if (this.memory.incidents.length < 5) return;
    
    const agent = this.agents.get('PROPHET');
    agent.status = 'predicting';
    
    try {
      // Analyze hotspots
      const hotspotArray = Array.from(this.memory.hotspots.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: agent.systemPrompt + `

Your current prediction accuracy: ${this.getAccuracyString()}
Be calibrated - if you've been overconfident, adjust down.`,
        messages: [{
          role: 'user',
          content: `Generate predictions for the next 2 hours.

Recent incidents:
${JSON.stringify(this.memory.incidents.slice(0, 30), null, 2)}

Current hotspots (location -> incident count):
${JSON.stringify(hotspotArray)}

Current time: ${new Date().toISOString()}
Day of week: ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}

Provide 2-3 specific predictions in JSON:
{
  "predictions": [
    {
      "id": "pred_${Date.now()}",
      "location": "specific location",
      "borough": "borough name",
      "incidentType": "predicted type",
      "timeWindow": "e.g., 2:00 AM - 4:00 AM",
      "confidence": 0.0-1.0,
      "reasoning": "why you predict this"
    }
  ],
  "overallAssessment": "1-2 sentence city-wide assessment"
}`
        }]
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        
        // Store predictions for tracking
        result.predictions.forEach(pred => {
          const prediction = {
            ...pred,
            agent: 'PROPHET',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            status: 'pending'
          };
          
          this.memory.predictions.push(prediction);
          this.predictionStats.pending.push(prediction);
          this.predictionStats.total++;
        });
        
        agent.activePredictions = result.predictions;
        
        return result;
      }
      
    } catch (error) {
      console.error('[PROPHET] Cycle error:', error.message);
    } finally {
      agent.status = 'analyzing';
    }
    
    return null;
  }
  
  checkPredictionHit(incident) {
    // Check if this incident matches any pending predictions
    const now = new Date();
    
    this.predictionStats.pending = this.predictionStats.pending.filter(pred => {
      // Skip expired
      if (new Date(pred.expiresAt) < now) {
        pred.status = 'expired';
        return false;
      }
      
      // Check for match
      const locationMatch = pred.location && 
        incident.location?.toLowerCase().includes(pred.location.toLowerCase());
      const boroughMatch = pred.borough && 
        incident.borough?.toLowerCase() === pred.borough?.toLowerCase();
      const typeMatch = pred.incidentType &&
        incident.incidentType?.toLowerCase().includes(pred.incidentType.toLowerCase());
      
      if ((locationMatch || boroughMatch) && typeMatch) {
        // HIT!
        pred.status = 'correct';
        pred.matchedIncident = incident.id;
        this.predictionStats.correct++;
        
        console.log(`[PROPHET] Prediction HIT! ${pred.id} matched incident ${incident.id}`);
        return false; // Remove from pending
      }
      
      return true; // Keep in pending
    });
  }
  
  checkPredictionOutcomes() {
    const now = new Date();
    
    // Expire old predictions
    this.predictionStats.pending = this.predictionStats.pending.filter(pred => {
      if (new Date(pred.expiresAt) < now) {
        pred.status = 'expired';
        return false;
      }
      return true;
    });
  }
  
  getAccuracyString() {
    if (this.predictionStats.total === 0) return 'No predictions yet';
    const accuracy = (this.predictionStats.correct / this.predictionStats.total * 100).toFixed(1);
    return `${accuracy}% (${this.predictionStats.correct}/${this.predictionStats.total})`;
  }

  // ============================================
  // HISTORIAN AGENT - Context & Memory
  // ============================================
  
  async historianAnalyze(incident) {
    const agent = this.agents.get('HISTORIAN');
    
    // Check for historical matches
    const locationHistory = this.memory.incidents.filter(inc => 
      inc.id !== incident.id &&
      inc.location?.toLowerCase() === incident.location?.toLowerCase()
    );
    
    const suspectMatches = this.findSuspectMatches(incident);
    
    // Only engage if there's relevant history
    if (locationHistory.length === 0 && suspectMatches.length === 0) {
      return null;
    }
    
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: agent.systemPrompt,
        messages: [{
          role: 'user',
          content: `New incident:
${JSON.stringify(incident, null, 2)}

Previous incidents at this location (${locationHistory.length}):
${JSON.stringify(locationHistory.slice(0, 5), null, 2)}

Possible suspect matches from other incidents:
${JSON.stringify(suspectMatches.slice(0, 3), null, 2)}

Provide relevant historical context in 2-3 sentences. What should we know about this location or these suspects?`
        }]
      });

      return {
        agent: 'HISTORIAN',
        agentIcon: agent.icon,
        type: 'historical_context',
        incidentId: incident.id,
        context: response.content[0].text,
        locationHistory: locationHistory.length,
        suspectMatches: suspectMatches.length,
        urgency: locationHistory.length > 3 ? 'medium' : 'low'
      };
      
    } catch (error) {
      console.error('[HISTORIAN] Error:', error.message);
      return null;
    }
  }
  
  findSuspectMatches(incident) {
    if (!incident.summary) return [];
    
    // Extract suspect descriptors
    const descriptors = this.extractDescriptors(incident.summary);
    if (descriptors.length === 0) return [];
    
    // Find incidents with matching descriptors
    return this.memory.incidents.filter(inc => {
      if (inc.id === incident.id) return false;
      if (!inc.summary) return false;
      
      const incDescriptors = this.extractDescriptors(inc.summary);
      const matches = descriptors.filter(d => incDescriptors.includes(d));
      
      return matches.length >= 2; // At least 2 matching descriptors
    });
  }
  
  extractDescriptors(text) {
    const descriptors = [];
    const lower = text.toLowerCase();
    
    // Clothing colors
    const colors = ['black', 'white', 'red', 'blue', 'green', 'gray', 'grey', 'brown', 'yellow', 'orange', 'purple', 'pink'];
    colors.forEach(c => { if (lower.includes(c)) descriptors.push(c); });
    
    // Clothing items
    const items = ['hoodie', 'jacket', 'coat', 'hat', 'cap', 'jeans', 'pants', 'sneakers', 'boots', 'backpack', 'bag', 'mask'];
    items.forEach(i => { if (lower.includes(i)) descriptors.push(i); });
    
    // Physical descriptors
    const physical = ['male', 'female', 'tall', 'short', 'heavy', 'slim', 'beard', 'glasses'];
    physical.forEach(p => { if (lower.includes(p)) descriptors.push(p); });
    
    return descriptors;
  }

  // ============================================
  // INTER-AGENT COMMUNICATION
  // ============================================
  
  async askAgents(question, context = {}) {
    // Determine which agent should answer based on question type
    const questionLower = question.toLowerCase();
    
    let primaryAgent = 'PATTERN'; // Default
    
    if (questionLower.includes('pursuit') || questionLower.includes('chase') || questionLower.includes('fled')) {
      primaryAgent = 'CHASE';
    } else if (questionLower.includes('predict') || questionLower.includes('next') || questionLower.includes('expect')) {
      primaryAgent = 'PROPHET';
    } else if (questionLower.includes('before') || questionLower.includes('history') || questionLower.includes('last time')) {
      primaryAgent = 'HISTORIAN';
    }
    
    const agent = this.agents.get(primaryAgent);
    
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `${agent.systemPrompt}

You are responding to a user question. Be helpful, specific, and reference actual data when possible.

Current prediction accuracy: ${this.getAccuracyString()}
Active cases: ${this.memory.cases.size}
Incidents in memory: ${this.memory.incidents.length}`,
        messages: [{
          role: 'user',
          content: `Question: ${question}

Context:
- Recent incidents: ${JSON.stringify(this.memory.incidents.slice(0, 10), null, 2)}
- Active patterns: ${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'), null, 2)}
- Pending predictions: ${JSON.stringify(this.predictionStats.pending.slice(0, 5), null, 2)}
${context.incidentId ? `- Specific incident: ${JSON.stringify(this.memory.incidents.find(i => i.id === context.incidentId), null, 2)}` : ''}`
        }]
      });

      return {
        agent: primaryAgent,
        agentIcon: agent.icon,
        answer: response.content[0].text,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error(`[${primaryAgent}] Ask error:`, error.message);
      return {
        agent: primaryAgent,
        error: error.message
      };
    }
  }

  // ============================================
  // BRIEFING GENERATION
  // ============================================
  
  async generateBriefing() {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentIncidents = this.memory.incidents.filter(
      i => new Date(i.timestamp) > hourAgo
    );
    
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: `You are the Detective Bureau briefing system. Synthesize reports from all agents into a cohesive briefing.

Agents reporting:
- CHASE (Pursuit Specialist)
- PATTERN (Serial Crime Analyst)
- PROPHET (Predictive Analyst) - Accuracy: ${this.getAccuracyString()}
- HISTORIAN (Historical Context)

Be concise, actionable, and highlight what matters most.`,
      messages: [{
        role: 'user',
        content: `Generate a Detective Bureau briefing.

ACTIVITY SUMMARY:
- Incidents (last hour): ${recentIncidents.length}
- Incidents (total in memory): ${this.memory.incidents.length}
- Active patterns: ${this.memory.patterns.filter(p => p.status === 'active').length}
- Pending predictions: ${this.predictionStats.pending.length}
- Prediction accuracy: ${this.getAccuracyString()}

RECENT INCIDENTS:
${JSON.stringify(recentIncidents.slice(0, 15), null, 2)}

ACTIVE PATTERNS:
${JSON.stringify(this.memory.patterns.filter(p => p.status === 'active'), null, 2)}

CURRENT PREDICTIONS:
${JSON.stringify(this.predictionStats.pending, null, 2)}

TOP HOTSPOTS:
${JSON.stringify(Array.from(this.memory.hotspots.entries()).sort((a,b) => b[1] - a[1]).slice(0, 5))}

Provide:
1. Executive Summary (2-3 sentences)
2. Key Developments (bullet points)
3. Active Threats/Patterns
4. Predictions for Next 2 Hours
5. Recommended Actions`
      }]
    });

    return {
      briefing: response.content[0].text,
      stats: {
        incidentsLastHour: recentIncidents.length,
        totalIncidents: this.memory.incidents.length,
        activePatterns: this.memory.patterns.filter(p => p.status === 'active').length,
        pendingPredictions: this.predictionStats.pending.length,
        predictionAccuracy: this.getAccuracyString()
      },
      agents: Array.from(this.agents.values()).map(a => ({
        name: a.name,
        role: a.role,
        icon: a.icon,
        status: a.status
      })),
      timestamp: new Date().toISOString()
    };
  }

  // ============================================
  // UTILITIES
  // ============================================
  
  textSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const words1 = new Set(text1.toLowerCase().split(/\W+/));
    const words2 = new Set(text2.toLowerCase().split(/\W+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  // Get all agent statuses for frontend
  getAgentStatuses() {
    return Array.from(this.agents.entries()).map(([id, agent]) => ({
      id,
      name: agent.name,
      role: agent.role,
      icon: agent.icon,
      status: agent.status,
      currentCase: agent.currentCase,
      activePredictions: agent.activePredictions?.length || 0,
      activePatterns: agent.activePatterns?.length || 0
    }));
  }

  // Get prediction leaderboard
  getPredictionStats() {
    return {
      ...this.predictionStats,
      accuracy: this.getAccuracyString(),
      recentPredictions: this.memory.predictions.slice(0, 20)
    };
  }
}

export default DetectiveBureau;
