// ============================================
// DISPATCH TWITTER BOT
// Auto-posts notable incidents with AI analysis
// ============================================

import { TwitterApi } from 'twitter-api-v2';
import fetch from 'node-fetch';

class DispatchTwitterBot {
  constructor(config = {}) {
    this.enabled = !!(process.env.TWITTER_API_KEY && process.env.TWITTER_ACCESS_TOKEN);
    
    if (this.enabled) {
      this.twitter = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
      });
      console.log('[TWITTER] Bot initialized');
    } else {
      console.log('[TWITTER] Bot disabled - missing API keys');
    }
    
    // Rate limiting
    this.lastTweetTime = 0;
    this.minInterval = config.minInterval || 10 * 60 * 1000; // 10 min default
    this.dailyCount = 0;
    this.dailyLimit = config.dailyLimit || 45; // Stay under 50/day free tier
    this.lastDayReset = Date.now();
    
    // Pending incidents waiting for agent analysis
    this.pendingIncidents = new Map(); // incidentId -> { incident, camera, timestamp }
    this.analysisTimeout = 8000; // Wait 8s for agent analysis
    
    // Track recent tweets to avoid duplicates
    this.recentTweets = new Set();
    
    // Site URL for links
    this.siteUrl = config.siteUrl || 'https://dispatch.live';
    
    // Notable incident filters
    this.notableTypes = [
      'pursuit', 'shots fired', 'shooting', 'stabbing', 'robbery',
      'carjacking', 'officer down', 'hostage', 'active shooter',
      'explosion', 'assault in progress', 'kidnapping', 'hit and run',
      'armed robbery', 'burglary in progress', 'vehicle pursuit'
    ];
    
    this.criticalPriorities = ['critical', 'high'];
  }
  
  // Check if incident is tweet-worthy
  isNotable(incident) {
    if (!incident) return false;
    
    const text = `${incident.incidentType || ''} ${incident.summary || ''}`.toLowerCase();
    
    // Check for notable keywords
    const hasNotableType = this.notableTypes.some(type => text.includes(type));
    
    // Check priority
    const isCritical = this.criticalPriorities.includes(incident.priority?.toLowerCase());
    
    return hasNotableType || isCritical;
  }
  
  // Check rate limits
  canTweet() {
    // Reset daily counter
    if (Date.now() - this.lastDayReset > 24 * 60 * 60 * 1000) {
      this.dailyCount = 0;
      this.lastDayReset = Date.now();
    }
    
    // Check limits
    if (this.dailyCount >= this.dailyLimit) {
      console.log('[TWITTER] Daily limit reached');
      return false;
    }
    
    if (Date.now() - this.lastTweetTime < this.minInterval) {
      console.log('[TWITTER] Rate limited - too soon');
      return false;
    }
    
    return true;
  }
  
  // Queue incident for tweeting (waits for agent analysis)
  queueIncident(incident, camera = null) {
    if (!this.enabled) return;
    if (!this.isNotable(incident)) return;
    if (!this.canTweet()) return;
    
    // Dedupe check
    const dedupeKey = `${incident.incidentType}-${incident.location}`.toLowerCase();
    if (this.recentTweets.has(dedupeKey)) {
      console.log('[TWITTER] Skipping duplicate incident');
      return;
    }
    
    console.log(`[TWITTER] Queuing incident: ${incident.incidentType} @ ${incident.location}`);
    
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
    
    // Prefer CHASE analysis, but take any
    if (!pending.agentAnalysis || agent === 'CHASE') {
      pending.agentAnalysis = { agent, analysis };
      console.log(`[TWITTER] Added ${agent} analysis for incident ${incidentId}`);
    }
  }
  
  // Try to post the tweet
  async tryPost(incidentId) {
    const pending = this.pendingIncidents.get(incidentId);
    if (!pending) return;
    
    this.pendingIncidents.delete(incidentId);
    
    // Final rate limit check
    if (!this.canTweet()) return;
    
    const { incident, camera, agentAnalysis } = pending;
    
    try {
      const tweet = this.formatTweet(incident, camera, agentAnalysis);
      await this.postTweet(tweet, camera);
      
      // Track for dedupe
      const dedupeKey = `${incident.incidentType}-${incident.location}`.toLowerCase();
      this.recentTweets.add(dedupeKey);
      setTimeout(() => this.recentTweets.delete(dedupeKey), 30 * 60 * 1000); // Clear after 30min
      
    } catch (error) {
      console.error('[TWITTER] Post failed:', error.message);
    }
  }
  
  // Format the tweet text
  formatTweet(incident, camera, agentAnalysis) {
    const time = new Date().toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York'
    });
    
    const borough = incident.borough || incident.city?.toUpperCase() || 'NYC';
    const type = (incident.incidentType || 'INCIDENT').toUpperCase();
    const location = incident.location || 'Unknown location';
    
    // Build tweet
    let tweet = `🚨 ${type}\n`;
    tweet += `📍 ${location}, ${borough}\n\n`;
    
    // Add summary if exists (truncated)
    if (incident.summary) {
      const summary = incident.summary.length > 120 
        ? incident.summary.substring(0, 117) + '...'
        : incident.summary;
      tweet += `"${summary}"\n\n`;
    }
    
    // Add agent analysis if exists
    if (agentAnalysis?.analysis) {
      const agentText = agentAnalysis.analysis.length > 100
        ? agentAnalysis.analysis.substring(0, 97) + '...'
        : agentAnalysis.analysis;
      tweet += `🤖 ${agentAnalysis.agent}: "${agentText}"\n\n`;
    }
    
    // Add link
    const incidentUrl = `${this.siteUrl}/nyc?incident=${incident.id}`;
    tweet += `👁️ Live → ${incidentUrl}`;
    
    // Ensure under 280 chars
    if (tweet.length > 280) {
      // Remove agent analysis if too long
      tweet = `🚨 ${type}\n`;
      tweet += `📍 ${location}, ${borough}\n\n`;
      if (incident.summary) {
        const summary = incident.summary.length > 80 
          ? incident.summary.substring(0, 77) + '...'
          : incident.summary;
        tweet += `"${summary}"\n\n`;
      }
      tweet += `👁️ Live → ${this.siteUrl}`;
    }
    
    return tweet;
  }
  
  // Post to Twitter
  async postTweet(text, camera = null) {
    if (!this.enabled) {
      console.log('[TWITTER] Would post:', text);
      return;
    }
    
    try {
      let mediaId = null;
      
      // Try to attach camera image if available
      if (camera?.id) {
        try {
          const imageUrl = `https://webcams.nyctmc.org/api/cameras/${camera.id}/image`;
          const imageResponse = await fetch(imageUrl);
          
          if (imageResponse.ok) {
            const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            mediaId = await this.twitter.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });
            console.log('[TWITTER] Camera image attached');
          }
        } catch (imgError) {
          console.log('[TWITTER] Camera image failed, posting without:', imgError.message);
        }
      }
      
      // Post tweet
      const tweetOptions = { text };
      if (mediaId) {
        tweetOptions.media = { media_ids: [mediaId] };
      }
      
      const result = await this.twitter.v2.tweet(tweetOptions);
      
      this.lastTweetTime = Date.now();
      this.dailyCount++;
      
      console.log(`[TWITTER] Posted! ID: ${result.data.id} (${this.dailyCount}/${this.dailyLimit} today)`);
      
      return result;
      
    } catch (error) {
      console.error('[TWITTER] API error:', error);
      throw error;
    }
  }
  
  // Get stats
  getStats() {
    return {
      enabled: this.enabled,
      dailyCount: this.dailyCount,
      dailyLimit: this.dailyLimit,
      lastTweetTime: this.lastTweetTime,
      pendingCount: this.pendingIncidents.size,
      canTweet: this.canTweet()
    };
  }
}

