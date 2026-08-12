import crypto from "node:crypto";

const GOOGLE_MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const GOOGLE_CONNECTION_ID = true;
const OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

export function googleMeetConfiguration() {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY"];
  const missing = required.filter((name) => !String(process.env[name] || "").trim());
  return { ready: missing.length === 0, missing };
}

export function registerGoogleMeetApi({ app, supabase, authenticate, requireAdmin, handler, postMessage, audit }) {
  function appOrigin(request) {
    const configured = String(process.env.APP_URL || "").split(",")[0].trim().replace(/\/$/, "");
    return configured || `${request.protocol}://${request.get("host")}`;
  }

  function redirectUri(request) {
    return String(process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim()
      || `${appOrigin(request)}/api/google/oauth/callback`;
  }

  function encryptionKey() {
    return crypto.createHash("sha256").update(String(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "")).digest();
  }

  function encryptToken(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  function decryptToken(value) {
    const [version, ivValue, tagValue, encryptedValue] = String(value || "").split(".");
    if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("The stored Google token is invalid.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
  }

  function signOAuthState(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", encryptionKey()).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  function verifyOAuthState(value) {
    const [encoded, suppliedSignature] = String(value || "").split(".");
    if (!encoded || !suppliedSignature) throw new Error("Google authorization state is missing.");
    const expectedSignature = crypto.createHmac("sha256", encryptionKey()).update(encoded).digest("base64url");
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new Error("Google authorization state is invalid.");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.userId || !payload.issuedAt || Date.now() - Number(payload.issuedAt) > OAUTH_STATE_MAX_AGE_MS) {
      throw new Error("Google authorization expired. Start the connection again.");
    }
    return payload;
  }

  async function googleTokenRequest(parameters) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload.error_description || payload.error || `Google OAuth returned ${response.status}.`;
      throw Object.assign(new Error(`Google OAuth token request failed: ${detail}`), {
        statusCode: 502,
        publicMessage: `Google authorization failed: ${detail}. Disconnect and reconnect the Google account, then try again.`,
      });
    }
    return payload;
  }

  async function connectionRecord() {
    const { data, error } = await supabase
      .from("google_meet_connections")
      .select("id,connected_by,google_email,encrypted_refresh_token,scopes,created_at,updated_at")
      .eq("id", GOOGLE_CONNECTION_ID)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function freshAccessToken(connection) {
    let refreshToken;
    try {
      refreshToken = decryptToken(connection.encrypted_refresh_token);
    } catch (error) {
      throw Object.assign(new Error(`Google refresh token decryption failed: ${error.message}`), {
        statusCode: 500,
        publicMessage: "The Google connection no longer matches GOOGLE_TOKEN_ENCRYPTION_KEY. Disconnect Google Meet, connect it again, and do not change the encryption key afterward.",
      });
    }
    const token = await googleTokenRequest({
      client_id: process.env.GOOGLE_CLIENT_ID.trim(),
      client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (!token.access_token) throw Object.assign(new Error("Google did not return an access token."), {
      statusCode: 502,
      publicMessage: "Google did not return an access token. Disconnect and reconnect the Google account.",
    });
    return token.access_token;
  }

  async function ensureMeetingsChannel(createdBy) {
    const { data: existing, error: lookupError } = await supabase
      .from("channels")
      .select("id,name")
      .eq("name", "meetings")
      .is("parent_id", null)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return existing;
    const { data, error } = await supabase.from("channels").insert({
      name: "meetings",
      description: "Create and join Vine Solutions Google Meet sessions.",
      created_by: createdBy,
    }).select("id,name").single();
    if (error) throw error;
    return data;
  }

  async function validateMeetingTarget(request) {
    const channelId = String(request.body?.channelId || "").trim() || null;
    const directUserId = String(request.body?.directUserId || "").trim() || null;
    if (channelId && directUserId) throw Object.assign(new Error("Choose a channel or a direct conversation, not both."), { statusCode: 400 });

    if (directUserId) {
      if (directUserId === request.vineUser.profile.id) throw Object.assign(new Error("Choose another Vine member."), { statusCode: 400 });
      const { data: recipient } = await supabase.from("profiles").select("id,member_status").eq("id", directUserId).maybeSingle();
      if (!recipient || recipient.member_status !== "active") throw Object.assign(new Error("The direct-message recipient is not available."), { statusCode: 404 });
      return { scope: "direct", channelId: null, directUserId };
    }

    if (channelId) {
      const { data: channel } = await supabase.from("channels").select("id,visibility,created_by,channel_type").eq("id", channelId).maybeSingle();
      if (!channel || channel.channel_type === "files") throw Object.assign(new Error("The meeting channel is not available."), { statusCode: 404 });
      if (channel.visibility === "private" && request.vineUser.profile.role !== "admin" && channel.created_by !== request.vineUser.profile.id) {
        const { data: membership } = await supabase.from("channel_members").select("user_id").eq("channel_id", channelId).eq("user_id", request.vineUser.profile.id).maybeSingle();
        if (!membership) throw Object.assign(new Error("You do not have access to this private channel."), { statusCode: 403 });
      }
      return { scope: "channel", channelId, directUserId: null };
    }

    const meetingsChannel = await ensureMeetingsChannel(request.vineUser.profile.id);
    return { scope: "workspace", channelId: meetingsChannel.id, directUserId: null };
  }

  app.get("/api/google/status", authenticate, handler(async (_request, response) => {
    const config = googleMeetConfiguration();
    if (!config.ready) return response.json({ configured: false, connected: false, missing: config.missing });
    const connection = await connectionRecord();
    response.setHeader("Cache-Control", "no-store");
    response.json({
      configured: true,
      connected: Boolean(connection),
      email: connection?.google_email || null,
      connectedBy: connection?.connected_by || null,
      connectedAt: connection?.updated_at || connection?.created_at || null,
    });
  }));

  app.post("/api/google/oauth/start", authenticate, requireAdmin, handler(async (request, response) => {
    const config = googleMeetConfiguration();
    if (!config.ready) return response.status(503).json({ error: `Add these Hostinger variables first: ${config.missing.join(", ")}.` });
    const state = signOAuthState({
      userId: request.vineUser.profile.id,
      issuedAt: Date.now(),
      nonce: crypto.randomBytes(18).toString("base64url"),
    });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID.trim(),
      redirect_uri: redirectUri(request),
      response_type: "code",
      scope: `openid email ${GOOGLE_MEET_SCOPE}`,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    }).toString();
    response.setHeader("Cache-Control", "no-store");
    response.json({ authorizationUrl: authorizationUrl.toString(), redirectUri: redirectUri(request) });
  }));

  app.get("/api/google/oauth/callback", async (request, response) => {
    const target = new URL(appOrigin(request));
    try {
      const config = googleMeetConfiguration();
      if (!config.ready) throw new Error(`Hostinger is missing: ${config.missing.join(", ")}.`);
      if (request.query.error) throw new Error(String(request.query.error_description || request.query.error));
      const state = verifyOAuthState(request.query.state);
      const { data: admin } = await supabase.from("profiles").select("id,email,role,member_status").eq("id", state.userId).maybeSingle();
      if (!admin || admin.role !== "admin" || admin.member_status !== "active") throw new Error("The Vine administrator is no longer active.");
      const code = String(request.query.code || "");
      if (!code) throw new Error("Google did not return an authorization code.");
      const token = await googleTokenRequest({
        client_id: process.env.GOOGLE_CLIENT_ID.trim(),
        client_secret: process.env.GOOGLE_CLIENT_SECRET.trim(),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri(request),
      });
      const existing = await connectionRecord();
      const refreshToken = token.refresh_token || (existing ? decryptToken(existing.encrypted_refresh_token) : "");
      if (!refreshToken) throw new Error("Google did not issue a refresh token. Reconnect and approve access when prompted.");

      let googleEmail = existing?.google_email || admin.email;
      if (token.access_token) {
        const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const userInfo = await userInfoResponse.json().catch(() => ({}));
        if (userInfoResponse.ok && userInfo.email) googleEmail = String(userInfo.email).toLowerCase();
      }
      const { error } = await supabase.from("google_meet_connections").upsert({
        id: GOOGLE_CONNECTION_ID,
        connected_by: admin.id,
        google_email: googleEmail,
        encrypted_refresh_token: encryptToken(refreshToken),
        scopes: String(token.scope || GOOGLE_MEET_SCOPE).split(/\s+/).filter(Boolean),
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
      if (error) throw error;
      await ensureMeetingsChannel(admin.id);
      await supabase.from("audit_logs").insert({
        actor_id: admin.id,
        action: "google_meet.connect",
        entity_type: "integration",
        entity_id: "google-meet",
        summary: `Connected Google Meet as ${googleEmail}`,
      });
      target.searchParams.set("google", "connected");
    } catch (error) {
      console.error("Google OAuth callback failed:", error);
      target.searchParams.set("google", "error");
      target.searchParams.set("reason", String(error.message || "Google connection failed.").slice(0, 180));
    }
    response.redirect(303, target.toString());
  });

  app.delete("/api/google/connection", authenticate, requireAdmin, handler(async (request, response) => {
    const connection = await connectionRecord();
    if (connection) {
      try {
        const token = decryptToken(connection.encrypted_refresh_token);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      } catch (error) {
        console.warn("Google token revocation failed; removing the local connection:", error.message);
      }
      const { error } = await supabase.from("google_meet_connections").delete().eq("id", GOOGLE_CONNECTION_ID);
      if (error) throw error;
      await audit(request, "google_meet.disconnect", "integration", "google-meet", "Disconnected Google Meet");
    }
    response.json({ ok: true });
  }));

  app.get("/api/google/meetings", authenticate, handler(async (request, response) => {
    const { data, error } = await supabase
      .from("google_meet_spaces")
      .select("id,google_space_name,meeting_uri,meeting_code,title,scope,channel_id,direct_user_id,created_by,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const userId = request.vineUser.profile.id;
    const channelIds = [...new Set((data || []).map((meeting) => meeting.channel_id).filter(Boolean))];
    const privateChannelIds = new Set();
    const workspaceChannelIds = new Set();
    const [{ data: memberships }, { data: channels }] = await Promise.all([
      supabase.from("channel_members").select("channel_id").eq("user_id", userId),
      channelIds.length
        ? supabase.from("channels").select("id,visibility,created_by").in("id", channelIds)
        : Promise.resolve({ data: [] }),
    ]);
    (memberships || []).forEach((item) => privateChannelIds.add(item.channel_id));
    (channels || []).forEach((channel) => {
      if (channel.visibility !== "private" || channel.created_by === userId) workspaceChannelIds.add(channel.id);
    });
    const visible = (data || []).filter((meeting) => {
      if (request.vineUser.profile.role === "admin" || meeting.created_by === userId) return true;
      if (meeting.scope === "direct") return meeting.direct_user_id === userId;
      if (!meeting.channel_id) return true;
      return privateChannelIds.has(meeting.channel_id) || workspaceChannelIds.has(meeting.channel_id) || meeting.scope === "workspace";
    });
    response.setHeader("Cache-Control", "no-store");
    response.json({ meetings: visible });
  }));

  app.post("/api/google/meetings", authenticate, handler(async (request, response) => {
    const config = googleMeetConfiguration();
    if (!config.ready) return response.status(503).json({ error: `Google Meet needs: ${config.missing.join(", ")}.` });
    const connection = await connectionRecord();
    if (!connection) return response.status(409).json({ error: "An administrator must connect the company Google account first." });
    const target = await validateMeetingTarget(request);
    const title = String(request.body?.title || "Vine Connect meeting").trim().slice(0, 120) || "Vine Connect meeting";
    const accessToken = await freshAccessToken(connection);
    const googleResponse = await fetch("https://meet.googleapis.com/v2/spaces", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          accessType: "OPEN",
          entryPointAccess: "ALL",
        },
      }),
    });
    const googleSpace = await googleResponse.json().catch(() => ({}));
    if (!googleResponse.ok || !googleSpace.meetingUri || !googleSpace.name) {
      const detail = googleSpace?.error?.message || `Google Meet returned ${googleResponse.status}.`;
      const reason = googleSpace?.error?.details?.find?.((item) => item?.reason)?.reason;
      throw Object.assign(new Error(`Google Meet spaces.create failed (${googleResponse.status}): ${detail}${reason ? ` [${reason}]` : ""}`), {
        statusCode: 502,
        publicMessage: `Google Meet could not create the meeting: ${detail}${reason ? ` (${reason})` : ""}.`,
      });
    }
    const { data: meeting, error } = await supabase.from("google_meet_spaces").insert({
      google_space_name: googleSpace.name,
      meeting_uri: googleSpace.meetingUri,
      meeting_code: googleSpace.meetingCode || null,
      title,
      scope: target.scope,
      channel_id: target.channelId,
      direct_user_id: target.directUserId,
      created_by: request.vineUser.profile.id,
    }).select("id,google_space_name,meeting_uri,meeting_code,title,scope,channel_id,direct_user_id,created_by,created_at").single();
    if (error) throw error;

    let deliveryWarning = null;
    try {
      await postMessage({
        sender: request.vineUser.profile,
        messageType: target.scope === "direct" ? "direct" : "channel",
        channelId: target.channelId,
        recipientId: target.directUserId,
        body: `🎥 **${title}**\nJoin Google Meet: ${googleSpace.meetingUri}`,
        attachments: [],
      });
    } catch (error) {
      deliveryWarning = "The Meet link was created, but it could not be posted automatically.";
      console.warn("Google Meet link delivery failed:", error.message);
    }
    await audit(request, "google_meet.create", "meeting", meeting.id, `Created Google Meet: ${title}`, {
      googleSpaceName: googleSpace.name,
      scope: target.scope,
      channelId: target.channelId,
      directUserId: target.directUserId,
    });
    response.status(201).json({ meeting, deliveryWarning });
  }));
}
