import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
import { registerPlatformApi } from "./server/platform-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = new Set(
  String(process.env.APP_URL || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

const requiredSupabase = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"];
const requiredJaas = ["JAAS_APP_ID", "JAAS_API_KEY_ID", "JAAS_PRIVATE_KEY"];
const missing = (names) => names.filter((name) => !String(process.env[name] || "").trim());

const supabase = missing(requiredSupabase).length
  ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://meet.jit.si", "https://*.jit.si", "https://8x8.vc", "https://*.8x8.vc"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "https:"],
      connectSrc: ["'self'", "https://*.supabase.co", "wss://*.supabase.co", "https://*.jit.si", "wss://*.jit.si", "https://*.8x8.vc", "wss://*.8x8.vc"],
      frameSrc: ["'self'", "https://view.officeapps.live.com", "https://meet.jit.si", "https://*.jit.si", "https://8x8.vc", "https://*.8x8.vc"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));
app.use(express.json({ limit: "256kb" }));
app.use(compression());

app.use((request, response, next) => {
  const origin = String(request.headers.origin || "").replace(/\/$/, "");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (request.method === "OPTIONS") return response.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403);
  next();
});

const meetingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many meeting requests. Wait one minute and try again." },
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "vine-connect",
    supabaseConfigured: missing(requiredSupabase).length === 0,
    jaasConfigured: missing(requiredJaas).length === 0,
    pushConfigured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  });
});

app.get("/supabase-config.js", (request, response, next) => {
  const publicUrl = String(process.env.SUPABASE_URL || "").trim();
  const publicKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (!publicUrl || !publicKey) return next();
  response.type("application/javascript");
  response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  response.send(`window.VINE_SUPABASE_CONFIG = Object.freeze(${JSON.stringify({
    url: publicUrl,
    publishableKey: publicKey,
    meetingApiUrl: "",
  })});`);
});

async function authenticate(request, response, next) {
  if (!supabase) return response.status(503).json({ error: `Server setup is incomplete: ${missing(requiredSupabase).join(", ")}.` });
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return response.status(401).json({ error: "Sign in to Vine Connect first." });

  const { data, error } = await supabase.auth.getUser(match[1]);
  if (error || !data?.user) return response.status(401).json({ error: "Your Vine Connect session is no longer valid." });
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id,email,display_name,role,job_title,member_status,last_active_at")
    .eq("id", data.user.id)
    .single();
  if (profileError || !profile) return response.status(403).json({ error: "Your Vine Connect profile is not active." });
  if (profile.member_status && profile.member_status !== "active") {
    return response.status(403).json({ error: "This Vine Connect account is suspended. Contact an administrator." });
  }
  request.vineUser = { authUser: data.user, profile };
  next();
}

registerPlatformApi({ app, supabase, authenticate });

