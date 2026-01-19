# Detective Bureau API Documentation

## Overview

The Detective Bureau is an enhanced AI agent system with 4 specialized agents, persistent memory, cross-agent collaboration, and prediction tracking with feedback loops.

## Features Added

### ✅ Persistent Memory
- Saves to `detective_memory.json` every 60 seconds
- Survives server restarts
- Stores: incidents, patterns, predictions, agent stats, collaborations

### ✅ Agent Collaboration
- Agents can consult each other for context
- CHASE asks HISTORIAN about location history
- PATTERN asks PROPHET for predictive context
- All collaborations logged and queryable

### ✅ Prediction Feedback Tracking
- Every prediction tracked with outcome (hit/miss/pending)
- Accuracy calculated by type, borough, confidence level
- Confidence calibration analysis (is PROPHET overconfident?)
- Manual feedback endpoint for corrections

### ✅ Enhanced Agent Stats
- Each agent tracks activations, insights, successes
- History of recent analyses preserved
- Stats persist across restarts

---

## API Endpoints

### Overview & Status

#### `GET /detective/overview`
Combined status of all agents with metrics.

```json
{
  "agents": [...],
  "predictions": { "total": 45, "correct": 12, "accuracy": "26.7%", "pending": 3 },
  "patterns": { "active": 2, "total": 15 },
  "memory": { "incidents": 234, "insights": 180, "collaborations": 45 },
  "uptime": 3600,
  "timestamp": "..."
}
```

#### `GET /detective/agents`
List all agent statuses with stats.

#### `GET /detective/agent/:agentId`
Get detailed info for one agent (CHASE, PATTERN, PROPHET, HISTORIAN).

---

### 🚔 CHASE - Pursuit Specialist

#### `GET /detective/chase`
Full CHASE data including recent pursuits, analysis history, and hot zones.

```json
{
  "agent": { "id": "CHASE", "name": "CHASE", "stats": {...} },
  "recentPursuits": [...],
  "analysisHistory": [...],
  "hotZones": [{ "borough": "Brooklyn", "count": 12 }],
  "timestamp": "..."
}
```

#### `GET /detective/chase/history?limit=50`
CHASE's pursuit analysis history.

#### `GET /detective/chase/active`
Incidents from last 30 minutes that triggered CHASE.

---

### 🔗 PATTERN - Serial Crime Analyst

#### `GET /detective/pattern`
Full PATTERN data with active/expired patterns and timeline.

```json
{
  "agent": {...},
  "activePatterns": [{ "id": "pattern_123", "patternName": "East Village Phone Snatcher", "incidentCount": 4 }],
  "expiredPatterns": [...],
  "timeline": [...],
  "stats": { "patternsFound": 8, "linkedIncidents": 32 }
}
```

#### `GET /detective/pattern/active`
Just the active patterns.

#### `GET /detective/pattern/:patternId`
Specific pattern with linked incidents.

#### `GET /detective/patterns?status=active|expired|all`
Filter patterns by status.

---

### 🔮 PROPHET - Predictive Analyst

#### `GET /detective/prophet`
Full PROPHET data with accuracy charts.

```json
{
  "agent": {...},
  "pendingPredictions": [...],
  "predictionHistory": [...],
  "accuracyOverTime": [{ "period": 0, "accuracy": 30, "hits": 3, "total": 10 }],
  "accuracyByType": [{ "type": "robbery", "accuracy": "45.0", "total": 20 }],
  "accuracyByBorough": [...],
  "confidenceCalibration": [{ "bucket": "high", "avgConfidence": "75.0", "actualAccuracy": "42.0" }]
}
```

#### `GET /detective/prophet/predictions?status=pending|hit|miss|all&limit=50`
Filter predictions by outcome.

#### `GET /detective/prophet/accuracy`
Detailed accuracy breakdown for charts.

```json
{
  "overall": { "total": 45, "hits": 12, "accuracy": "26.7%" },
  "overTime": [...],
  "byConfidence": [{ "confidence": 0.8, "accuracy": "35.0", "total": 10 }],
  "byType": [...],
  "recentHistory": [...]
}
```

#### `POST /detective/prophet/feedback`
Manually correct a prediction outcome.

