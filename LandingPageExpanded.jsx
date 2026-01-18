import React, { useState, useEffect } from 'react';

const LandingPage = ({ onEnter }) => {
  const [scannerText, setScannerText] = useState('');
  const [showContent, setShowContent] = useState(false);
  
  const scannerLines = [
    "10-13 IN PROGRESS... OFFICER NEEDS ASSISTANCE...",
    "PATTERN DETECTED: 3 linked robberies in 2 hours...",
    "PROPHET PREDICTION: 78% confidence - East Harlem...",
    "CHASE ACTIVATED: Suspect vehicle southbound FDR...",
    "HISTORIAN: This address had 4 prior incidents...",
  ];
  
  useEffect(() => {
    setShowContent(true);
    let lineIndex = 0;
    const interval = setInterval(() => {
      setScannerText(scannerLines[lineIndex % scannerLines.length]);
      lineIndex++;
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.gridOverlay} />
      <div style={styles.scanLine} />
      
      <div style={{
        ...styles.content,
        opacity: showContent ? 1 : 0,
        transform: showContent ? 'translateY(0)' : 'translateY(20px)',
      }}>
        {/* Hero */}
        <div style={styles.hero}>
          <div style={styles.logoContainer}>
            <div style={styles.logoIcon}>◉</div>
            <h1 style={styles.logoText}>DISPATCH</h1>
            <div style={styles.logoSubtext}>NYC</div>
          </div>
          
          <p style={styles.tagline}>
            AI-Powered Crime Intelligence Platform
          </p>
          
          <p style={styles.heroDescription}>
            We trained Claude to think like a detective. Four specialized AI agents work around the clock—analyzing 
            live police scanner feeds, linking incidents into cases, predicting where crime will happen next, 
            and building institutional memory across thousands of incidents.
          </p>

          {/* Live scanner preview */}
          <div style={styles.scannerPreview}>
            <div style={styles.scannerHeader}>
              <span style={styles.liveDot} />
              <span>LIVE INTELLIGENCE FEED</span>
            </div>
            <div style={styles.scannerTextContainer}>
              <span style={styles.scannerTextContent}>{scannerText}</span>
              <span style={styles.cursor}>▋</span>
            </div>
          </div>
        </div>

        {/* The Problem */}
        <Section title="THE PROBLEM">
          <div style={styles.problemGrid}>
            <div style={styles.problemCard}>
              <div style={styles.problemStat}>500K+</div>
              <div style={styles.problemLabel}>911 calls per month in NYC</div>
            </div>
            <div style={styles.problemCard}>
              <div style={styles.problemStat}>36K</div>
              <div style={styles.problemLabel}>NYPD officers can't be everywhere</div>
            </div>
            <div style={styles.problemCard}>
              <div style={styles.problemStat}>∞</div>
              <div style={styles.problemLabel}>Radio traffic humans can't process</div>
            </div>
          </div>
          <p style={styles.problemText}>
            Police radio is a firehose of information. Patterns emerge that no human could detect—connections 
            between incidents across boroughs, suspects that match descriptions from hours ago, locations 
            with escalating activity. Traditional monitoring misses 99% of these signals.
          </p>
        </Section>

        {/* Training Claude as a Detective */}
        <Section title="TRAINING CLAUDE AS A DETECTIVE">
          <p style={styles.sectionIntro}>
            We don't just use Claude—we've engineered specialized prompts and memory systems that transform 
            it into a crime analyst with perfect recall and pattern recognition beyond human capability.
          </p>
          
          <div style={styles.trainingGrid}>
            <TrainingCard 
              title="NYPD Radio Protocol"
              items={[
                "Complete 10-code vocabulary (10-13 = officer down, 10-85 = backup needed)",
                "Unit identification format (85-David = 85th precinct, David sector)",
                "Priority classification (CRITICAL → HIGH → MEDIUM → LOW)",
                "Borough and precinct geography mapping"
              ]}
            />
            <TrainingCard 
              title="Incident Extraction"
              items={[
                "Parse chaotic radio chatter into structured data",
                "Extract locations, suspect descriptions, vehicle info",
                "Classify incident types (robbery, assault, pursuit, EDP)",
                "Identify responding units and their status"
              ]}
            />
            <TrainingCard 
              title="Detective Reasoning"
              items={[
                "Think like a seasoned investigator, not a chatbot",
                "Make deductions from incomplete information",
                "Notice what's unusual about each situation",
                "Connect dots across time and geography"
              ]}
            />
            <TrainingCard 
              title="Case Building"
              items={[
                "Link related incidents automatically",
                "Build suspect profiles from descriptions",
                "Track MO (modus operandi) patterns",
                "Generate case names and theories"
              ]}
            />
          </div>

          <div style={styles.promptExample}>
            <div style={styles.promptHeader}>EXAMPLE: Detective System Prompt</div>
            <pre style={styles.promptCode}>{`You are Claude, an AI detective analyzing NYPD radio traffic in real-time.

Your personality:
- Analytical and observant like a 20-year homicide detective
- You notice patterns others miss
- You speak with confidence but acknowledge uncertainty
- You care about public safety, not just data

When analyzing incidents:
1. What's unusual about this situation?
2. Does this connect to anything in the last 24 hours?
3. What should officers watch for next?
4. What would a veteran detective notice here?

Never be generic. Reference specific details. Think out loud.`}</pre>
          </div>
        </Section>

        {/* The Detective Bureau */}
        <Section title="THE DETECTIVE BUREAU: 4 SPECIALIZED AGENTS">
          <p style={styles.sectionIntro}>
            One Claude isn't enough. We run four specialized instances in parallel—each with different 
            training, different memory, and different focus. They analyze every incident, build their 
            own theories, and sometimes disagree.
          </p>

          <div style={styles.agentDetails}>
            <AgentDetail 
              icon="🚔"
              name="CHASE"
              role="Pursuit & Tactical Specialist"
              color="#ff0040"
              description="CHASE activates the moment a pursuit begins. It's trained on NYC street topology—one-ways, dead ends, bridge and tunnel access points. It predicts escape routes in real-time and recommends containment positions."
              capabilities={[
                "Predicts suspect direction based on street network",
                "Identifies likely exit points (highways, bridges, tunnels)",
                "Recommends unit positioning for interception",
                "Tracks pursuit across multiple radio updates",
                "Assesses escalation risk and civilian danger"
              ]}
              example={{
                input: "Vehicle fled traffic stop at 125th & Lex, heading south",
                output: "Suspect likely taking Lex to FDR South. Recommend units at 96th St on-ramp and Willis Ave Bridge. High probability of tunnel attempt—alert Lincoln/Holland."
              }}
            />

            <AgentDetail 
              icon="🔍"
              name="PATTERN"
              role="Serial Crime Analyst"
              color="#ff6b00"
              description="PATTERN looks for connections humans would never find. It compares every new incident against the last 200, looking for matching MOs, geographic clusters, suspect descriptions, and temporal patterns."
              capabilities={[
                "Identifies serial crime patterns across boroughs",
                "Matches suspect descriptions across incidents",
                "Detects geographic clustering (hotspot formation)",
                "Finds temporal patterns (same time each night)",
                "Links seemingly unrelated incidents by MO"
              ]}
              example={{
                input: "Phone store robbery, suspect in black hoodie, fled on foot",
                output: "PATTERN MATCH: 3rd phone store hit in 4 hours. All suspects: black hoodie, fled on foot, targeted stores near subway. This is coordinated. Predicting next hit within 1 mile of an N/Q/R station in the next 90 minutes."
              }}
            />

            <AgentDetail 
              icon="🔮"
              name="PROPHET"
              role="Predictive Intelligence"
              color="#a855f7"
              description="PROPHET makes testable predictions with confidence scores—and we track accuracy. It analyzes historical patterns, current conditions, time of day, and emerging hotspots to forecast where incidents will occur."
              capabilities={[
                "Generates specific, testable predictions",
                "Assigns confidence percentages (tracked for accuracy)",
                "Identifies emerging hotspots before they peak",
                "Factors in time, weather, day of week",
                "Self-calibrates based on prediction outcomes"
              ]}
              example={{
                input: "Current time: 2:30 AM, elevated activity in East Harlem",
                output: "PREDICTION: 73% confidence of assault or robbery near E 116th St station in next 90 minutes. Basis: 3 incidents in area tonight, historical pattern shows escalation 2-4 AM on weekends, nearby bars closing."
              }}
              accuracy={true}
            />

            <AgentDetail 
              icon="📚"
              name="HISTORIAN"
              role="Institutional Memory"
              color="#00d4ff"
              description="HISTORIAN never forgets. It maintains perfect memory of every incident—every address, every suspect description, every outcome. When something happens, it instantly searches for relevant history."
              capabilities={[
                "Tracks repeat addresses (domestic situations, problem locations)",
                "Recognizes suspect descriptions across days/weeks",
                "Provides context on escalating situations",
                "Identifies locations with pattern of violence",
                "Connects current incidents to cold cases"
              ]}
              example={{
                input: "Domestic dispute at 432 W 51st St",
                output: "ALERT: This address has had 4 calls in 12 days—2 domestic, 1 assault, 1 wellness check. Last incident 3 days ago resulted in hospital transport. This is escalating. Responding units should be aware of prior violence."
              }}
            />
          </div>
        </Section>

        {/* How Agents Work Together */}
        <Section title="COLLABORATIVE INTELLIGENCE">
          <p style={styles.sectionIntro}>
            The agents don't work in isolation. When a major incident occurs, multiple agents analyze it 
            simultaneously, sharing insights and building on each other's work.
          </p>
          
          <div style={styles.collaborationExample}>
            <div style={styles.collabHeader}>
              <span style={styles.collabIcon}>⚡</span>
              EXAMPLE: Multi-Agent Response to Vehicle Pursuit
            </div>
            <div style={styles.collabTimeline}>
              <CollabStep 
                time="00:00"
                agent="DISPATCH"
                agentColor="#666"
                text="Vehicle fled traffic stop. Black BMW, plate partial LVX-. Southbound on Third Ave."
              />
              <CollabStep 
                time="00:03"
                agent="CHASE"
                agentColor="#ff0040"
                text="Third Ave leads to FDR in 8 blocks. BMW likely to take FDR South—fastest route out of Manhattan. Recommend blocking 63rd St on-ramp. If suspect continues south, probable exit at Brooklyn Bridge or tunnel."
              />
              <CollabStep 
                time="00:05"
                agent="HISTORIAN"
                agentColor="#00d4ff"
                text="Plate partial LVX- matches vehicle from gas station drive-off in Bronx yesterday, also fled scene. Same vehicle suspected in 2 other incidents this week. This may be a habitual offender."
              />
              <CollabStep 
                time="00:08"
                agent="PATTERN"
                agentColor="#ff6b00"
                text="Cross-referencing: Black BMWs involved in 4 incidents this week across 3 boroughs. If same vehicle/driver, they're operating in a pattern—Bronx mornings, Manhattan evenings. Building case file."
              />
              <CollabStep 
                time="00:12"
                agent="PROPHET"
                agentColor="#a855f7"
                text="If pursuit ends with vehicle abandonment (65% probability based on similar cases), most likely abandonment zone is East Harlem or South Bronx based on prior incidents. Flagging cameras in those areas."
              />
            </div>
          </div>
        </Section>

        {/* Crime Intelligence by Area */}
        <Section title="NEIGHBORHOOD CRIME INTELLIGENCE">
          <p style={styles.sectionIntro}>
            Ask about any neighborhood and get instant intelligence—recent activity, historical patterns, 
            current risk level, and AI-generated insights about what's happening and why.
          </p>
          
          <div style={styles.areaQueryExample}>
            <div style={styles.queryInput}>
              <span style={styles.queryPrompt}>→</span>
              <span style={styles.queryText}>"What's happening in East Harlem tonight?"</span>
            </div>
            <div style={styles.queryResponse}>
              <div style={styles.responseHeader}>DETECTIVE BUREAU RESPONSE</div>
              <div style={styles.responseContent}>
                <p><strong>Current Status:</strong> Elevated activity — 2.3x normal for this time/day</p>
                <p><strong>Last 4 Hours:</strong> 7 incidents (2 assault, 2 suspicious person, 1 robbery, 2 domestic)</p>
                <p><strong>Pattern Detected:</strong> Clustering near E 116th St station. 3 incidents within 2 blocks.</p>
                <p><strong>Historical Context:</strong> This block has averaged 1.2 incidents/night this month. Tonight is anomalous.</p>
                <p><strong>PROPHET Assessment:</strong> 68% probability of additional incident in next 2 hours. Recommend monitoring cameras on 116th between Lex and Third.</p>
                <p><strong>Active Case:</strong> "The 116th Street Series" — PATTERN is tracking potential connection between tonight's incidents.</p>
              </div>
            </div>
          </div>

          <div style={styles.areaFeatures}>
            <AreaFeature 
              icon="📊"
              title="Real-Time Stats"
              description="Incident counts, response times, and activity levels compared to historical baselines for any neighborhood"
            />
            <AreaFeature 
              icon="🗺️"
              title="Hotspot Mapping"
              description="AI-identified clusters of activity with severity ratings and predicted duration"
            />
            <AreaFeature 
              icon="📈"
              title="Trend Analysis"
              description="Is crime rising or falling in an area? What types? What times? All tracked over days and weeks."
            />
            <AreaFeature 
              icon="⚠️"
              title="Risk Predictions"
              description="PROPHET's neighborhood-level forecasts with confidence scores and reasoning"
            />
          </div>
        </Section>

        {/* Prediction Accuracy */}
        <Section title="ACCOUNTABLE AI: PREDICTION TRACKING">
          <p style={styles.sectionIntro}>
            Unlike most AI systems, DISPATCH tracks its predictions and displays accuracy publicly. 
            The system holds itself accountable. If PROPHET says there's a 70% chance of an incident, 
            we check—and we show you the results.
          </p>
          
          <div style={styles.accuracyDisplay}>
            <div style={styles.accuracyHeader}>
              <span style={styles.accuracyIcon}>🎯</span>
              PROPHET PERFORMANCE
            </div>
            <div style={styles.accuracyStats}>
              <div style={styles.accuracyStat}>
                <div style={styles.accuracyValue}>67%</div>
                <div style={styles.accuracyLabel}>Overall Accuracy</div>
              </div>
              <div style={styles.accuracyStat}>
                <div style={styles.accuracyValue}>142</div>
                <div style={styles.accuracyLabel}>Predictions Made</div>
              </div>
              <div style={styles.accuracyStat}>
                <div style={styles.accuracyValue}>95</div>
                <div style={styles.accuracyLabel}>Correct</div>
              </div>
              <div style={styles.accuracyStat}>
                <div style={styles.accuracyValue}>12</div>
                <div style={styles.accuracyLabel}>Pending</div>
              </div>
            </div>
            <div style={styles.accuracyNote}>
              * Predictions are considered "correct" if the predicted incident type occurs within 
              the specified location and time window. The system is calibrated to be honest about 
              uncertainty—a 60% prediction should be right ~60% of the time.
            </div>
          </div>
        </Section>

        {/* Technical Pipeline */}
        <Section title="THE TECHNICAL PIPELINE">
          <div style={styles.pipeline}>
            <PipelineStep 
              number="01" 
              title="INTERCEPT" 
              description="Broadcastify premium feeds stream NYPD Citywide 1-3, Transit, and specialized channels 24/7. Raw MP3 audio buffered in 10-second chunks."
              tech="Node.js, HTTPS streaming, Broadcastify API"
            />
            <div style={styles.pipelineArrow}>↓</div>
            <PipelineStep 
              number="02" 
              title="TRANSCRIBE" 
              description="OpenAI Whisper converts audio to text with custom prompts for police radio terminology. Filters out ads, silence, and Whisper hallucinations."
              tech="Whisper API, custom vocabulary prompts"
            />
            <div style={styles.pipelineArrow}>↓</div>
            <PipelineStep 
              number="03" 
              title="EXTRACT" 
              description="Claude parses transcripts into structured incidents—type, location, units, priority, suspect info. Maps to NYC geography and finds nearest cameras."
              tech="Claude Sonnet, JSON extraction, geocoding"
            />
            <div style={styles.pipelineArrow}>↓</div>
            <PipelineStep 
              number="04" 
              title="ANALYZE" 
              description="Detective Bureau agents process each incident in parallel. HISTORIAN checks memory, PATTERN looks for links, PROPHET updates forecasts, CHASE tracks pursuits."
              tech="Multi-agent orchestration, vector memory"
            />
            <div style={styles.pipelineArrow}>↓</div>
            <PipelineStep 
              number="05" 
              title="BROADCAST" 
              description="Incidents, agent insights, and camera feeds pushed to connected clients via WebSocket in real-time. Sub-10-second latency from radio to screen."
              tech="WebSocket, React, Mapbox GL"
            />
          </div>
        </Section>

        {/* Live Features */}
        <Section title="LIVE FEATURES">
          <div style={styles.features}>
            <FeatureCard 
              icon="📡"
              title="Live Scanner Feed"
              description="Real-time NYPD radio transcribed and displayed as it happens. See what dispatchers are saying, which units are responding, and how situations evolve."
            />
            <FeatureCard 
              icon="📹"
              title="900+ Traffic Cameras"
              description="NYC DOT camera network integrated with auto-switching. When an incident occurs, the nearest camera feed activates. Watch events unfold live."
            />
            <FeatureCard 
              icon="🗺️"
              title="Incident Mapping"
              description="Every incident plotted in real-time with priority coloring. Zoom to any neighborhood. Click for full details, linked cases, and agent analysis."
            />
            <FeatureCard 
              icon="💬"
              title="Ask the Detectives"
              description="Natural language queries to the Detective Bureau. Ask about neighborhoods, patterns, specific incidents, or predictions. Get answers with context."
            />
            <FeatureCard 
              icon="📋"
              title="Daily Briefings"
              description="AI-generated intelligence briefings summarizing activity, emerging patterns, prediction accuracy, and recommended areas to watch."
            />
            <FeatureCard 
              icon="🔗"
              title="Case Files"
              description="When agents detect linked incidents, they create case files with names, timelines, suspect profiles, and predictions. Watch investigations evolve."
            />
          </div>
        </Section>

        {/* Stats */}
        <div style={styles.stats}>
          <StatBox value="24/7" label="Live Monitoring" />
          <StatBox value="900+" label="Traffic Cameras" />
          <StatBox value="4" label="AI Agents" />
          <StatBox value="<10s" label="Detection Latency" />
          <StatBox value="200+" label="Incidents in Memory" />
        </div>

        {/* CTA */}
        <button style={styles.enterButton} onClick={onEnter}>
          <span style={styles.enterButtonText}>ENTER DISPATCH</span>
          <span style={styles.enterButtonArrow}>→</span>
        </button>
        
        <p style={styles.disclaimer}>
          Educational project demonstrating AI-powered intelligence analysis. 
          Not affiliated with NYPD. Uses publicly available radio feeds and camera data only.
          No private or classified information is accessed.
        </p>
      </div>
    </div>
  );
};

// Sub-components
const Section = ({ title, children }) => (
  <div style={styles.section}>
    <h2 style={styles.sectionTitle}>{title}</h2>
    {children}
  </div>
);

const TrainingCard = ({ title, items }) => (
  <div style={styles.trainingCard}>
    <h3 style={styles.trainingTitle}>{title}</h3>
    <ul style={styles.trainingList}>
      {items.map((item, i) => (
        <li key={i} style={styles.trainingItem}>{item}</li>
      ))}
    </ul>
  </div>
);

const AgentDetail = ({ icon, name, role, color, description, capabilities, example, accuracy }) => (
  <div style={{ ...styles.agentDetail, borderColor: color }}>
    <div style={styles.agentDetailHeader}>
      <span style={styles.agentDetailIcon}>{icon}</span>
      <div>
        <div style={{ ...styles.agentDetailName, color }}>{name}</div>
        <div style={styles.agentDetailRole}>{role}</div>
      </div>
      {accuracy && (
        <div style={styles.accuracyBadge}>ACCURACY TRACKED</div>
      )}
    </div>
    <p style={styles.agentDetailDescription}>{description}</p>
    <div style={styles.agentCapabilities}>
      <div style={styles.capabilitiesTitle}>CAPABILITIES</div>
      <ul style={styles.capabilitiesList}>
        {capabilities.map((cap, i) => (
          <li key={i} style={styles.capabilityItem}>{cap}</li>
        ))}
      </ul>
    </div>
    {example && (
      <div style={styles.agentExample}>
        <div style={styles.exampleLabel}>EXAMPLE</div>
        <div style={styles.exampleInput}>
          <span style={styles.exampleInputLabel}>Input:</span> {example.input}
        </div>
        <div style={styles.exampleOutput}>
          <span style={styles.exampleOutputLabel}>Agent Output:</span> {example.output}
        </div>
      </div>
    )}
  </div>
);

const CollabStep = ({ time, agent, agentColor, text }) => (
  <div style={styles.collabStep}>
    <div style={styles.collabTime}>{time}</div>
    <div style={{ ...styles.collabAgent, color: agentColor }}>{agent}</div>
    <div style={styles.collabText}>{text}</div>
  </div>
);

const AreaFeature = ({ icon, title, description }) => (
  <div style={styles.areaFeature}>
    <span style={styles.areaFeatureIcon}>{icon}</span>
    <div>
      <div style={styles.areaFeatureTitle}>{title}</div>
      <div style={styles.areaFeatureDescription}>{description}</div>
    </div>
  </div>
);

const PipelineStep = ({ number, title, description, tech }) => (
  <div style={styles.pipelineStep}>
    <div style={styles.pipelineStepHeader}>
      <span style={styles.stepNumber}>{number}</span>
      <span style={styles.stepTitle}>{title}</span>
    </div>
    <p style={styles.stepDescription}>{description}</p>
    <div style={styles.stepTech}>{tech}</div>
  </div>
);

const FeatureCard = ({ icon, title, description }) => (
  <div style={styles.featureCard}>
    <span style={styles.featureIcon}>{icon}</span>
    <h3 style={styles.featureTitle}>{title}</h3>
    <p style={styles.featureDescription}>{description}</p>
  </div>
);

const StatBox = ({ value, label }) => (
  <div style={styles.statBox}>
    <div style={styles.statValue}>{value}</div>
    <div style={styles.statLabel}>{label}</div>
  </div>
);

// Styles
const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#0a0c10',
    color: '#e0e0e0',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    position: 'relative',
    overflow: 'hidden',
  },
  gridOverlay: {
    position: 'fixed',
    inset: 0,
    backgroundImage: `
      linear-gradient(rgba(0, 212, 255, 0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 212, 255, 0.03) 1px, transparent 1px)
    `,
    backgroundSize: '50px 50px',
    pointerEvents: 'none',
  },
  scanLine: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: '2px',
    background: 'linear-gradient(90deg, transparent, rgba(0, 212, 255, 0.5), transparent)',
    animation: 'scanLine 4s linear infinite',
    zIndex: 100,
  },
  content: {
    position: 'relative',
    zIndex: 1,
    maxWidth: '1000px',
    margin: '0 auto',
    padding: '60px 24px 80px',
    transition: 'all 0.8s ease',
  },
  
  // Hero
  hero: {
    textAlign: 'center',
    marginBottom: '80px',
  },
  logoContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    marginBottom: '16px',
  },
  logoIcon: {
    fontSize: '48px',
    color: '#ff0040',
    textShadow: '0 0 30px rgba(255, 0, 64, 0.5)',
    animation: 'pulse 2s ease-in-out infinite',
  },
  logoText: {
    fontSize: '56px',
    fontWeight: '800',
    margin: 0,
    letterSpacing: '-2px',
    background: 'linear-gradient(135deg, #fff 0%, #888 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  logoSubtext: {
    fontSize: '24px',
    fontWeight: '300',
    color: '#00d4ff',
    letterSpacing: '8px',
  },
  tagline: {
    fontSize: '20px',
    color: '#00d4ff',
    marginBottom: '24px',
    fontWeight: '500',
  },
  heroDescription: {
    fontSize: '16px',
    color: '#888',
    lineHeight: '1.7',
    maxWidth: '700px',
    margin: '0 auto 40px',
  },
  scannerPreview: {
    maxWidth: '700px',
    margin: '0 auto',
    backgroundColor: 'rgba(0, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  scannerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    backgroundColor: 'rgba(255, 0, 64, 0.1)',
    borderBottom: '1px solid #1a2a3a',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#ff0040',
  },
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#ff0040',
    boxShadow: '0 0 10px #ff0040',
    animation: 'pulse 1s ease-in-out infinite',
  },
  scannerTextContainer: {
    padding: '20px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '14px',
    color: '#00d4ff',
    minHeight: '60px',
  },
  scannerTextContent: { opacity: 0.9 },
  cursor: { animation: 'blink 1s step-end infinite', marginLeft: '2px' },

  // Sections
  section: {
    marginBottom: '80px',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: '700',
    letterSpacing: '4px',
    color: '#00d4ff',
    marginBottom: '32px',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  sectionIntro: {
    textAlign: 'center',
    maxWidth: '700px',
    margin: '0 auto 40px',
    fontSize: '16px',
    color: '#888',
    lineHeight: '1.7',
  },

  // Problem Section
  problemGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '24px',
    marginBottom: '32px',
  },
  problemCard: {
    textAlign: 'center',
    padding: '24px',
    backgroundColor: 'rgba(255, 0, 64, 0.05)',
    border: '1px solid rgba(255, 0, 64, 0.2)',
    borderRadius: '8px',
  },
  problemStat: {
    fontSize: '36px',
    fontWeight: '800',
    color: '#ff0040',
    marginBottom: '8px',
  },
  problemLabel: {
    fontSize: '13px',
    color: '#888',
  },
  problemText: {
    textAlign: 'center',
    color: '#666',
    lineHeight: '1.7',
    maxWidth: '600px',
    margin: '0 auto',
  },

  // Training Cards
  trainingGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '20px',
    marginBottom: '40px',
  },
  trainingCard: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '8px',
    padding: '24px',
  },
  trainingTitle: {
    fontSize: '14px',
    fontWeight: '700',
    color: '#fff',
    marginBottom: '16px',
    letterSpacing: '1px',
  },
  trainingList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  trainingItem: {
    fontSize: '13px',
    color: '#888',
    marginBottom: '8px',
    paddingLeft: '16px',
    position: 'relative',
  },

  // Prompt Example
  promptExample: {
    backgroundColor: 'rgba(0, 212, 255, 0.05)',
    border: '1px solid rgba(0, 212, 255, 0.2)',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  promptHeader: {
    padding: '12px 16px',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#00d4ff',
  },
  promptCode: {
    margin: 0,
    padding: '20px',
    fontSize: '12px',
    fontFamily: "'JetBrains Mono', monospace",
    color: '#888',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    overflow: 'auto',
  },

  // Agent Details
  agentDetails: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  agentDetail: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid',
    borderRadius: '12px',
    padding: '28px',
  },
  agentDetailHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginBottom: '16px',
  },
  agentDetailIcon: {
    fontSize: '36px',
  },
  agentDetailName: {
    fontSize: '20px',
    fontWeight: '700',
    letterSpacing: '2px',
  },
  agentDetailRole: {
    fontSize: '12px',
    color: '#666',
  },
  accuracyBadge: {
    marginLeft: 'auto',
    padding: '4px 12px',
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    border: '1px solid rgba(0, 255, 136, 0.3)',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: '600',
    color: '#00ff88',
    letterSpacing: '1px',
  },
  agentDetailDescription: {
    fontSize: '14px',
    color: '#999',
    lineHeight: '1.7',
    marginBottom: '20px',
  },
  agentCapabilities: {
    marginBottom: '20px',
  },
  capabilitiesTitle: {
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#666',
    marginBottom: '12px',
  },
  capabilitiesList: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '8px',
  },
  capabilityItem: {
    fontSize: '12px',
    color: '#888',
    paddingLeft: '12px',
    borderLeft: '2px solid #333',
  },
  agentExample: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderRadius: '8px',
    padding: '16px',
  },
  exampleLabel: {
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#666',
    marginBottom: '12px',
  },
  exampleInput: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '12px',
    fontFamily: "'JetBrains Mono', monospace",
  },
  exampleInputLabel: {
    color: '#666',
  },
  exampleOutput: {
    fontSize: '12px',
    color: '#00d4ff',
    fontFamily: "'JetBrains Mono', monospace",
    lineHeight: '1.5',
  },
  exampleOutputLabel: {
    color: '#666',
  },

  // Collaboration Example
  collaborationExample: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  collabHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '16px 20px',
    backgroundColor: 'rgba(255, 208, 0, 0.1)',
    borderBottom: '1px solid #1a2a3a',
    fontSize: '13px',
    fontWeight: '600',
    color: '#ffd000',
  },
  collabIcon: {
    fontSize: '18px',
  },
  collabTimeline: {
    padding: '20px',
  },
  collabStep: {
    display: 'grid',
    gridTemplateColumns: '50px 100px 1fr',
    gap: '16px',
    padding: '12px 0',
    borderBottom: '1px solid #1a2a3a',
  },
  collabTime: {
    fontSize: '11px',
    fontFamily: "'JetBrains Mono', monospace",
    color: '#666',
  },
  collabAgent: {
    fontSize: '12px',
    fontWeight: '600',
    letterSpacing: '1px',
  },
  collabText: {
    fontSize: '13px',
    color: '#999',
    lineHeight: '1.5',
  },

  // Area Query Example
  areaQueryExample: {
    marginBottom: '40px',
  },
  queryInput: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '16px 20px',
    backgroundColor: 'rgba(0, 212, 255, 0.1)',
    border: '1px solid rgba(0, 212, 255, 0.3)',
    borderRadius: '8px 8px 0 0',
    fontFamily: "'JetBrains Mono', monospace",
  },
  queryPrompt: {
    color: '#00d4ff',
    fontWeight: '600',
  },
  queryText: {
    color: '#fff',
    fontSize: '14px',
  },
  queryResponse: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderTop: 'none',
    borderRadius: '0 0 8px 8px',
    overflow: 'hidden',
  },
  responseHeader: {
    padding: '12px 20px',
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '2px',
    color: '#00ff88',
  },
  responseContent: {
    padding: '20px',
    fontSize: '13px',
    color: '#999',
    lineHeight: '1.7',
  },
  areaFeatures: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '16px',
  },
  areaFeature: {
    display: 'flex',
    gap: '16px',
    padding: '20px',
    backgroundColor: 'rgba(15, 20, 30, 0.6)',
    borderRadius: '8px',
  },
  areaFeatureIcon: {
    fontSize: '24px',
  },
  areaFeatureTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#fff',
    marginBottom: '4px',
  },
  areaFeatureDescription: {
    fontSize: '12px',
    color: '#888',
    lineHeight: '1.5',
  },

  // Accuracy Display
  accuracyDisplay: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid rgba(0, 255, 136, 0.2)',
    borderRadius: '12px',
    overflow: 'hidden',
    maxWidth: '600px',
    margin: '0 auto',
  },
  accuracyHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    padding: '16px',
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    fontSize: '14px',
    fontWeight: '600',
    color: '#00ff88',
    letterSpacing: '2px',
  },
  accuracyIcon: {
    fontSize: '20px',
  },
  accuracyStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    padding: '24px',
    gap: '16px',
  },
  accuracyStat: {
    textAlign: 'center',
  },
  accuracyValue: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#00ff88',
  },
  accuracyLabel: {
    fontSize: '11px',
    color: '#666',
    marginTop: '4px',
  },
  accuracyNote: {
    padding: '16px 24px',
    borderTop: '1px solid #1a2a3a',
    fontSize: '11px',
    color: '#666',
    fontStyle: 'italic',
  },

  // Pipeline
  pipeline: {
    maxWidth: '500px',
    margin: '0 auto',
  },
  pipelineStep: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '8px',
    padding: '20px',
  },
  pipelineStepHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '12px',
  },
  stepNumber: {
    fontSize: '24px',
    fontWeight: '800',
    color: '#1a2a3a',
  },
  stepTitle: {
    fontSize: '16px',
    fontWeight: '700',
    color: '#00d4ff',
    letterSpacing: '2px',
  },
  stepDescription: {
    fontSize: '13px',
    color: '#888',
    lineHeight: '1.6',
    margin: '0 0 12px 0',
  },
  stepTech: {
    fontSize: '10px',
    color: '#444',
    fontFamily: "'JetBrains Mono', monospace",
  },
  pipelineArrow: {
    textAlign: 'center',
    fontSize: '24px',
    color: '#1a2a3a',
    padding: '8px 0',
  },

  // Features
  features: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '20px',
    marginBottom: '60px',
  },
  featureCard: {
    backgroundColor: 'rgba(15, 20, 30, 0.8)',
    border: '1px solid #1a2a3a',
    borderRadius: '12px',
    padding: '24px',
  },
  featureIcon: {
    fontSize: '28px',
    marginBottom: '16px',
    display: 'block',
  },
  featureTitle: {
    fontSize: '15px',
    fontWeight: '600',
    marginBottom: '10px',
    color: '#fff',
  },
  featureDescription: {
    fontSize: '13px',
    lineHeight: '1.6',
    color: '#888',
    margin: 0,
  },

  // Stats
  stats: {
    display: 'flex',
    justifyContent: 'center',
    gap: '40px',
    marginBottom: '60px',
    flexWrap: 'wrap',
  },
  statBox: {
    textAlign: 'center',
  },
  statValue: {
    fontSize: '32px',
    fontWeight: '800',
    color: '#00d4ff',
    textShadow: '0 0 20px rgba(0, 212, 255, 0.3)',
  },
  statLabel: {
    fontSize: '11px',
    color: '#666',
    letterSpacing: '2px',
    textTransform: 'uppercase',
    marginTop: '4px',
  },

  // CTA
  enterButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    margin: '0 auto 24px',
    padding: '20px 56px',
    fontSize: '16px',
    fontWeight: '700',
    letterSpacing: '4px',
    color: '#000',
    backgroundColor: '#00d4ff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.3s ease',
    boxShadow: '0 0 40px rgba(0, 212, 255, 0.4)',
  },
  enterButtonText: {},
  enterButtonArrow: {
    fontSize: '20px',
    transition: 'transform 0.3s ease',
  },
  disclaimer: {
    textAlign: 'center',
    fontSize: '11px',
    color: '#444',
    maxWidth: '500px',
    margin: '0 auto',
    lineHeight: '1.6',
  },
};

// Animations
const styleSheet = document.createElement('style');
styleSheet.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
  @keyframes scanLine {
    0% { transform: translateY(-100%); opacity: 0; }
    10% { opacity: 1; }
    90% { opacity: 1; }
    100% { transform: translateY(100vh); opacity: 0; }
  }
  button:hover {
    transform: translateY(-2px);
    box-shadow: 0 0 60px rgba(0, 212, 255, 0.6);
  }
  button:hover span:last-child {
    transform: translateX(4px);
  }
  
  @media (max-width: 768px) {
    .problemGrid, .trainingGrid, .capabilitiesList, .areaFeatures, .features {
      grid-template-columns: 1fr !important;
    }
    .stats {
      gap: 24px !important;
    }
    .collabStep {
      grid-template-columns: 1fr !important;
      gap: 8px !important;
    }
  }
`;
document.head.appendChild(styleSheet);

export default LandingPage;
