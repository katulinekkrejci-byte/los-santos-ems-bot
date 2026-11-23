# Los Santos EMS — Discord bot + web API

This is the first secure foundation for the EMS internal website. It uses:
- Discord OAuth2 for sign-in
- The Discord bot to verify that a signed-in account is currently in your EMS server
- PostgreSQL for shared persistent data (not Supabase)
- Express for the API used by the Netlify website

## Important
Do not publish your bot token, Discord client secret, database URL, or session secret.
Never put these secrets in the Netlify frontend. Add them only as Render environment variables.

## 1. Discord Developer Portal
In your application:
1. OAuth2 → General: add the exact callback URL after Render gives you a service URL:
   `https://YOUR-RENDER-SERVICE.onrender.com/auth/discord/callback`
2. OAuth2 → URL Generator: scopes `identify` and `guilds` are used by login. The bot invite also needs `bot` and `applications.commands`.
3. Copy the Application ID and Client Secret into Render environment variables.
4. Bot → Reset Token only if you need a new token. Store it only in Render.
5. Make sure the bot is in your EMS Discord server.

## 2. Deploy
Push this repository to GitHub, then in Render choose New → Blueprint and connect this repository.
The Blueprint creates a web service and PostgreSQL database. Check the current plan and price before confirming database creation; Render's database plans and pricing can change.

Set these Render environment variables:
- `DISCORD_CLIENT_ID`: Application ID
- `DISCORD_CLIENT_SECRET`: OAuth2 Client Secret
- `DISCORD_BOT_TOKEN`: Bot token
- `DISCORD_GUILD_ID`: ID of your EMS Discord server
- `DISCORD_REDIRECT_URI`: `https://YOUR-RENDER-SERVICE.onrender.com/auth/discord/callback`
- `EMS_CHIEF_ROLE_IDS`: comma-separated Discord role IDs for Chief of EMS
- `EMS_DEPUTY_ROLE_IDS`: comma-separated Discord role IDs for Deputy Chief
- `EMS_REQUEST_CHANNEL_ID`: optional channel ID for new department requests

In Discord Developer Portal → OAuth2 → General, add the same redirect URI exactly.

## 3. First endpoints
- `GET /health` — health check
- `GET /auth/discord` — starts Discord login
- `GET /auth/discord/callback` — Discord login callback
- `GET /api/me` — current signed-in Discord member and permissions
- `GET /api/departments` — five seeded departments and their internal ranks
- `POST /api/department-requests` — create a request to join a department

The first version intentionally does not yet expose broad editing or medical-record endpoints. Those need per-department authorization and audit logging before being enabled.

## 4. Department request body
Authenticated browser request:
```json
{ "departmentCode": "GENERAL_EMS", "message": "I would like to join." }
```

## 5. Next
After deployment, connect the existing Netlify website to this API URL. Then add department administration, member assignments, galleries, uniforms, vehicles, learning materials, and medical/veterinary records with role checks.