export default DispatchTwitterBot;


// ============================================
// INTEGRATION INSTRUCTIONS
// ============================================
/*

1. Install twitter-api-v2:
   npm install twitter-api-v2

2. Add to Railway environment variables:
   TWITTER_API_KEY=your_api_key
   TWITTER_API_SECRET=your_api_secret
   TWITTER_ACCESS_TOKEN=your_access_token
   TWITTER_ACCESS_SECRET=your_access_secret

3. In server.js, add near the top imports:
   
   import DispatchTwitterBot from './twitter-bot.js';

4. After your other initializations (around line 140), add:

   const twitterBot = new DispatchTwitterBot({
     siteUrl: 'https://dispatch.live',  // Your site URL
     minInterval: 10 * 60 * 1000,       // Min 10 min between tweets
     dailyLimit: 45                      // Max 45 tweets/day
   });

5. After incident broadcast (around line 4991), add:

   // Queue for Twitter if notable
   twitterBot.queueIncident(incident, camera);

6. After agent_insight broadcast (around line 812), add:

   // Add analysis to pending tweet
   twitterBot.addAgentAnalysis(incident.id, 'CHASE', chaseInsight);

7. (Optional) Add stats endpoint:

   app.get('/api/twitter/stats', (req, res) => {
     res.json(twitterBot.getStats());
   });

*/
