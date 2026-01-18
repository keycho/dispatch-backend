# 🚨 DISPATCH - Police Scanner Intelligence Backend

Real-time police scanner transcription and incident detection.

## Quick Deploy to Railway

### Step 1: Create GitHub Repo

1. Go to [github.com/new](https://github.com/new)
2. Create a new repo called `dispatch-backend`
3. Upload these files to it

### Step 2: Deploy to Railway

1. Go to [railway.app/dashboard](https://railway.app/dashboard)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your `dispatch-backend` repo
5. Railway will auto-detect and deploy

### Step 3: Add Environment Variables

In Railway dashboard, go to your project → **Variables** tab:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-openai-key-here
```

### Step 4: Get Your URL

After deploy, Railway gives you a URL like:
```
https://dispatch-backend-production-xxxx.up.railway.app
```

This is your WebSocket endpoint for the frontend.

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status |
| `/health` | GET | Health check |
| `/cameras` | GET | List all cameras |
| `/incidents` | GET | Recent incidents |
| `ws://` | WebSocket | Real-time connection |

## WebSocket Messages

### From Server:

```json
// Initial state
{ "type": "init", "incidents": [...], "cameras": [...] }

// New transcript
{ "type": "transcript", "text": "...", "timestamp": "..." }

// Incident detected
{ "type": "incident", "incident": {...} }

// Camera switch
{ "type": "camera_switch", "camera": {...}, "reason": "..." }

// AI analysis
{ "type": "analysis", "text": "...", "timestamp": "..." }
```

### To Server:

```json
// Send audio chunk for transcription
{ "type": "audio_chunk", "audio": "base64-encoded-audio" }

// Manual transcript (for testing)
{ "type": "manual_transcript", "text": "10-50 at 42nd and Lex..." }
```

---

## Testing

Once deployed, you can test with manual transcripts:

```javascript
const ws = new WebSocket('wss://your-railway-url.up.railway.app');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'manual_transcript',
    text: '10-50, vehicle collision at 42nd and Lexington, two vehicles, requesting EMS'
  }));
};

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};
```

---

## Costs

- **OpenAI Whisper**: ~$0.006/minute of audio
- **Claude API**: ~$0.003/request
- **Railway**: ~$5/month for always-on

---

## Next Steps

1. Connect Lovable frontend to this WebSocket
2. Add real Broadcastify audio stream capture
3. Expand camera database with full NYC DOT list
