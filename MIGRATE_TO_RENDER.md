# Migrating from Railway to Render

The RecallBricks API has been migrated from Railway to Render. Follow these steps to update your MCP server configuration.

---

## 🔄 What Changed

**Old URL (Railway):**
```
https://recallbricks-api-production.up.railway.app
```

**New URL (Render):**
```
https://recallbricks-api-clean.onrender.com
```

---

## 📋 Migration Steps

### Step 1: Update Claude Desktop Configuration

#### On macOS:
1. Open the Claude Desktop configuration file:
   ```bash
   open ~/Library/Application\ Support/Claude/claude_desktop_config.json
   ```

2. Find the `recallbricks-mcp-simple` server configuration

3. Update the `RECALLBRICKS_API_URL` environment variable:
   ```json
   {
     "mcpServers": {
       "recallbricks-mcp-simple": {
         "command": "node",
         "args": ["/path/to/recallbricks-mcp-simple/dist/index.js"],
         "env": {
           "RECALLBRICKS_API_URL": "https://recallbricks-api-clean.onrender.com",
           "RECALLBRICKS_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

#### On Windows:
1. Open the Claude Desktop configuration file:
   ```
   %APPDATA%\Claude\claude_desktop_config.json
   ```

   Or navigate to:
   ```
   C:\Users\YOUR_USERNAME\AppData\Roaming\Claude\claude_desktop_config.json
   ```

2. Find the `recallbricks-mcp-simple` server configuration

3. Update the `RECALLBRICKS_API_URL` environment variable:
   ```json
   {
     "mcpServers": {
       "recallbricks-mcp-simple": {
         "command": "node",
         "args": ["C:\\Users\\tyler\\Desktop\\recallbricks-mcp-simple\\dist\\index.js"],
         "env": {
           "RECALLBRICKS_API_URL": "https://recallbricks-api-clean.onrender.com",
           "RECALLBRICKS_API_KEY": "your_api_key_here"
         }
       }
     }
   }
   ```

### Step 2: Rebuild the MCP Server

If you haven't already, rebuild the MCP server to get the updated default URL:

```bash
cd /path/to/recallbricks-mcp-simple
npm run build
```

### Step 3: Restart Claude Desktop

Close and restart Claude Desktop to apply the configuration changes.

---

## ✅ Verification

After restarting Claude Desktop, verify the migration was successful:

### 1. Check Health
Use the `get_health` tool in Claude Desktop:
```
Can you check the RecallBricks MCP server health?
```

You should see output like:
```json
{
  "status": "healthy",
  "config": {
    "apiUrl": "https://recallbricks-api-clean.onrender.com"
  }
}
```

### 2. Test Memory Creation
Try creating a memory:
```
Create a memory: "Migration to Render completed successfully"
```

You should see:
```
✅ Memory saved successfully!
```

### 3. Test Memory Query
Try querying memories:
```
Query memories about "Render"
```

---

## 🔍 Troubleshooting

### Issue: Still seeing Railway URL in health check

**Solution:**
1. Double-check `claude_desktop_config.json` was saved correctly
2. Ensure you fully quit and restarted Claude Desktop (not just closed the window)
3. On macOS, use `Cmd+Q` to fully quit
4. On Windows, right-click system tray icon and select "Quit"

### Issue: "Circuit breaker is OPEN" error

**Cause:** The old Railway URL is no longer responding

**Solution:**
1. Update the config file as described above
2. Restart Claude Desktop
3. Wait 60 seconds for the circuit breaker to reset
4. Try again

### Issue: "FATAL: Invalid or missing API key"

**Solution:**
Ensure you have set your API key in the config:
```json
"RECALLBRICKS_API_KEY": "your_actual_api_key_here"
```

### Issue: 404 Not Found errors

**Cause:** API endpoint paths may have changed

**Solution:**
Verify the Render API endpoints match the expected paths:
- `/api/v1/memories` - Create/query memories
- `/health` - Health check

---

## 📊 What's New in the Render Deployment

The Render deployment may include:
- Improved performance
- Better uptime
- Enhanced security
- Automatic scaling

All features of the MCP server remain the same - only the backend URL changed.

---

## 🆘 Still Having Issues?

If you continue to have problems after following these steps:

1. Check the MCP server logs in Claude Desktop
2. Verify the Render API is accessible:
   ```bash
   curl https://recallbricks-api-clean.onrender.com/health
   ```
3. Ensure your API key is valid
4. Try the health check tool: `get_health`

---

## 📝 Summary

**Before:**
```json
"RECALLBRICKS_API_URL": "https://recallbricks-api-production.up.railway.app"
```

**After:**
```json
"RECALLBRICKS_API_URL": "https://recallbricks-api-clean.onrender.com"
```

That's it! Your MCP server is now connected to the new Render deployment. 🚀