```json
// Request
{ "predictionId": "pred_123", "outcome": "hit", "matchedIncidentId": 456 }

// Response
{ "success": true, "prediction": {...}, "newAccuracy": "28.0%" }
```

#### `POST /detective/prophet/predict`
Force PROPHET to make predictions now (for testing).

---

### 📚 HISTORIAN - Historical Context

#### `GET /detective/historian`
Full HISTORIAN data with problem addresses and hotspots.

```json
{
  "agent": {...},
  "problemAddresses": [{ "address": "125 e 14th st", "count": 8 }],
  "hotspots": [{ "borough": "Manhattan", "location": "Penn Station", "count": 15 }],
  "repeatLocations": [...],
  "totalAddressesTracked": 342
}
```

#### `GET /detective/historian/hotspots?limit=50&minCount=2`
Hotspots with filtering.

#### `GET /detective/historian/address/:address`
Full history for a specific address.

```json
{
  "address": "125 e 14th st",
  "totalCalls": 8,
  "incidents": [...],
  "insights": [...]
}
```

---

### Agent Collaboration

#### `GET /detective/collaboration`
All cross-agent consultations.

```json
{
  "recent": [{ "sourceAgent": "CHASE", "targetAgent": "HISTORIAN", "insight": "..." }],
  "byPair": [{ "pair": "CHASE→HISTORIAN", "count": 12 }],
  "total": 45
}
```

#### `GET /detective/collaboration/graph`
Graph data for visualization (nodes + edges).

```json
{
  "nodes": [{ "id": "CHASE", "name": "CHASE", "icon": "🚔" }],
  "edges": [{ "source": "CHASE", "target": "HISTORIAN", "weight": 12 }]
}
```

---

### General

#### `GET /detective/briefing`
AI-generated briefing of current situation.

#### `POST /detective/ask`
Ask all agents a question.

```json
// Request
{ "question": "What patterns do you see in the last hour?" }

// Response
{ "responses": [{ "agent": "CHASE", "answer": "..." }, ...] }
```

#### `POST /detective/consult/:agentId`
Ask a specific agent.

```json
// Request
{ "question": "Should we set up a checkpoint here?", "context": { "location": "..." } }
```

#### `GET /detective/export?type=all|incidents|patterns|predictions|insights|collaborations`
Export data for training/analysis.

---

## Lovable Integration

### Detective Overview Page

```jsx
// Fetch overview
const { data } = await fetch(`${API}/detective/overview`).then(r => r.json());

// Display agent cards with stats
data.agents.map(agent => (
  <AgentCard
    key={agent.id}
    icon={agent.icon}
    name={agent.name}
    role={agent.role}
    status={agent.status}
    stats={agent.stats}
  />
));
```

### PROPHET Accuracy Chart

```jsx
const { accuracyOverTime } = await fetch(`${API}/detective/prophet`).then(r => r.json());

// Use Recharts
<LineChart data={accuracyOverTime}>
  <XAxis dataKey="period" />
  <YAxis domain={[0, 100]} />
  <Line dataKey="accuracy" stroke="#3b82f6" />
</LineChart>
```

### Pattern Timeline

```jsx
const { timeline } = await fetch(`${API}/detective/pattern`).then(r => r.json());

// Timeline visualization
timeline.map(p => (
  <div key={p.id} className={p.status === 'active' ? 'border-orange-500' : 'border-gray-600'}>
    <span className="font-bold">{p.name}</span>
    <span>{p.incidentCount} linked incidents</span>
    <span className={`badge-${p.confidence.toLowerCase()}`}>{p.confidence}</span>
  </div>
));
```

### Collaboration Graph (D3 or vis.js)

```jsx
const { nodes, edges } = await fetch(`${API}/detective/collaboration/graph`).then(r => r.json());

// Force-directed graph showing agent connections
```

---

## Memory Persistence

Data persists in `detective_memory.json`:

```json
{
  "incidents": [...],
  "patterns": [...],
  "predictionHistory": [...],
  "collaborations": [...],
  "predictionStats": { "total": 45, "correct": 12, "accuracyHistory": [...] },
  "agentStats": {
    "CHASE": { "stats": {...}, "history": [...] },
    "PATTERN": {...},
    "PROPHET": {...},
    "HISTORIAN": {...}
  },
  "savedAt": "2025-01-19T..."
}
```

Server loads this on startup, saves every 60 seconds.
