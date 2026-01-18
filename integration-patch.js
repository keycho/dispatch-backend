// ============================================
// INTEGRATION PATCH - Add to server.js
// ============================================

// 1. Add import at top of file:
import { DetectiveBureau } from './detective-bureau.js';

// 2. After initializing anthropic client (~line 28), add:
const detectiveBureau = new DetectiveBureau(anthropic);

// 3. In processAudioFromStream, after creating the incident (~line 330), replace the detective commentary with:

// OLD CODE (remove this):
// generateDetectiveCommentary(incident, recentIncidentsForAnalysis.slice(0, 5))
//   .then(commentary => {...})

// NEW CODE (add this):
detectiveBureau.processIncident(incident, broadcast)
  .then(insights => {
    if (insights.length > 0) {
      console.log(`[Detective Bureau] ${insights.length} agents responded to incident ${incident.id}`);
    }
  });

// 4. Replace your existing /detective/ask endpoint with:

app.post('/detective/ask', express.json(), async (req, res) => {
  const { question, incidentId, caseId } = req.body;
  
  if (!question) {
    return res.status(400).json({ error: 'Question required' });
  }
  
  try {
    const response = await detectiveBureau.askAgents(question, { incidentId, caseId });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Replace your existing /detective/briefing endpoint with:

app.get('/detective/briefing', async (req, res) => {
  try {
    const briefing = await detectiveBureau.generateBriefing();
    res.json(briefing);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Add new endpoints for agent-specific features:

// Get all agent statuses
app.get('/detective/agents', (req, res) => {
  res.json(detectiveBureau.getAgentStatuses());
});

// Get prediction stats & accuracy
app.get('/detective/predictions', (req, res) => {
  res.json(detectiveBureau.getPredictionStats());
});

// Get active patterns
app.get('/detective/patterns', (req, res) => {
  res.json({
    active: detectiveBureau.memory.patterns.filter(p => p.status === 'active'),
    total: detectiveBureau.memory.patterns.length
  });
});

// Get hotspot data for heatmap
app.get('/detective/hotspots', (req, res) => {
  const hotspots = Array.from(detectiveBureau.memory.hotspots.entries())
    .map(([key, count]) => {
      const [borough, location] = key.split('-');
      return { borough, location, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
  
  res.json(hotspots);
});


// ============================================
// NEW WEBSOCKET MESSAGE TYPES
// ============================================
// The Detective Bureau will broadcast these message types:

/*
{
  type: 'agent_insight',
  agent: 'CHASE' | 'PATTERN' | 'PROPHET' | 'HISTORIAN',
  agentIcon: '🚔' | '🔍' | '🔮' | '📚',
  type: 'pursuit_analysis' | 'pattern_detected' | 'prediction' | 'historical_context',
  incidentId: number,
  analysis: string,
  urgency: 'critical' | 'high' | 'medium' | 'low',
  timestamp: string
}

{
  type: 'prediction_hit',
  agent: 'PROPHET',
  prediction: { ... },
  matchedIncident: number,
  timestamp: string
}

{
  type: 'pattern_alert',
  agent: 'PATTERN',
  pattern: {
    patternName: string,
    connections: string[],
    involvedIncidents: number[],
    prediction: { location, timeWindow, confidence }
  },
  timestamp: string
}
*/


// ============================================
// FRONTEND WEBSOCKET HANDLER UPDATE
// ============================================
// Update your frontend to handle new message types:

/*
socket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'incident':
      // Existing handler
      break;
      
    case 'agent_insight':
      // NEW: Show agent insight in sidebar/ticker
      addAgentInsight(data);
      
      // If critical, show notification
      if (data.urgency === 'critical') {
        showCriticalAlert(data);
      }
      break;
      
    case 'pattern_detected':
      // NEW: Highlight pattern zone on map
      highlightPatternZone(data.pattern);
      addCaseCard(data.pattern);
      break;
      
    case 'prediction_hit':
      // NEW: Show prediction success animation
      celebratePrediction(data);
      updateAccuracyDisplay();
      break;
      
    // ... etc
  }
};
*/


// ============================================
// EXAMPLE FRONTEND COMPONENT (React)
// ============================================

const AgentInsightTicker = () => {
  const [insights, setInsights] = useState([]);
  
  useEffect(() => {
    socket.on('agent_insight', (insight) => {
      setInsights(prev => [insight, ...prev].slice(0, 10));
    });
  }, []);
  
  return (
    <div className="agent-ticker">
      {insights.map((insight, i) => (
        <div 
          key={i} 
          className={`insight-item urgency-${insight.urgency}`}
        >
          <span className="agent-icon">{insight.agentIcon}</span>
          <span className="agent-name">{insight.agent}</span>
          <span className="insight-text">
            {insight.analysis?.substring(0, 150)}...
          </span>
        </div>
      ))}
    </div>
  );
};

const AgentSidebar = () => {
  const [agents, setAgents] = useState([]);
  const [predictions, setPredictions] = useState([]);
  
  useEffect(() => {
    // Fetch agent statuses
    fetch('/detective/agents')
      .then(r => r.json())
      .then(setAgents);
      
    // Fetch predictions
    fetch('/detective/predictions')
      .then(r => r.json())
      .then(setPredictions);
      
    // Refresh every 30s
    const interval = setInterval(() => {
      fetch('/detective/agents').then(r => r.json()).then(setAgents);
      fetch('/detective/predictions').then(r => r.json()).then(setPredictions);
    }, 30000);
    
    return () => clearInterval(interval);
  }, []);
  
  return (
    <div className="agent-sidebar">
      <h3>DETECTIVE BUREAU</h3>
      
      <div className="accuracy-display">
        <span>Prediction Accuracy: {predictions.accuracy}</span>
      </div>
      
      <div className="agent-list">
        {agents.map(agent => (
          <div key={agent.id} className={`agent-card status-${agent.status}`}>
            <span className="icon">{agent.icon}</span>
            <div className="info">
              <strong>{agent.name}</strong>
              <span className="role">{agent.role}</span>
              <span className="status">{agent.status}</span>
            </div>
          </div>
        ))}
      </div>
      
      <div className="predictions">
        <h4>Active Predictions</h4>
        {predictions.pending?.slice(0, 5).map((pred, i) => (
          <div key={i} className="prediction-card">
            <span className="location">{pred.location}</span>
            <span className="confidence">{(pred.confidence * 100).toFixed(0)}%</span>
            <span className="expires">
              Expires: {new Date(pred.expiresAt).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
