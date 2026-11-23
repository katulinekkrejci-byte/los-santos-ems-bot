require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pg = require("pg");
const PgSession = require("connect-pg-simple")(session);
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events
} = require("discord.js");

const required = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_REDIRECT_URI"
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Missing environment variables:", missing.join(", "));
  process.exit(1);
}

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const departments = [
  {
    code: "GENERAL_EMS",
    name: "General EMS",
    description: "Základní zdravotnická služba, výjezdy, ošetření a transport pacientů.",
    ranks: ["General EMS Director", "Senior EMS Provider", "EMS Provider"]
  },
  {
    code: "SURGERY_TEAM",
    name: "Surgery Team",
    description: "Chirurgie, operace, nemocniční péče a specializované zákroky.",
    ranks: ["Chief of Surgery", "Senior Surgeon", "Surgeon"]
  },
  {
    code: "AIR_OPERATIONS",
    name: "Air Operations",
    description: "Letecká záchranná služba a letecký transport pacientů.",
    ranks: ["Director of Air Operations", "Senior Flight Paramedic", "Flight Paramedic"]
  },
  {
    code: "VETERINARY",
    name: "Veterinary",
    description: "Veterinární péče, služební psi a zdravotní záznamy zvířat.",
    ranks: ["Veterinary Director", "Senior Veterinary Specialist", "Veterinary Specialist"]
  },
  {
    code: "TACTICAL_EMS",
    name: "Tactical EMS",
    description: "Taktická zdravotnická podpora a spolupráce s bezpečnostními složkami.",
    ranks: ["Tactical EMS Commander", "Senior Tactical Medic", "Tactical Medic"]
  }
];

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ems_departments (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ems_department_ranks (
      id SERIAL PRIMARY KEY,
      department_id INTEGER NOT NULL REFERENCES ems_departments(id) ON DELETE CASCADE,
      rank_name TEXT NOT NULL,
      rank_level INTEGER NOT NULL,
      UNIQUE(department_id, rank_name),
      UNIQUE(department_id, rank_level)
    );
    CREATE TABLE IF NOT EXISTS ems_department_requests (
      id SERIAL PRIMARY KEY,
      discord_id TEXT NOT NULL,
      discord_name TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES ems_departments(id),
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ems_members (
      discord_id TEXT PRIMARY KEY,
      discord_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ems_member_departments (
      id SERIAL PRIMARY KEY,
      discord_id TEXT NOT NULL REFERENCES ems_members(discord_id) ON DELETE CASCADE,
      department_id INTEGER NOT NULL REFERENCES ems_departments(id) ON DELETE CASCADE,
      rank_id INTEGER REFERENCES ems_department_ranks(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(discord_id, department_id)
    );
  `);

  for (const dept of departments) {
    const result = await pool.query(
      `INSERT INTO ems_departments(code, name, description)
       VALUES($1, $2, $3)
       ON CONFLICT(code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
       RETURNING id`,
      [dept.code, dept.name, dept.description]
    );
    const departmentId = result.rows[0].id;
    for (let i = 0; i < dept.ranks.length; i++) {
      await pool.query(
        `INSERT INTO ems_department_ranks(department_id, rank_name, rank_level)
         VALUES($1, $2, $3)
         ON CONFLICT(department_id, rank_name) DO UPDATE SET rank_level = EXCLUDED.rank_level`,
        [departmentId, dept.ranks[i], 3 - i]
      );
    }
  }
}

function parseIds(value) {
  return (value || "").split(",").map((x) => x.trim()).filter(Boolean);
}
function hasAnyRole(member, ids) {
  return ids.some((id) => member.roles.includes(id));
}
function getPermissions(member) {
  const chief = hasAnyRole(member, parseIds(process.env.EMS_CHIEF_ROLE_IDS));
  const deputy = hasAnyRole(member, parseIds(process.env.EMS_DEPUTY_ROLE_IDS));
  return { chief, deputy, manageAllDepartments: chief || deputy };
}

async function requireMember(req, res, next) {
  if (!req.session.member) return res.status(401).json({ error: "Přihlas se přes Discord." });
  try {
    const guild = await bot.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const discordMember = await guild.members.fetch(req.session.member.id).catch(() => null);
    if (!discordMember) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Nejsi členem EMS Discord serveru." });
    }
    const member = {
      id: discordMember.id,
      username: discordMember.user.username,
      displayName: discordMember.displayName,
      roles: [...discordMember.roles.cache.keys()]
    };
    req.emsMember = member;
    req.emsPermissions = getPermissions(member);
    next();
  } catch (error) {
    console.error("Member verification failed:", error);
    res.status(503).json({ error: "Nepodařilo se ověřit Discord členství." });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "los-santos-ems" }));

app.get("/auth/discord", (req, res) => {
  const state = require("crypto").randomBytes(24).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Neplatné přihlášení. Zkus to prosím znovu.");
  }
  delete req.session.oauthState;
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed");
    const tokenData = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userResponse.ok) throw new Error("Discord profile lookup failed");
    const user = await userResponse.json();

    const guild = await bot.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return res.status(403).send("Tento Discord účet není členem EMS serveru.");

    req.session.member = { id: user.id };
    await pool.query(
      `INSERT INTO ems_members(discord_id, discord_name, display_name)
       VALUES($1, $2, $3)
       ON CONFLICT(discord_id) DO UPDATE SET discord_name=EXCLUDED.discord_name,
       display_name=EXCLUDED.display_name, updated_at=NOW()`,
      [user.id, user.username, member.displayName]
    );
    res.redirect(process.env.WEBSITE_URL || "/");
  } catch (error) {
    console.error("Discord OAuth callback failed:", error);
    res.status(500).send("Přihlášení přes Discord se nezdařilo.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireMember, (req, res) => {
  res.json({
    id: req.emsMember.id,
    username: req.emsMember.username,
    displayName: req.emsMember.displayName,
    permissions: req.emsPermissions
  });
});

app.get("/api/departments", requireMember, async (_req, res) => {
  const result = await pool.query(`
    SELECT d.id, d.code, d.name, d.description,
      COALESCE(json_agg(json_build_object('id', r.id, 'name', r.rank_name, 'level', r.rank_level)
        ORDER BY r.rank_level DESC) FILTER (WHERE r.id IS NOT NULL), '[]') AS ranks
    FROM ems_departments d
    LEFT JOIN ems_department_ranks r ON r.department_id = d.id
    GROUP BY d.id ORDER BY d.id
  `);
  res.json(result.rows);
});

app.post("/api/department-requests", requireMember, async (req, res) => {
  const { departmentCode, message = "" } = req.body || {};
  if (typeof departmentCode !== "string" || typeof message !== "string" || message.length > 1000) {
    return res.status(400).json({ error: "Neplatné údaje žádosti." });
  }
  const department = await pool.query(
    "SELECT id, name FROM ems_departments WHERE code=$1",
    [departmentCode]
  );
  if (!department.rowCount) return res.status(404).json({ error: "Oddělení nebylo nalezeno." });

  const pending = await pool.query(
    `SELECT id FROM ems_department_requests
     WHERE discord_id=$1 AND department_id=$2 AND status='pending'`,
    [req.emsMember.id, department.rows[0].id]
  );
  if (pending.rowCount) return res.status(409).json({ error: "Žádost už čeká na vyřízení." });

  const inserted = await pool.query(
    `INSERT INTO ems_department_requests(discord_id, discord_name, department_id, message)
     VALUES($1, $2, $3, $4) RETURNING id`,
    [req.emsMember.id, req.emsMember.username, department.rows[0].id, message.trim()]
  );

  const channelId = process.env.EMS_REQUEST_CHANNEL_ID;
  if (channelId) {
    const channel = await bot.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send({
        content: `**Nová žádost o zařazení do oddělení**\nČlen: <@${req.emsMember.id}>\nOddělení: **${department.rows[0].name}**\nZpráva: ${message.trim() || "Bez zprávy"}\nID žádosti: ${inserted.rows[0].id}`
      }).catch((error) => console.error("Request notification failed:", error));
    }
  }
  res.status(201).json({ ok: true, requestId: inserted.rows[0].id });
});

app.get("/api/department-requests", requireMember, async (req, res) => {
  if (!req.emsPermissions.manageAllDepartments) {
    return res.status(403).json({ error: "Nemáš oprávnění zobrazit všechny žádosti." });
  }
  const result = await pool.query(`
    SELECT q.id, q.discord_id, q.discord_name, d.name AS department,
           q.message, q.status, q.created_at
    FROM ems_department_requests q
    JOIN ems_departments d ON d.id=q.department_id
    ORDER BY q.created_at DESC LIMIT 100
  `);
  res.json(result.rows);
});

const port = process.env.PORT || 3000;
async function start() {
  await initializeDatabase();
  await bot.login(process.env.DISCORD_BOT_TOKEN);
  bot.once(Events.ClientReady, (client) => {
    console.log(`Discord bot online as ${client.user.tag}`);
  });
  app.listen(port, () => console.log(`EMS API listening on ${port}`));
}
start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});
