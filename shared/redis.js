// ============================================
// DISPATCH - SHARED REDIS PUB/SUB MODULE
// ============================================

import { createClient } from 'redis';
import { REDIS_CHANNELS } from './constants.js';

let publisherClient = null;
let subscriberClient = null;
const subscriptionHandlers = new Map();

// ============================================
// CONNECTION MANAGEMENT
// ============================================

export async function initRedis() {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  
  try {
    // Publisher client
    publisherClient = createClient({ url: redisUrl });
    publisherClient.on('error', (err) => console.error('[REDIS] Publisher error:', err.message));
    await publisherClient.connect();
    console.log('[REDIS] Publisher connected');
    
    // Subscriber client (separate connection required for pub/sub)
    subscriberClient = createClient({ url: redisUrl });
    subscriberClient.on('error', (err) => console.error('[REDIS] Subscriber error:', err.message));
    await subscriberClient.connect();
    console.log('[REDIS] Subscriber connected');
    
    return true;
  } catch (error) {
    console.error('[REDIS] Connection failed:', error.message);
    console.log('[REDIS] Running without Redis - using in-memory only');
    return false;
  }
}

export function getPublisher() {
  return publisherClient;
}

export function getSubscriber() {
  return subscriberClient;
}

export async function closeRedis() {
  if (publisherClient) await publisherClient.quit();
  if (subscriberClient) await subscriberClient.quit();
}

// ============================================
// PUBLISHING
// ============================================

