// ============================================
// USAGE EXAMPLE - Integrating Detective Bureau UI
// ============================================

import React, { useState, useEffect, useRef } from 'react';
import { 
  AgentSidebar, 
  InsightTicker, 
  BriefingModal,
  usePredictionOverlay 
} from './DetectiveBureau';

// Your API base URL
const API_BASE = 'https://dispatch-backend-production.up.railway.app';

// ============================================
// MAIN APP INTEGRATION
// ============================================
export const DispatchApp = () => {
  const [socket, setSocket] = useState(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [predictions, setPredictions] = useState(null);
  const mapRef = useRef(null);

  // Connect WebSocket
  useEffect(() => {
    const ws = new WebSocket(API_BASE.replace('https', 'wss'));
    
    ws.onopen = () => {
      console.log('Connected to Dispatch');
      setSocket(ws);
    };
    
    ws.onclose = () => {
      console.log('Disconnected from Dispatch');
      // Reconnect logic here
    };

    return () => ws.close();
  }, []);

  // Fetch predictions for map overlay
  useEffect(() => {
    const fetchPredictions = async () => {
      try {
        const res = await fetch(`${API_BASE}/detective/predictions`);
        const data = await res.json();
        setPredictions(data);
      } catch (err) {
        console.error('Failed to fetch predictions:', err);
      }
    };

    fetchPredictions();
    const interval = setInterval(fetchPredictions, 60000);
    return () => clearInterval(interval);
  }, []);

  // Apply prediction overlay to map
  usePredictionOverlay(mapRef.current, predictions);

  return (
    <div style={layoutStyles.container}>
      {/* Header */}
      <header style={layoutStyles.header}>
        <div style={layoutStyles.logo}>
          <span style={layoutStyles.logoIcon}>◉</span>
          DISPATCH NYC
        </div>
        <button 
          style={layoutStyles.briefingButton}
          onClick={() => setBriefingOpen(true)}
        >
          📋 Get Briefing
        </button>
      </header>

      {/* Main Content */}
      <div style={layoutStyles.main}>
        {/* Left Panel - Scanner Feed */}
        <div style={layoutStyles.leftPanel}>
          {/* Your existing scanner feed component */}
          <ScannerFeed socket={socket} />
        </div>

        {/* Center - Map */}
        <div style={layoutStyles.mapContainer}>
          {/* Your existing map component */}
          {/* Pass ref to enable prediction overlay */}
          <MapView ref={mapRef} socket={socket} />
        </div>

        {/* Right Panel - Detective Bureau */}
        <div style={layoutStyles.rightPanel}>
          <AgentSidebar 
            socket={socket} 
            apiBase={API_BASE} 
          />
          
          {/* Your existing incident list below */}
          <IncidentList socket={socket} />
        </div>
      </div>

      {/* Bottom Ticker */}
      <InsightTicker socket={socket} />

      {/* Briefing Modal */}
      <BriefingModal 
        isOpen={briefingOpen}
        onClose={() => setBriefingOpen(false)}
        apiBase={API_BASE}
      />
    </div>
  );
};

// ============================================
// ALTERNATIVE: Replace your existing Claude panel
// ============================================

// If you want to replace your existing "CLAUDE DETECTIVE" panel 
// with the new multi-agent system, here's how:

export const EnhancedDetectivePanel = ({ socket, apiBase }) => {
  const [activeTab, setActiveTab] = useState('agents');
  const [askInput, setAskInput] = useState('');
  const [conversation, setConversation] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleAsk = async () => {
    if (!askInput.trim() || loading) return;
    
    const question = askInput;
    setAskInput('');
    setLoading(true);
    
    // Add user message
    setConversation(prev => [...prev, { 
      role: 'user', 
      content: question 
    }]);

    try {
      const res = await fetch(`${apiBase}/detective/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      
      const data = await res.json();
      
      setConversation(prev => [...prev, {
        role: 'agent',
        agent: data.agent,
        agentIcon: data.agentIcon,
        content: data.answer
      }]);
    } catch (err) {
      setConversation(prev => [...prev, {
        role: 'error',
        content: 'Failed to get response'
      }]);
    }
    
    setLoading(false);
  };

  return (
    <div style={panelStyles.container}>
      {/* Header with tabs */}
      <div style={panelStyles.header}>
        <div style={panelStyles.title}>
          <span style={panelStyles.icon}>🔍</span>
          DETECTIVE BUREAU
        </div>
        <div style={panelStyles.tabs}>
          <button 
            style={{
              ...panelStyles.tab,
              ...(activeTab === 'agents' ? panelStyles.activeTab : {})
            }}
            onClick={() => setActiveTab('agents')}
          >
            Agents
          </button>
          <button 
            style={{
              ...panelStyles.tab,
              ...(activeTab === 'chat' ? panelStyles.activeTab : {})
            }}
            onClick={() => setActiveTab('chat')}
          >
            Ask
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={panelStyles.content}>
        {activeTab === 'agents' ? (
          <AgentSidebar socket={socket} apiBase={apiBase} />
        ) : (
          <div style={panelStyles.chatContainer}>
            {/* Conversation */}
            <div style={panelStyles.messages}>
              {conversation.map((msg, i) => (
                <div 
                  key={i}
                  style={{
                    ...panelStyles.message,
                    ...(msg.role === 'user' ? panelStyles.userMessage : panelStyles.agentMessage)
                  }}
                >
                  {msg.role === 'agent' && (
                    <div style={panelStyles.agentHeader}>
                      <span>{msg.agentIcon}</span>
                      <span style={panelStyles.agentName}>{msg.agent}</span>
                    </div>
                  )}
                  <p style={panelStyles.messageText}>{msg.content}</p>
                </div>
              ))}
              {loading && (
                <div style={panelStyles.loading}>
                  Agents analyzing...
                </div>
              )}
            </div>

            {/* Input */}
            <div style={panelStyles.inputContainer}>
              <input
                style={panelStyles.input}
                value={askInput}
                onChange={e => setAskInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAsk()}
                placeholder="Ask the detectives..."
              />
              <button 
                style={panelStyles.sendButton}
                onClick={handleAsk}
                disabled={loading}
              >
                ➤
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================
// LAYOUT STYLES
// ============================================
const layoutStyles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#0a0f14',
    color: '#e0e0e0',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
    backgroundColor: 'rgba(10, 15, 20, 0.95)',
    borderBottom: '1px solid #1a2a3a',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '18px',
    fontWeight: '700',
    color: '#ff0040',
  },
  logoIcon: {
    fontSize: '24px',
  },
  briefingButton: {
    background: 'rgba(0, 212, 255, 0.2)',
    border: '1px solid #00d4ff',
    color: '#00d4ff',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '500',
  },
  main: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPanel: {
    width: '350px',
    borderRight: '1px solid #1a2a3a',
    overflow: 'auto',
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  rightPanel: {
    width: '380px',
    borderLeft: '1px solid #1a2a3a',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
};

const panelStyles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: 'rgba(10, 15, 20, 0.95)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #1a2a3a',
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontWeight: '600',
    color: '#00d4ff',
  },
  icon: {
    fontSize: '20px',
  },
  tabs: {
    display: 'flex',
    gap: '4px',
  },
  tab: {
    background: 'none',
    border: '1px solid transparent',
    color: '#666',
    padding: '4px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  activeTab: {
    borderColor: '#00d4ff',
    color: '#00d4ff',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
  },
  content: {
    flex: 1,
    overflow: 'auto',
  },
  chatContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  messages: {
    flex: 1,
    overflow: 'auto',
    padding: '12px',
  },
  message: {
    marginBottom: '12px',
    padding: '10px 12px',
    borderRadius: '8px',
  },
  userMessage: {
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    borderLeft: '3px solid #00d4ff',
    marginLeft: '20px',
  },
  agentMessage: {
    backgroundColor: 'rgba(20, 30, 40, 0.8)',
    borderLeft: '3px solid #00ff88',
    marginRight: '20px',
  },
  agentHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '6px',
  },
  agentName: {
    fontWeight: '600',
    color: '#00ff88',
    fontSize: '12px',
  },
  messageText: {
    margin: 0,
    fontSize: '13px',
    lineHeight: '1.5',
    color: '#ccc',
  },
  loading: {
    textAlign: 'center',
    color: '#666',
    padding: '20px',
  },
  inputContainer: {
    display: 'flex',
    gap: '8px',
    padding: '12px',
    borderTop: '1px solid #1a2a3a',
  },
  input: {
    flex: 1,
    backgroundColor: 'rgba(20, 30, 40, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '6px',
    padding: '10px 12px',
    color: '#e0e0e0',
    fontSize: '13px',
    outline: 'none',
  },
  sendButton: {
    backgroundColor: '#00d4ff',
    border: 'none',
    borderRadius: '6px',
    padding: '10px 16px',
    color: '#000',
    cursor: 'pointer',
    fontSize: '16px',
  },
};

// Placeholder components (replace with your actual implementations)
const ScannerFeed = ({ socket }) => <div>Scanner Feed</div>;
const MapView = React.forwardRef((props, ref) => <div ref={ref}>Map</div>);
const IncidentList = ({ socket }) => <div>Incidents</div>;

export default DispatchApp;
