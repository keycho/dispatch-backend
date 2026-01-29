// ============================================
// DISPATCH TELEGRAM BOT
// Auto-posts notable incidents to Telegram channel
// ============================================

import fetch from 'node-fetch';

class DispatchTelegramBot {
  constructor(config = {}) {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.channelId = process.env.TELEGRAM_CHANNEL_ID; // e.g., @SuspectNYC or -1001234567890
    this.enabled = !!(this.token && this.channelId);
    
    if (this.enabled) {
      console.log('[TELEGRAM] Bot initialized');
    } else {
      console.log('[TELEGRAM] Bot disabled - missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID');
    }
    
    // Rate limiting (lowered for testing)
    this.lastPostTime = 0;
    this.minInterval = config.minInterval || 1 * 60 * 1000; // 1 min for testing
    
    // Pending incidents waiting for agent analysis
    this.pendingIncidents = new Map();
    this.analysisTimeout = 8000; // Wait 8s for agent analysis
    
    // Track recent posts to avoid duplicates
    this.recentPosts = new Set();
    
    // Site URL for links
    this.siteUrl = config.siteUrl || 'https://suspect.fyi';
    
    // Notable incident filters (lowered for testing)
    this.notableTypes = [
      'pursuit', 'shots fired', 'shooting', 'stabbing', 'robbery',
      'carjacking', 'officer down', 'hostage', 'active shooter',
      'explosion', 'assault in progress', 'kidnapping', 'hit and run',
      'armed robbery', 'burglary in progress', 'vehicle pursuit',
      // Lower threshold - more common incidents
      'assault', 'dispute', 'fight', 'disturbance', 'domestic',
      'burglary', 'theft', 'larceny', 'suspicious', 'weapon',
      'drugs', 'ems', 'ambulance', 'fire', 'accident', 'crash',
      'medical', 'unconscious', 'intoxicated', 'trespass'
    ];
    
    this.criticalPriorities = ['critical', 'high'];
  }
  
  // Check if incident is post-worthy
  isNotable(incident) {
    if (!incident) return false;
    
    const text = `${incident.incidentType || ''} ${incident.summary || ''}`.toLowerCase();
    const hasNotableType = this.notableTypes.some(type => text.includes(type));
    const isCritical = this.criticalPriorities.includes(incident.priority?.toLowerCase());
    
    return hasNotableType || isCritical;
  }
  
  // Check rate limits
  canPost() {
    if (Date.now() - this.lastPostTime < this.minInterval) {
      console.log('[TELEGRAM] Rate limited - too soon');
      return false;
    }
    return true;
  }
  
  // Queue incident for posting
  queueIncident(incident, camera = null) {
    if (!this.enabled) return;
    if (!this.isNotable(incident)) return;
    if (!this.canPost()) return;
    
    // Dedupe check
    const dedupeKey = `${incident.incidentType}-${incident.location}`.toLowerCase();
    if (this.recentPosts.has(dedupeKey)) {
      console.log('[TELEGRAM] Skipping duplicate incident');
      return;
    }
    
    console.log(`[TELEGRAM] Queuing incident: ${incident.incidentType} @ ${incident.location}`);
    
    this.pendingIncidents.set(incident.id, {
      incident,
      camera,
      timestamp: Date.now(),
      agentAnalysis: null
    });
    
    // Set timeout to post even if no agent analysis arrives
    setTimeout(() => this.tryPost(incident.id), this.analysisTimeout);
  }
  
  // Add agent analysis to pending incident
  addAgentAnalysis(incidentId, agent, analysis) {
    if (!this.pendingIncidents.has(incidentId)) return;
    
    const pending = this.pendingIncidents.get(incidentId);
    
    if (!pending.agentAnalysis || agent === 'CHASE') {
      pending.agentAnalysis = { agent, analysis };
      console.log(`[TELEGRAM] Added ${agent} analysis for incident ${incidentId}`);
    }
  }
  
  // Try to post
  async tryPost(incidentId) {
    const pending = this.pendingIncidents.get(incidentId);
    if (!pending) return;
    
    this.pendingIncidents.delete(incidentId);
    
    if (!this.canPost()) return;
    
    const { incident, camera, agentAnalysis } = pending;
    
    try {
      await this.postToChannel(incident, camera, agentAnalysis);
      
      // Track for dedupe
      const dedupeKey = `${incident.incidentType}-${incident.location}`.toLowerCase();
      this.recentPosts.add(dedupeKey);
      setTimeout(() => this.recentPosts.delete(dedupeKey), 30 * 60 * 1000);
      
    } catch (error) {
      console.error('[TELEGRAM] Post failed:', error.message);
    }
  }
  
  // Format the message
  formatMessage(incident, agentAnalysis) {
    const type = (incident.incidentType || 'INCIDENT').toUpperCase();
    const location = incident.location || 'Unknown location';
    const borough = incident.borough || 'NYC';
    
    let msg = `🚨 <b>${type}</b>\n`;
    msg += `📍 ${location}, ${borough}\n\n`;
    
    if (incident.summary) {
      msg += `<i>"${incident.summary}"</i>\n\n`;
    }
    
    if (agentAnalysis?.analysis) {
      msg += `🤖 <b>${agentAnalysis.agent}:</b> "${agentAnalysis.analysis}"\n\n`;
    }
    
    msg += `👁️ <a href="${this.siteUrl}/nyc?incident=${incident.id}">Watch Live</a>`;
    
    return msg;
  }
  
  // Post to Telegram channel
  async postToChannel(incident, camera, agentAnalysis) {
    if (!this.enabled) {
      console.log('[TELEGRAM] Would post:', this.formatMessage(incident, agentAnalysis));
      return;
    }
    
    const message = this.formatMessage(incident, agentAnalysis);
    
    try {
      // Try to send with camera image if available
      if (camera?.id) {
        try {
          const imageUrl = `https://webcams.nyctmc.org/api/cameras/${camera.id}/image`;
          
          // Send photo with caption
          const response = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.channelId,
              photo: imageUrl,
              caption: message,
              parse_mode: 'HTML'
            })
          });
          
          const result = await response.json();
          
          if (result.ok) {
            this.lastPostTime = Date.now();
            console.log(`[TELEGRAM] Posted with image! Message ID: ${result.result.message_id}`);
            return result;
          } else {
            console.log('[TELEGRAM] Photo failed, falling back to text:', result.description);
          }
        } catch (imgError) {
          console.log('[TELEGRAM] Image failed, posting text only:', imgError.message);
        }
      }
      
      // Fallback: text only
      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.channelId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: false
        })
      });
      
      const result = await response.json();
      
      if (result.ok) {
        this.lastPostTime = Date.now();
        console.log(`[TELEGRAM] Posted! Message ID: ${result.result.message_id}`);
      } else {
        console.error('[TELEGRAM] API error:', result.description);
      }
      
      return result;
      
    } catch (error) {
      console.error('[TELEGRAM] Post error:', error);
      throw error;
    }
  }
  
  // Get stats
  getStats() {
    return {
      enabled: this.enabled,
      lastPostTime: this.lastPostTime,
      pendingCount: this.pendingIncidents.size,
      canPost: this.canPost()
    };
  }
}

export default DispatchTelegramBot;