export async function publish(channel, data) {
  if (!publisherClient) {
    // Fallback: emit to local handlers if no Redis
    const handlers = subscriptionHandlers.get(channel);
    if (handlers) {
      const message = JSON.stringify(data);
      handlers.forEach(handler => handler(message, channel));
    }
    return false;
  }
  
  try {
    await publisherClient.publish(channel, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error(`[REDIS] Publish error on ${channel}:`, error.message);
    return false;
  }
}

// Convenience publishers
export async function publishIncident(incident, cityId) {
  return publish(REDIS_CHANNELS.INCIDENTS, { 
    type: 'incident', 
    incident, 
    city: cityId,
    timestamp: new Date().toISOString() 
  });
}

export async function publishTranscript(transcript, cityId) {
  return publish(REDIS_CHANNELS.TRANSCRIPTS, { 
    type: 'transcript', 
    ...transcript, 
    city: cityId,
    timestamp: transcript.timestamp || new Date().toISOString() 
  });
}

export async function publishCameraSwitch(camera, reason, priority, cityId) {
  return publish(REDIS_CHANNELS.CAMERAS, { 
    type: 'camera_switch', 
    camera, 
    reason, 
    priority,
    city: cityId,
    timestamp: new Date().toISOString() 
  });
}

export async function publishAgentInsight(agentId, agentIcon, incidentId, analysis, urgency) {
  return publish(REDIS_CHANNELS.AGENT_INSIGHTS, {
    type: 'agent_insight',
    agent: agentId,
    agentIcon,
    incidentId,
    analysis,
    urgency,
    timestamp: new Date().toISOString()
  });
}

export async function publishPrediction(prediction) {
  return publish(REDIS_CHANNELS.PREDICTIONS, {
    type: 'prophet_prediction',
    agent: 'PROPHET',
    agentIcon: '🔮',
    prediction,
    timestamp: new Date().toISOString()
  });
}

export async function publishPredictionHit(prediction, matchedIncident, accuracy) {
  return publish(REDIS_CHANNELS.PREDICTIONS, {
    type: 'prediction_hit',
    agent: 'PROPHET',
    agentIcon: '🔮',
    prediction,
    matchedIncident,
    accuracy,
    timestamp: new Date().toISOString()
  });
}

export async function publishICEAlert(alert, cityId) {
  return publish(REDIS_CHANNELS.ICE_ALERTS, {
    type: 'ice_alert',
    alert,
    city: cityId,
    timestamp: new Date().toISOString()
  });
}

export async function publishBetWon(bet, incident) {
  return publish(REDIS_CHANNELS.BETS, {
    type: 'bet_won',
    bet: { 
      id: bet.id, 
      user: `${bet.walletAddress?.slice(0,4)}...${bet.walletAddress?.slice(-4)}` || bet.username,
      amount: bet.amountSOL || bet.amount, 
      multiplier: bet.multiplier, 
      winnings: bet.winnings, 
      borough: bet.borough || bet.district 
    },
    incident: { id: incident.id, type: incident.incidentType, location: incident.location },
    timestamp: new Date().toISOString()
  });
}

export async function publishNewBet(bet, user) {
  return publish(REDIS_CHANNELS.BETS, {
    type: 'new_bet',
    bet: { 
      id: bet.id, 
      borough: bet.borough || bet.district, 
      incidentType: bet.incidentType, 
      amount: bet.amountSOL || bet.amount, 
      multiplier: bet.multiplier, 
      potentialWinSOL: bet.potentialWinSOL || bet.potentialWin,
      user: user?.displayName || 'Anonymous'
    },
    timestamp: new Date().toISOString()
  });
}

export async function publishActivity(activity) {
  return publish(REDIS_CHANNELS.ACTIVITY, {
    id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    ...activity,
    timestamp: new Date().toISOString()
  });
}

export async function publishWorkerStatus(status) {
  return publish(REDIS_CHANNELS.WORKER_STATUS, {
    type: 'worker_status',
    ...status,
    timestamp: new Date().toISOString()
  });
}

// ============================================
// SUBSCRIBING
// ============================================

export async function subscribe(channel, handler) {
  // Store handler for fallback mode
  if (!subscriptionHandlers.has(channel)) {
    subscriptionHandlers.set(channel, new Set());
  }
  subscriptionHandlers.get(channel).add(handler);
  
  if (!subscriberClient) {
    console.log(`[REDIS] No Redis - using local handler for ${channel}`);
    return false;
  }
  
  try {
    await subscriberClient.subscribe(channel, (message, ch) => {
      try {
        const data = JSON.parse(message);
        handler(data, ch);
      } catch (e) {
        console.error(`[REDIS] Parse error on ${ch}:`, e.message);
      }
    });
    console.log(`[REDIS] Subscribed to ${channel}`);
    return true;
  } catch (error) {
    console.error(`[REDIS] Subscribe error on ${channel}:`, error.message);
    return false;
  }
}

export async function unsubscribe(channel, handler) {
  const handlers = subscriptionHandlers.get(channel);
  if (handlers) {
    handlers.delete(handler);
  }
  
  if (!subscriberClient) return false;
  
  try {
    await subscriberClient.unsubscribe(channel);
    return true;
  } catch (error) {
    console.error(`[REDIS] Unsubscribe error on ${channel}:`, error.message);
    return false;
  }
}

// Subscribe to all dispatch channels
export async function subscribeToAll(handlers) {
  const channels = Object.values(REDIS_CHANNELS);
  
  for (const channel of channels) {
    if (handlers[channel]) {
      await subscribe(channel, handlers[channel]);
    }
  }
}

// ============================================
// CACHING (for worker state sharing)
// ============================================

export async function setCache(key, value, expirySeconds = 3600) {
  if (!publisherClient) return false;
  
  try {
    await publisherClient.setEx(key, expirySeconds, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`[REDIS] Cache set error:`, error.message);
    return false;
  }
}

export async function getCache(key) {
  if (!publisherClient) return null;
  
  try {
    const value = await publisherClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.error(`[REDIS] Cache get error:`, error.message);
    return null;
  }
}

export async function deleteCache(key) {
  if (!publisherClient) return false;
  
  try {
    await publisherClient.del(key);
    return true;
  } catch (error) {
    return false;
  }
}

// Store worker stats for web process to read
export async function updateWorkerStats(stats) {
  return setCache('dispatch:worker:stats', stats, 60); // 1 minute expiry
}

export async function getWorkerStats() {
  return getCache('dispatch:worker:stats');
}

// Store city state for sharing between processes
export async function updateCityState(cityId, state) {
  return setCache(`dispatch:city:${cityId}`, state, 300); // 5 minute expiry
}

export async function getCityState(cityId) {
  return getCache(`dispatch:city:${cityId}`);
}
