# SimpleFIN Net Worth HTTP Server

A TypeScript HTTP server that exposes your net worth via API endpoint, with automatic refresh every 4 hours and historical tracking. Perfect for dashboards, monitoring, and integrations.

## Features

- ✅ HTTP API endpoint serving net worth data
- ✅ 30-day change tracking
- ✅ Automatic refresh every 4 hours
- ✅ Historical data logging to disk
- ✅ In-memory caching for fast responses
- ✅ PM2 ready for production deployment
- ✅ Reverse proxy compatible (CORS enabled)
- ✅ Health check endpoint
- ✅ Graceful shutdown

## Setup

1. **Get a SimpleFIN setup token:**
   - Visit [SimpleFIN Bridge](https://beta-bridge.simplefin.org/simplefin/create)
   - Connect your bank accounts and generate a setup token
   - Note: SimpleFIN costs $1.50/month or $15/year

2. **Run setup:**
   ```bash
   npm run setup <your-setup-token>
   ```
   This saves your credentials to `.env`

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
# Direct
npm start

# With PM2 (recommended)
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Enable auto-start on boot
```

## API Endpoints

### `GET /` or `GET /networth`
Returns current net worth as plain text:

```bash
curl https://networth.jansen.systems
# Output: 19000.00
```

### `GET /change` or `GET /networth/change`
Returns 30-day change as plain text:

```bash
curl https://networth.jansen.systems/change
# Output: 1250.50
```

Positive = gained, Negative = lost. Returns `"Insufficient data"` if less than 30 days of history.

### `GET /networth/details`
Returns JSON with full metadata:

```bash
curl https://networth.jansen.systems/networth/details
```

```json
{
  "netWorth": 19000.00,
  "currency": "USD",
  "formatted": "$19,000.00",
  "lastUpdated": "2025-12-15T12:34:56.789Z",
  "accountCount": 3,
  "change30Days": 1250.50,
  "change30DaysFormatted": "$1,250.50"
}
```

### `GET /health`
Health check endpoint:

```bash
curl https://networth.jansen.systems/health
# Output: {"status":"ok"}
```

## Historical Data

Net worth is automatically logged to `./data/networth-history.json` every 4 hours:

```json
[
  {
    "timestamp": 1734278496789,
    "date": "2025-12-15T12:34:56.789Z",
    "netWorth": 19000.00,
    "currency": "USD",
    "accountCount": 3
  },
  {
    "timestamp": 1734292896789,
    "date": "2025-12-15T16:34:56.789Z",
    "netWorth": 19250.50,
    "currency": "USD",
    "accountCount": 3
  }
]
```

This file persists across restarts and grows over time (6 entries per day).

## Configuration

### Environment Variables

Create a `.env` file (generated automatically during setup):
```
ACCESS_URL=https://username:password@beta-bridge.simplefin.org/simplefin
PORT=3000
```

### PM2 Configuration

Edit `ecosystem.config.cjs` to customize:
- **Port**: Change `PORT` in env (default: 3000)
- **Memory limit**: Adjust `max_memory_restart` (default: 200M)
- **Daily restart**: Modify `cron_restart` (default: 3 AM)
- **Log files**: Change `error_file` and `out_file` paths (default: `./logs/`)

## PM2 Commands

```bash
# Start
pm2 start ecosystem.config.cjs

# Status
pm2 status

# Logs
pm2 logs networth

# Restart
pm2 restart networth

# Stop
pm2 stop networth

# Delete
pm2 delete networth
```

## Reverse Proxy Setup

### Nginx Example

```nginx
server {
    listen 80;
    server_name networth.jansen.systems;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### Caddy Example

```
networth.jansen.systems {
    reverse_proxy localhost:3000
}
```

## Cache Behavior

- **Initial fetch**: On server start
- **Refresh interval**: Every 4 hours
- **Rate limiting**: Respects SimpleFIN's 24 requests/day limit (6 refreshes fits comfortably)
- **Persistence**: Cache is in-memory; history is persisted to disk

## Security Notes

⚠️ **Important:**

1. **Protect your endpoint** - Add authentication at the reverse proxy level if exposing publicly
2. **Use HTTPS** - Always use SSL/TLS in production (handled by reverse proxy)
3. **Secure .env** - Never commit credentials to version control (already in `.gitignore`)
4. **Firewall** - Only expose port 3000 to your reverse proxy, not publicly

### Adding Basic Auth (Nginx)

```nginx
location / {
    auth_basic "Net Worth API";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3000;
}
```

## Test Commands

```bash
# Get current net worth
curl https://networth.jansen.systems

# Get 30-day change
curl https://networth.jansen.systems/change

# Get detailed JSON
curl https://networth.jansen.systems/networth/details | jq

# Health check
curl https://networth.jansen.systems/health

# Monitor over time
echo "$(date): $(curl -s https://networth.jansen.systems)" >> networth-log.txt
```

## Monitoring Script

```bash
#!/bin/bash
# Check if net worth service is healthy
response=$(curl -s -o /dev/null -w "%{http_code}" https://networth.jansen.systems/health)
if [ "$response" = "200" ]; then
  echo "✓ Net worth service is healthy"
  curl -s https://networth.jansen.systems/networth/details | jq
else
  echo "✗ Net worth service is down (HTTP $response)"
  exit 1
fi
```

## Troubleshooting

### Server won't start
- Check `.env` exists and has valid `ACCESS_URL`
- Verify port 3000 isn't already in use: `lsof -i :3000`
- Check logs: `pm2 logs networth`

### No data returned
- Wait a few seconds after startup for initial fetch
- Check `/health` endpoint returns `{"status":"ok"}`
- Verify SimpleFIN credentials are valid

### 403 errors in logs
- SimpleFIN access may have been revoked
- Run setup again with a new token: `npm run setup <new-token>`

### "Insufficient data" for 30-day change
- Normal for first 30 days of operation
- Historical data accumulates in `./data/networth-history.json`
- After 30 days, endpoint will return change value

## Architecture

```
┌─────────────┐
│   Browser   │
│  Dashboard  │
└──────┬──────┘
       │ HTTPS GET /networth
       ↓
┌─────────────────┐
│ Reverse Proxy   │
│ (Nginx/Caddy)   │
│   + SSL/TLS     │
└──────┬──────────┘
       │ HTTP
       ↓
┌─────────────────┐      ┌──────────────┐      ┌──────────────┐
│  Node.js HTTP   │ ←────┤  In-Memory   │      │    Disk      │
│     Server      │      │    Cache     │      │   History    │
│   (port 3000)   │      │              │      │    (JSON)    │
└──────┬──────────┘      └──────────────┘      └──────────────┘
       │                        ↑                       ↑
       │ Every 4 hours          │                       │
       ↓                        │                       │
┌─────────────────┐             │                       │
│  SimpleFIN API  │─────────────┴───────────────────────┘
│   (via fetch)   │
└─────────────────┘
```

## Project Structure

```
networth/
├── src/
│   └── server.ts           # Main application
├── dist/                   # Compiled JavaScript
├── data/
│   └── networth-history.json  # Historical data
├── logs/
│   ├── out.log            # PM2 stdout
│   └── err.log            # PM2 stderr
├── .env                   # SimpleFIN credentials (not in git)
├── ecosystem.config.cjs   # PM2 configuration
├── package.json
├── tsconfig.json
└── README.md
```

## SimpleFIN Compliance

This application meets all SimpleFIN protocol requirements:
- ✅ Handles 403 responses appropriately
- ✅ Notifies users of potentially compromised tokens
- ✅ Only uses HTTPS/TLS connections
- ✅ Stores credentials securely
- ✅ Sanitizes error messages
- ✅ Verifies SSL/TLS certificates

## Resources

- [SimpleFIN Protocol](https://www.simplefin.org/protocol.html)
- [SimpleFIN Bridge](https://beta-bridge.simplefin.org/)
- [PM2 Documentation](https://pm2.keymetrics.io/)