// ============================================
// DETECTIVE BUREAU - React Components
// ============================================
// Add these to your frontend

import React, { useState, useEffect, useCallback } from 'react';

// ============================================
// AGENT STATUS SIDEBAR
// ============================================
export const AgentSidebar = ({ socket, apiBase = '' }) => {
  const [agents, setAgents] = useState([]);
  const [predictions, setPredictions] = useState({ pending: [], accuracy: 'No data' });
  const [patterns, setPatterns] = useState([]);
  const [insights, setInsights] = useState([]);
  const [expanded, setExpanded] = useState(true);

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [agentsRes, predsRes, patternsRes] = await Promise.all([
          fetch(`${apiBase}/detective/agents`).then(r => r.json()),
          fetch(`${apiBase}/detective/predictions`).then(r => r.json()),
          fetch(`${apiBase}/detective/patterns`).then(r => r.json())
        ]);
        setAgents(agentsRes);
        setPredictions(predsRes);
        setPatterns(patternsRes.active || []);
      } catch (err) {
        console.error('Failed to fetch agent data:', err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [apiBase]);

  // Listen for real-time agent insights
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'agent_insight') {
        setInsights(prev => [data, ...prev].slice(0, 20));
        
        // Update agent status
        setAgents(prev => prev.map(a => 
          a.name === data.agent 
            ? { ...a, status: 'active', lastInsight: data.timestamp }
            : a
        ));
      }
      
      if (data.type === 'pattern_alert' || data.type === 'pattern_detected') {
        setPatterns(prev => [data.pattern, ...prev].slice(0, 10));
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket]);

  const getStatusColor = (status) => {
    switch (status) {
      case 'active': return '#00ff88';
      case 'analyzing': return '#00d4ff';
      case 'predicting': return '#ff6b00';
      case 'monitoring': return '#666';
      default: return '#444';
    }
  };

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'critical': return '#ff0040';
      case 'high': return '#ff6b00';
      case 'medium': return '#ffd000';
      default: return '#00d4ff';
    }
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header} onClick={() => setExpanded(!expanded)}>
        <div style={styles.headerTitle}>
          <span style={styles.headerIcon}>🔍</span>
          <span>DETECTIVE BUREAU</span>
        </div>
        <div style={styles.headerStats}>
          <span style={styles.accuracyBadge}>
            {predictions.accuracy}
          </span>
        </div>
      </div>

      {expanded && (
        <>
          {/* Agent Cards */}
          <div style={styles.agentList}>
            {agents.map(agent => (
              <div 
                key={agent.id} 
                style={{
                  ...styles.agentCard,
                  borderLeftColor: getStatusColor(agent.status)
                }}
              >
                <div style={styles.agentHeader}>
                  <span style={styles.agentIcon}>{agent.icon}</span>
                  <div style={styles.agentInfo}>
                    <span style={styles.agentName}>{agent.name}</span>
                    <span style={styles.agentRole}>{agent.role}</span>
                  </div>
                  <div 
                    style={{
                      ...styles.statusDot,
                      backgroundColor: getStatusColor(agent.status)
                    }}
                    title={agent.status}
                  />
                </div>
                {agent.currentCase && (
                  <div style={styles.agentActivity}>
                    Tracking Case #{agent.currentCase}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Active Patterns */}
          {patterns.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <span style={styles.sectionIcon}>⚡</span>
                ACTIVE PATTERNS
              </div>
              {patterns.slice(0, 3).map((pattern, i) => (
                <PatternCard key={i} pattern={pattern} />
              ))}
            </div>
          )}

          {/* Pending Predictions */}
          {predictions.pending?.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <span style={styles.sectionIcon}>🔮</span>
                PREDICTIONS
              </div>
              {predictions.pending.slice(0, 4).map((pred, i) => (
                <PredictionCard key={i} prediction={pred} />
              ))}
            </div>
          )}

          {/* Recent Insights */}
          {insights.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <span style={styles.sectionIcon}>💬</span>
                RECENT INSIGHTS
              </div>
              <div style={styles.insightList}>
                {insights.slice(0, 5).map((insight, i) => (
                  <div 
                    key={i} 
                    style={{
                      ...styles.insightItem,
                      borderLeftColor: getUrgencyColor(insight.urgency)
                    }}
                  >
                    <span style={styles.insightAgent}>
                      {insight.agentIcon} {insight.agent}
                    </span>
                    <p style={styles.insightText}>
                      {insight.analysis?.substring(0, 120)}...
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ============================================
// PATTERN CARD
// ============================================
const PatternCard = ({ pattern }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={styles.patternCard} onClick={() => setExpanded(!expanded)}>
      <div style={styles.patternHeader}>
        <span style={styles.patternName}>{pattern.patternName}</span>
        <span style={styles.patternConfidence}>
          {pattern.prediction?.confidence 
            ? `${(pattern.prediction.confidence * 100).toFixed(0)}%`
            : 'Analyzing'
          }
        </span>
      </div>
      <div style={styles.patternMeta}>
        {pattern.involvedIncidents?.length || 0} linked incidents
      </div>
      {expanded && (
        <div style={styles.patternDetails}>
          <p style={styles.patternAnalysis}>{pattern.analysis}</p>
          {pattern.connections && (
            <div style={styles.patternConnections}>
              {pattern.connections.map((c, i) => (
                <span key={i} style={styles.connectionTag}>{c}</span>
              ))}
            </div>
          )}
          {pattern.prediction && (
            <div style={styles.patternPrediction}>
              <strong>Next:</strong> {pattern.prediction.location} ({pattern.prediction.timeWindow})
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================
// PREDICTION CARD
// ============================================
const PredictionCard = ({ prediction }) => {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const updateTime = () => {
      const expires = new Date(prediction.expiresAt);
      const now = new Date();
      const diff = expires - now;
      
      if (diff <= 0) {
        setTimeLeft('EXPIRED');
        return;
      }
      
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      
      setTimeLeft(hours > 0 ? `${hours}h ${mins}m` : `${mins}m`);
    };

    updateTime();
    const interval = setInterval(updateTime, 60000);
    return () => clearInterval(interval);
  }, [prediction.expiresAt]);

  const confidenceColor = prediction.confidence > 0.7 
    ? '#00ff88' 
    : prediction.confidence > 0.4 
      ? '#ffd000' 
      : '#666';

  return (
    <div style={styles.predictionCard}>
      <div style={styles.predictionHeader}>
        <span style={styles.predictionLocation}>{prediction.location}</span>
        <span 
          style={{
            ...styles.predictionConfidence,
            color: confidenceColor
          }}
        >
          {(prediction.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div style={styles.predictionMeta}>
        <span style={styles.predictionType}>{prediction.incidentType}</span>
        <span style={styles.predictionTime}>
          {timeLeft === 'EXPIRED' ? (
            <span style={{ color: '#ff0040' }}>EXPIRED</span>
          ) : (
            <>⏱ {timeLeft}</>
          )}
        </span>
      </div>
    </div>
  );
};

// ============================================
// INSIGHT TICKER (Bottom Bar)
// ============================================
export const InsightTicker = ({ socket }) => {
  const [insights, setInsights] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'agent_insight') {
        setInsights(prev => [data, ...prev].slice(0, 20));
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket]);

  // Auto-rotate through insights
  useEffect(() => {
    if (insights.length <= 1) return;
    
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % insights.length);
    }, 8000);
    
    return () => clearInterval(interval);
  }, [insights.length]);

  if (insights.length === 0) return null;

  const current = insights[currentIndex];
  
  const getUrgencyStyle = (urgency) => {
    switch (urgency) {
      case 'critical': return { bg: 'rgba(255, 0, 64, 0.2)', border: '#ff0040' };
      case 'high': return { bg: 'rgba(255, 107, 0, 0.2)', border: '#ff6b00' };
      case 'medium': return { bg: 'rgba(255, 208, 0, 0.1)', border: '#ffd000' };
      default: return { bg: 'rgba(0, 212, 255, 0.1)', border: '#00d4ff' };
    }
  };

  const urgencyStyle = getUrgencyStyle(current.urgency);

  return (
    <div 
      style={{
        ...styles.ticker,
        backgroundColor: urgencyStyle.bg,
        borderColor: urgencyStyle.border
      }}
    >
      <div style={styles.tickerAgent}>
        <span style={styles.tickerIcon}>{current.agentIcon}</span>
        <span style={styles.tickerName}>{current.agent}</span>
      </div>
      <div style={styles.tickerContent}>
        {current.analysis?.substring(0, 200)}
        {current.analysis?.length > 200 && '...'}
      </div>
      <div style={styles.tickerMeta}>
        <span style={styles.tickerCount}>
          {currentIndex + 1}/{insights.length}
        </span>
      </div>
    </div>
  );
};

// ============================================
// PREDICTION HEATMAP OVERLAY (for Mapbox/Leaflet)
// ============================================
export const usePredictionOverlay = (map, predictions) => {
  useEffect(() => {
    if (!map || !predictions?.pending) return;

    // This assumes Mapbox GL - adjust for your map library
    const sourceId = 'prediction-zones';
    const layerId = 'prediction-heat';

    // Convert predictions to GeoJSON
    const geojson = {
      type: 'FeatureCollection',
      features: predictions.pending
        .filter(p => p.lat && p.lng)
        .map(pred => ({
          type: 'Feature',
          properties: {
            confidence: pred.confidence,
            type: pred.incidentType,
            location: pred.location
          },
          geometry: {
            type: 'Point',
            coordinates: [pred.lng, pred.lat]
          }
        }))
    };

    // Add or update source
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData(geojson);
    } else {
      map.addSource(sourceId, { type: 'geojson', data: geojson });
      
      // Add heatmap layer
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'confidence'],
            0.3, 20,
            0.7, 40,
            1.0, 60
          ],
          'circle-color': [
            'interpolate', ['linear'], ['get', 'confidence'],
            0.3, 'rgba(255, 208, 0, 0.3)',
            0.7, 'rgba(255, 107, 0, 0.4)',
            1.0, 'rgba(255, 0, 64, 0.5)'
          ],
          'circle-blur': 0.8,
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'interpolate', ['linear'], ['get', 'confidence'],
            0.3, '#ffd000',
            0.7, '#ff6b00',
            1.0, '#ff0040'
          ]
        }
      });
    }

    return () => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
  }, [map, predictions]);
};

// ============================================
// BRIEFING MODAL
// ============================================
export const BriefingModal = ({ isOpen, onClose, apiBase = '' }) => {
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/detective/briefing`);
      const data = await res.json();
      setBriefing(data);
    } catch (err) {
      console.error('Failed to fetch briefing:', err);
    }
    setLoading(false);
  }, [apiBase]);

  useEffect(() => {
    if (isOpen) fetchBriefing();
  }, [isOpen, fetchBriefing]);

  if (!isOpen) return null;

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h2 style={styles.modalTitle}>
            📋 DETECTIVE BUREAU BRIEFING
          </h2>
          <button style={styles.closeButton} onClick={onClose}>×</button>
        </div>
        
        {loading ? (
          <div style={styles.loading}>Generating briefing...</div>
        ) : briefing ? (
          <div style={styles.modalContent}>
            {/* Stats Bar */}
            <div style={styles.statsBar}>
              <div style={styles.stat}>
                <span style={styles.statValue}>{briefing.stats?.incidentsLastHour || 0}</span>
                <span style={styles.statLabel}>Last Hour</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statValue}>{briefing.stats?.activePatterns || 0}</span>
                <span style={styles.statLabel}>Patterns</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statValue}>{briefing.stats?.pendingPredictions || 0}</span>
                <span style={styles.statLabel}>Predictions</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statValue}>{briefing.stats?.predictionAccuracy || 'N/A'}</span>
                <span style={styles.statLabel}>Accuracy</span>
              </div>
            </div>

            {/* Agent Status */}
            <div style={styles.agentStatusBar}>
              {briefing.agents?.map(agent => (
                <div key={agent.name} style={styles.agentStatusItem}>
                  <span>{agent.icon}</span>
                  <span style={{
                    color: agent.status === 'active' ? '#00ff88' : '#666'
                  }}>
                    {agent.name}
                  </span>
                </div>
              ))}
            </div>

            {/* Briefing Text */}
            <div style={styles.briefingText}>
              {briefing.briefing?.split('\n').map((line, i) => (
                <p key={i} style={styles.briefingLine}>{line}</p>
              ))}
            </div>

            {/* Timestamp */}
            <div style={styles.timestamp}>
              Generated: {new Date(briefing.timestamp).toLocaleString()}
            </div>
          </div>
        ) : (
          <div style={styles.error}>Failed to load briefing</div>
        )}
      </div>
    </div>
  );
};

// ============================================
// STYLES
// ============================================
const styles = {
  // Container
  container: {
    backgroundColor: 'rgba(10, 15, 20, 0.95)',
    border: '1px solid #1a2a3a',
    borderRadius: '8px',
    overflow: 'hidden',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '12px',
    color: '#e0e0e0',
  },

  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderBottom: '1px solid #1a2a3a',
    cursor: 'pointer',
  },
  headerTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontWeight: '600',
    color: '#00d4ff',
    fontSize: '13px',
  },
  headerIcon: {
    fontSize: '16px',
  },
  headerStats: {
    display: 'flex',
    gap: '8px',
  },
  accuracyBadge: {
    backgroundColor: 'rgba(0, 255, 136, 0.2)',
    color: '#00ff88',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
  },

  // Agent List
  agentList: {
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  agentCard: {
    backgroundColor: 'rgba(20, 30, 40, 0.8)',
    borderLeft: '3px solid #444',
    borderRadius: '4px',
    padding: '10px 12px',
    transition: 'all 0.2s ease',
  },
  agentHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  agentIcon: {
    fontSize: '20px',
  },
  agentInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  agentName: {
    fontWeight: '600',
    color: '#fff',
  },
  agentRole: {
    fontSize: '10px',
    color: '#666',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    boxShadow: '0 0 8px currentColor',
  },
  agentActivity: {
    marginTop: '6px',
    fontSize: '10px',
    color: '#ff6b00',
    paddingLeft: '30px',
  },

  // Sections
  section: {
    padding: '8px 12px',
    borderTop: '1px solid #1a2a3a',
  },
  sectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '10px',
    fontWeight: '600',
    color: '#666',
    marginBottom: '8px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  sectionIcon: {
    fontSize: '12px',
  },

  // Pattern Card
  patternCard: {
    backgroundColor: 'rgba(255, 107, 0, 0.1)',
    border: '1px solid rgba(255, 107, 0, 0.3)',
    borderRadius: '4px',
    padding: '10px',
    marginBottom: '6px',
    cursor: 'pointer',
  },
  patternHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  patternName: {
    fontWeight: '600',
    color: '#ff6b00',
  },
  patternConfidence: {
    fontSize: '11px',
    color: '#00ff88',
  },
  patternMeta: {
    fontSize: '10px',
    color: '#666',
    marginTop: '4px',
  },
  patternDetails: {
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid rgba(255, 107, 0, 0.2)',
  },
  patternAnalysis: {
    margin: 0,
    fontSize: '11px',
    color: '#999',
    lineHeight: '1.4',
  },
  patternConnections: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginTop: '8px',
  },
  connectionTag: {
    backgroundColor: 'rgba(0, 212, 255, 0.2)',
    color: '#00d4ff',
    padding: '2px 6px',
    borderRadius: '3px',
    fontSize: '10px',
  },
  patternPrediction: {
    marginTop: '8px',
    fontSize: '11px',
    color: '#ffd000',
  },

  // Prediction Card
  predictionCard: {
    backgroundColor: 'rgba(138, 43, 226, 0.1)',
    border: '1px solid rgba(138, 43, 226, 0.3)',
    borderRadius: '4px',
    padding: '8px 10px',
    marginBottom: '6px',
  },
  predictionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  predictionLocation: {
    fontWeight: '500',
    color: '#e0e0e0',
    fontSize: '11px',
  },
  predictionConfidence: {
    fontWeight: '600',
    fontSize: '12px',
  },
  predictionMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: '4px',
  },
  predictionType: {
    fontSize: '10px',
    color: '#666',
  },
  predictionTime: {
    fontSize: '10px',
    color: '#00d4ff',
  },

  // Insight List
  insightList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  insightItem: {
    backgroundColor: 'rgba(20, 30, 40, 0.6)',
    borderLeft: '2px solid #00d4ff',
    padding: '8px 10px',
    borderRadius: '0 4px 4px 0',
  },
  insightAgent: {
    fontSize: '10px',
    fontWeight: '600',
    color: '#00d4ff',
    marginBottom: '4px',
    display: 'block',
  },
  insightText: {
    margin: 0,
    fontSize: '11px',
    color: '#999',
    lineHeight: '1.3',
  },

  // Ticker
  ticker: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 16px',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderTop: '1px solid #00d4ff',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '12px',
  },
  tickerAgent: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  },
  tickerIcon: {
    fontSize: '16px',
  },
  tickerName: {
    fontWeight: '600',
    color: '#00d4ff',
  },
  tickerContent: {
    flex: 1,
    color: '#ccc',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tickerMeta: {
    flexShrink: 0,
  },
  tickerCount: {
    fontSize: '10px',
    color: '#666',
  },

  // Modal
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(4px)',
  },
  modal: {
    backgroundColor: '#0a0f14',
    border: '1px solid #1a2a3a',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '700px',
    maxHeight: '80vh',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderBottom: '1px solid #1a2a3a',
  },
  modalTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: '600',
    color: '#00d4ff',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#666',
    fontSize: '24px',
    cursor: 'pointer',
    padding: '0',
    lineHeight: 1,
  },
  modalContent: {
    padding: '20px',
    overflowY: 'auto',
  },
  statsBar: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '16px',
    backgroundColor: 'rgba(20, 30, 40, 0.6)',
    borderRadius: '8px',
    marginBottom: '16px',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  statValue: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#00d4ff',
  },
  statLabel: {
    fontSize: '10px',
    color: '#666',
    textTransform: 'uppercase',
  },
  agentStatusBar: {
    display: 'flex',
    justifyContent: 'center',
    gap: '24px',
    padding: '12px',
    marginBottom: '16px',
  },
  agentStatusItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
  },
  briefingText: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '13px',
    lineHeight: '1.6',
    color: '#ccc',
  },
  briefingLine: {
    margin: '0 0 12px 0',
  },
  timestamp: {
    marginTop: '20px',
    fontSize: '10px',
    color: '#444',
    textAlign: 'right',
  },
  loading: {
    padding: '40px',
    textAlign: 'center',
    color: '#666',
  },
  error: {
    padding: '40px',
    textAlign: 'center',
    color: '#ff0040',
  },
};

export default AgentSidebar;
