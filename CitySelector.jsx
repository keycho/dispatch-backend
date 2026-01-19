import React, { useState, useEffect } from 'react';

/**
 * CitySelector - City selection page for DISPATCH
 * 
 * Usage:
 *   <CitySelector onSelectCity={(cityId) => navigate(`/map/${cityId}`)} />
 * 
 * Or with React Router:
 *   const navigate = useNavigate();
 *   <CitySelector onSelectCity={(cityId) => navigate(`/${cityId}`)} />
 */

const CitySelector = ({ onSelectCity }) => {
  const [hoveredCity, setHoveredCity] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTimeout(() => setLoaded(true), 100);
  }, []);

  const cities = [
    {
      id: 'nyc',
      name: 'NEW YORK',
      subtitle: 'CITY',
      population: '8.3M',
      precincts: '77 Precincts',
      feeds: '10 Live Feeds',
      mapCenter: { lat: 40.7128, lng: -74.006 },
      color: '#FF6B35',
      description: 'Five boroughs. 8 million stories. Every call tracked.',
    },
    {
      id: 'mpls',
      name: 'MINNEAPOLIS',
      subtitle: 'MINNESOTA',
      population: '430K',
      precincts: '5 Precincts',
      feeds: '4 Live Feeds',
      mapCenter: { lat: 44.9778, lng: -93.265 },
      color: '#4ECDC4',
      description: 'Twin Cities. Hennepin County. Real-time intelligence.',
    },
  ];

  return (
    <div style={styles.container}>
      {/* Animated grid background */}
      <div style={styles.gridOverlay} />
      
      {/* Header */}
      <header style={styles.header}>
        <span style={styles.logo}>D I S P A T C H</span>
        <div style={styles.liveIndicator}>
          <span style={styles.liveDot} />
          <span style={styles.liveText}>LIVE</span>
        </div>
      </header>

      {/* Main content */}
      <main style={styles.main}>
        <div style={{
          ...styles.titleSection,
          opacity: loaded ? 1 : 0,
          transform: loaded ? 'translateY(0)' : 'translateY(20px)',
        }}>
          <h1 style={styles.title}>Select Your City</h1>
          <p style={styles.subtitle}>
            Choose a metropolitan area to begin monitoring
          </p>
        </div>

        <div style={styles.cityGrid}>
          {cities.map((city, index) => (
            <div
              key={city.id}
              style={{
                ...styles.cityCard,
                opacity: loaded ? 1 : 0,
                transform: loaded ? 'translateY(0)' : 'translateY(40px)',
                transitionDelay: `${index * 150 + 200}ms`,
                borderColor: hoveredCity === city.id ? city.color : 'rgba(255,255,255,0.1)',
                boxShadow: hoveredCity === city.id 
                  ? `0 0 60px ${city.color}20, inset 0 0 60px ${city.color}08` 
                  : 'none',
              }}
              onMouseEnter={() => setHoveredCity(city.id)}
              onMouseLeave={() => setHoveredCity(null)}
              onClick={() => onSelectCity && onSelectCity(city.id)}
            >
              {/* Map Preview - using Mapbox static API (free tier) */}
              <div style={styles.mapPreview}>
                <img
                  src={`https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${city.mapCenter.lng},${city.mapCenter.lat},10,0/500x280@2x?access_token=pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw`}
                  alt={`${city.name} map`}
                  style={{
                    ...styles.mapImage,
                    filter: hoveredCity === city.id ? 'brightness(1.1)' : 'brightness(0.6)',
                  }}
                  onError={(e) => {
                    // Fallback to a gradient if Mapbox fails
                    e.target.style.display = 'none';
                  }}
                />
                <div style={styles.mapGradient} />
                
                {/* Pulse effect on hover */}
                {hoveredCity === city.id && (
                  <>
                    <div style={{...styles.pulseRing, borderColor: city.color, animationDelay: '0s'}} />
                    <div style={{...styles.pulseRing, borderColor: city.color, animationDelay: '0.5s'}} />
                  </>
                )}
                
                {/* Center marker */}
                <div style={{
                  ...styles.centerDot,
                  backgroundColor: city.color,
                  boxShadow: `0 0 20px ${city.color}, 0 0 40px ${city.color}60`,
                }} />
              </div>

              {/* City Info */}
              <div style={styles.cityInfo}>
                <div style={styles.cityNameRow}>
                  <h2 style={styles.cityName}>{city.name}</h2>
                  <span style={{...styles.citySubtitle, color: city.color}}>
                    {city.subtitle}
                  </span>
                </div>
                
                <p style={styles.cityDescription}>{city.description}</p>

                <div style={styles.statsRow}>
                  <div style={styles.stat}>
                    <span style={styles.statValue}>{city.population}</span>
                    <span style={styles.statLabel}>Population</span>
                  </div>
                  <div style={styles.stat}>
                    <span style={styles.statValue}>{city.precincts}</span>
                    <span style={styles.statLabel}>Coverage</span>
                  </div>
                  <div style={styles.stat}>
                    <span style={{...styles.statValue, color: city.color}}>
                      ● {city.feeds}
                    </span>
                    <span style={styles.statLabel}>Scanner</span>
                  </div>
                </div>

                <button
                  style={{
                    ...styles.enterButton,
                    borderColor: hoveredCity === city.id ? city.color : 'rgba(255,255,255,0.2)',
                    color: hoveredCity === city.id ? city.color : 'rgba(255,255,255,0.6)',
                    background: hoveredCity === city.id ? `${city.color}10` : 'transparent',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectCity && onSelectCity(city.id);
                  }}
                >
                  <span>ENTER SYSTEM</span>
                  <span style={{
                    ...styles.arrow,
                    transform: hoveredCity === city.id ? 'translateX(4px)' : 'translateX(0)',
                  }}>→</span>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <p style={{
          ...styles.footerHint,
          opacity: loaded ? 1 : 0,
          transitionDelay: '600ms',
        }}>
          More cities coming soon · Chicago · Los Angeles · Miami
        </p>
      </main>

      {/* Scanline effect */}
      <div style={styles.scanline} />
      
      {/* Inject keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.1); }
        }
        @keyframes pulse-ring {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 0.6; }
          100% { transform: translate(-50%, -50%) scale(4); opacity: 0; }
        }
        @keyframes scanline {
          0% { top: -2px; }
          100% { top: 100vh; }
        }
      `}</style>
    </div>
  );
};

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#0a0a0a',
    color: '#fff',
    fontFamily: "'SF Mono', 'Fira Code', 'Monaco', 'Consolas', monospace",
    position: 'relative',
    overflow: 'hidden',
  },
  gridOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundImage: `
      linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)
    `,
    backgroundSize: '60px 60px',
    pointerEvents: 'none',
  },
  scanline: {
    position: 'fixed',
    left: 0,
    right: 0,
    height: '2px',
    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)',
    animation: 'scanline 10s linear infinite',
    pointerEvents: 'none',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '28px 48px',
    position: 'relative',
    zIndex: 10,
  },
  logo: {
    fontSize: '13px',
    letterSpacing: '6px',
    fontWeight: 400,
    color: 'rgba(255,255,255,0.5)',
  },
  liveIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  liveDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#ef4444',
    animation: 'pulse 2s ease-in-out infinite',
  },
  liveText: {
    fontSize: '11px',
    letterSpacing: '3px',
    color: 'rgba(255,255,255,0.4)',
  },
  main: {
    maxWidth: '1100px',
    margin: '0 auto',
    padding: '20px 48px 60px',
    position: 'relative',
    zIndex: 10,
  },
  titleSection: {
    textAlign: 'center',
    marginBottom: '60px',
    transition: 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  title: {
    fontSize: 'clamp(28px, 4vw, 42px)',
    fontWeight: 200,
    letterSpacing: '10px',
    textTransform: 'uppercase',
    marginBottom: '16px',
    fontFamily: "'Helvetica Neue', 'Arial', sans-serif",
    color: 'rgba(255,255,255,0.9)',
  },
  subtitle: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: '4px',
    textTransform: 'uppercase',
  },
  cityGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
    gap: '32px',
    marginBottom: '60px',
  },
  cityCard: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.1)',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  mapPreview: {
    position: 'relative',
    height: '180px',
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  mapImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transition: 'filter 0.4s ease',
  },
  mapGradient: {
    position: 'absolute',
    inset: 0,
    background: 'linear-gradient(180deg, transparent 30%, rgba(10,10,10,0.95) 100%)',
    pointerEvents: 'none',
  },
  centerDot: {
    position: 'absolute',
    top: '45%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    transition: 'all 0.3s ease',
  },
  pulseRing: {
    position: 'absolute',
    top: '45%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    border: '1px solid',
    animation: 'pulse-ring 2s ease-out infinite',
    pointerEvents: 'none',
  },
  cityInfo: {
    padding: '24px 28px 28px',
  },
  cityNameRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '14px',
    marginBottom: '10px',
  },
  cityName: {
    fontSize: '26px',
    fontWeight: 300,
    letterSpacing: '5px',
    margin: 0,
    fontFamily: "'Helvetica Neue', 'Arial', sans-serif",
  },
  citySubtitle: {
    fontSize: '10px',
    letterSpacing: '3px',
    fontWeight: 600,
  },
  cityDescription: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 1.5,
    marginBottom: '20px',
    fontFamily: "'Helvetica Neue', 'Arial', sans-serif",
  },
  statsRow: {
    display: 'flex',
    gap: '28px',
    marginBottom: '24px',
    paddingBottom: '20px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  statValue: {
    fontSize: '13px',
    fontWeight: 500,
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: '0.5px',
  },
  statLabel: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.35)',
    textTransform: 'uppercase',
    letterSpacing: '2px',
  },
  enterButton: {
    width: '100%',
    padding: '14px 20px',
    background: 'transparent',
    border: '1px solid',
    fontSize: '11px',
    letterSpacing: '4px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    transition: 'all 0.3s ease',
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  },
  arrow: {
    transition: 'transform 0.3s ease',
    fontSize: '14px',
  },
  footerHint: {
    textAlign: 'center',
    fontSize: '11px',
    color: 'rgba(255,255,255,0.2)',
    letterSpacing: '3px',
    transition: 'opacity 0.8s ease',
    fontFamily: "'Helvetica Neue', 'Arial', sans-serif",
  },
};

export default CitySelector;