app.post("/api/meetings/join-token", meetingLimiter, authenticate, async (request, response) => {
  const missingJaas = missing(requiredJaas);
  if (missingJaas.length) return response.status(503).json({ error: `Secure meetings need: ${missingJaas.join(", ")}.` });

  const roomName = String(request.body?.roomName || "").trim();
  const meetingId = String(request.body?.meetingId || "").trim();
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(roomName)) {
    return response.status(400).json({ error: "The meeting room name is invalid." });
  }

  const { profile } = request.vineUser;
  let meeting = null;
  if (meetingId) {
    if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return response.status(400).json({ error: "The meeting ID is invalid." });
    const { data, error } = await supabase
      .from("meetings")
      .select("id,room_name,host_id,status")
      .eq("id", meetingId)
      .single();
    if (error || !data || data.room_name !== roomName) return response.status(404).json({ error: "Meeting not found." });
    if (data.status === "cancelled") return response.status(409).json({ error: "This meeting was cancelled." });

    const { data: invitation } = await supabase
      .from("meeting_participants")
      .select("meeting_id")
      .eq("meeting_id", data.id)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!invitation && data.host_id !== profile.id && profile.role !== "admin") {
      return response.status(403).json({ error: "You are not invited to this meeting." });
    }
    meeting = data;
  }

  const appId = process.env.JAAS_APP_ID.trim();
  const rawKeyId = process.env.JAAS_API_KEY_ID.trim();
  const keyId = rawKeyId.includes("/") ? rawKeyId : `${appId}/${rawKeyId}`;
  const privateKey = process.env.JAAS_PRIVATE_KEY.replace(/\\n/g, "\n").trim();
  const now = Math.floor(Date.now() / 1000);
  const moderator = profile.role === "admin" || meeting?.host_id === profile.id;
  const token = jwt.sign(
    {
      aud: "jitsi",
      iss: "chat",
      sub: appId,
      room: roomName,
      nbf: now - 10,
      exp: now + 2 * 60 * 60,
      context: {
        user: {
          id: profile.id,
          name: profile.display_name || profile.email.split("@")[0],
          email: profile.email,
          avatar: "",
          moderator: moderator ? "true" : "false",
        },
        features: {
          livestreaming: false,
          recording: false,
          transcription: false,
          "outbound-call": false,
          "file-upload": true,
          "list-visitors": moderator,
        },
        room: { regex: false },
      },
    },
    privateKey,
    { algorithm: "RS256", keyid: keyId, header: { typ: "JWT" } },
  );

  const encodedAppId = encodeURIComponent(appId);
  const encodedRoom = encodeURIComponent(roomName);
  response.setHeader("Cache-Control", "no-store");
  response.json({
    provider: "jaas",
    domain: "8x8.vc",
    roomName: `${appId}/${roomName}`,
    jwt: token,
    externalApiUrl: `https://8x8.vc/${encodedAppId}/external_api.js`,
    meetingUrl: `https://8x8.vc/${encodedAppId}/${encodedRoom}?jwt=${encodeURIComponent(token)}`,
  });
});

function webhookAuthorized(request) {
  const expected = String(process.env.JAAS_WEBHOOK_SECRET || "");
  const supplied = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

app.post("/api/meetings/webhook", async (request, response) => {
  if (!supabase || !webhookAuthorized(request)) return response.status(401).json({ error: "Webhook authorization failed." });
  const event = request.body || {};
  if (!event.idempotencyKey || !event.eventType || !event.timestamp) {
    return response.status(400).json({ error: "Webhook payload is incomplete." });
  }
  const roomName = String(event.fqn || "").split("/").slice(1).join("/");
  const { data: meeting } = roomName
    ? await supabase.from("meetings").select("id").eq("room_name", roomName).maybeSingle()
    : { data: null };
  const occurredAt = new Date(Number(event.timestamp) > 1e12 ? Number(event.timestamp) : Number(event.timestamp) * 1000);
  const { error } = await supabase.from("meeting_events").upsert({
    idempotency_key: String(event.idempotencyKey),
    meeting_id: meeting?.id || null,
    event_type: String(event.eventType),
    session_id: event.sessionId ? String(event.sessionId) : null,
    participant_id: event.data?.participantId ? String(event.data.participantId) : null,
    fqn: event.fqn ? String(event.fqn) : null,
    occurred_at: Number.isFinite(occurredAt.getTime()) ? occurredAt.toISOString() : new Date().toISOString(),
    payload: event,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) return response.status(500).json({ error: "Webhook event could not be recorded." });
  response.sendStatus(204);
});

app.use(express.static(__dirname, {
  dotfiles: "deny",
  index: "index.html",
  etag: true,
  maxAge: isProduction ? "1h" : 0,
  setHeaders(response, filePath) {
    if (filePath.endsWith("index.html") || filePath.endsWith("supabase-config.js") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) {
      response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

app.use((request, response) => {
  if (request.path.startsWith("/api/")) return response.status(404).json({ error: "API route not found." });
  response.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  const status = Number(error?.statusCode || error?.status || 500);
  response.status(status).json({ error: status < 500 ? String(error.message || "Request failed.") : "Vine Connect encountered a server error." });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Vine Connect is running on port ${port}.`);
});

export { app, server };
