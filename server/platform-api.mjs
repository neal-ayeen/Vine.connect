import crypto from "node:crypto";
import { rateLimit } from "express-rate-limit";
import webpush from "web-push";
import { registerGoogleMeetApi } from "./google-meet-api.mjs";

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const ALLOWED_MEMBER_ROLES = new Set(["employee", "admin"]);
const ALLOWED_MEMBER_STATUSES = new Set(["active", "suspended", "terminated"]);
const ALLOWED_FILE_PREFIXES = ["image/", "video/", "audio/"];
const ALLOWED_FILE_TYPES = new Set([
  "application/pdf", "text/plain", "text/csv", "application/zip",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function registerPlatformApi({ app, supabase, authenticate }) {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many requests. Wait one minute and try again." },
  });
  app.use("/api", apiLimiter);

  const vapidConfigured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (vapidConfigured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:admin@vinesolutions.com",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  }

  function requireAdmin(request, response, next) {
    if (request.vineUser?.profile?.role !== "admin") return response.status(403).json({ error: "Administrator access is required." });
    next();
  }

  function handler(fn) {
    return async (request, response, next) => {
      try {
        await fn(request, response);
      } catch (error) {
        next(error);
      }
    };
  }

  async function audit(request, action, entityType, entityId, summary, metadata = {}) {
    if (!supabase) return;
    await supabase.from("audit_logs").insert({
      actor_id: request?.vineUser?.profile?.id || null,
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      summary,
      metadata,
      ip_address: String(request?.ip || "").slice(0, 80) || null,
    });
  }

  function temporaryPassword() {
    return `V!${crypto.randomBytes(15).toString("base64url")}9a`;
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function memberName(profile) {
    return profile?.display_name || profile?.email?.split("@")[0] || "Vine member";
  }

  function publicMember(profile) {
    return profile ? {
      id: profile.id,
      email: profile.email,
      displayName: profile.display_name,
      jobTitle: profile.job_title,
      role: profile.role,
      status: profile.member_status || "active",
    } : null;
  }

  async function pushToUsers(userIds, payload, preferenceKey) {
    if (!supabase || !vapidConfigured || !userIds.length) return { sent: 0 };
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    const [{ data: subscriptions }, { data: preferences }] = await Promise.all([
      supabase.from("push_subscriptions").select("id,user_id,subscription").in("user_id", uniqueIds),
      supabase.from("notification_preferences").select("user_id,direct_messages,mentions,rings,channel_messages").in("user_id", uniqueIds),
    ]);
    const preferenceMap = new Map((preferences || []).map((item) => [item.user_id, item]));
    let sent = 0;
    await Promise.all((subscriptions || []).map(async (item) => {
      const preference = preferenceMap.get(item.user_id);
      if (preference && preferenceKey && preference[preferenceKey] === false) return;
      if (!preference && preferenceKey === "channel_messages") return;
      try {
        await webpush.sendNotification(item.subscription, JSON.stringify(payload), { TTL: 60 * 60, urgency: payload.kind === "ring" ? "high" : "normal" });
        sent += 1;
        await supabase.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", item.id);
      } catch (error) {
        if ([404, 410].includes(error?.statusCode)) await supabase.from("push_subscriptions").delete().eq("id", item.id);
      }
    }));
    return { sent };
  }

  async function channelRecipients(channel, senderId, body) {
    let ids = [];
    if (channel.visibility === "private") {
      const { data } = await supabase.from("channel_members").select("user_id").eq("channel_id", channel.id);
      ids = (data || []).map((item) => item.user_id);
    } else {
      const { data } = await supabase.from("profiles").select("id").eq("member_status", "active");
      ids = (data || []).map((item) => item.id);
    }
    ids = ids.filter((id) => id !== senderId);
    if (!body.includes("@")) return { ids, preferenceKey: "channel_messages" };
    const { data: members } = await supabase.from("profiles").select("id,email,display_name").in("id", ids);
    const mentioned = (members || []).filter((member) => {
      const handle = String(member.display_name || member.email.split("@")[0]).trim().replace(/\s+/g, "");
      return new RegExp(`(^|\\s)@${escapeRegExp(handle)}(?=\\s|[.,!?;:]|$)`, "i").test(body);
    }).map((member) => member.id);
    return mentioned.length ? { ids: mentioned, preferenceKey: "mentions" } : { ids, preferenceKey: "channel_messages" };
  }

  async function postMessage({ sender, messageType, channelId, recipientId, body, attachments }) {
    if (messageType === "direct") {
      const { data: recipient } = await supabase.from("profiles").select("id,member_status").eq("id", recipientId).single();
      if (!recipient || recipient.member_status !== "active" || recipient.id === sender.id) throw Object.assign(new Error("The recipient is not available."), { statusCode: 400 });
      const { data, error } = await supabase.from("direct_messages").insert({
        sender_id: sender.id, recipient_id: recipientId, body, attachments,
      }).select("id,sender_id,recipient_id,body,attachments,created_at").single();
      if (error) throw error;
      await pushToUsers([recipientId], {
        title: memberName(sender), body: body || "Shared an attachment", kind: "direct",
        url: `/?direct=${encodeURIComponent(sender.id)}`, tag: `dm-${sender.id}`,
      }, "direct_messages");
      return data;
    }

    const { data: channel, error: channelError } = await supabase
      .from("channels").select("id,name,visibility,posting_policy,channel_type,created_by").eq("id", channelId).single();
    if (channelError || !channel || channel.channel_type !== "chat") throw Object.assign(new Error("The channel is not available."), { statusCode: 404 });
    if (channel.posting_policy === "admins" && sender.role !== "admin") throw Object.assign(new Error("Only admins can post in this channel."), { statusCode: 403 });
    if (channel.visibility === "private" && sender.role !== "admin" && channel.created_by !== sender.id) {
      const { data: membership } = await supabase.from("channel_members").select("user_id").eq("channel_id", channel.id).eq("user_id", sender.id).maybeSingle();
      if (!membership) throw Object.assign(new Error("You do not have access to this private channel."), { statusCode: 403 });
    }
    const { data, error } = await supabase.from("messages").insert({
      channel_id: channel.id, author_id: sender.id, body, attachments,
    }).select("id,channel_id,author_id,body,attachments,created_at").single();
    if (error) throw error;
    const recipients = await channelRecipients(channel, sender.id, body);
    await pushToUsers(recipients.ids, {
      title: `#${channel.name} · ${memberName(sender)}`,
      body: body || "Shared an attachment", kind: recipients.preferenceKey === "mentions" ? "mention" : "channel",
      url: `/?channel=${encodeURIComponent(channel.id)}&message=${encodeURIComponent(data.id)}`,
      tag: `channel-${channel.id}`,
    }, recipients.preferenceKey);
    return data;
  }

  registerGoogleMeetApi({ app, supabase, authenticate, requireAdmin, handler, postMessage, audit });

  app.post("/api/session/heartbeat", authenticate, handler(async (request, response) => {
    const now = new Date().toISOString();
    const firstLogin = !request.vineUser.profile.last_login_at;
    await supabase.from("profiles").update({ last_active_at: now, ...(firstLogin ? { last_login_at: now } : {}) }).eq("id", request.vineUser.profile.id);
    response.json({ ok: true, at: now });
  }));

  app.get("/api/notifications/vapid-public-key", authenticate, (_request, response) => {
    if (!vapidConfigured) return response.status(503).json({ error: "Push notifications are not configured on Hostinger." });
    response.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  });

  app.post("/api/notifications/subscribe", authenticate, handler(async (request, response) => {
    const subscription = request.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys) return response.status(400).json({ error: "The push subscription is invalid." });
    const { error } = await supabase.from("push_subscriptions").upsert({
      user_id: request.vineUser.profile.id,
      endpoint: subscription.endpoint,
      subscription,
      user_agent: String(request.headers["user-agent"] || "").slice(0, 500),
      last_used_at: new Date().toISOString(),
    }, { onConflict: "endpoint" });
    if (error) throw error;
    response.json({ ok: true });
  }));

  app.delete("/api/notifications/subscribe", authenticate, handler(async (request, response) => {
    const endpoint = String(request.body?.endpoint || "");
    if (endpoint) await supabase.from("push_subscriptions").delete().eq("user_id", request.vineUser.profile.id).eq("endpoint", endpoint);
    response.json({ ok: true });
  }));

  app.post("/api/notifications/ring", authenticate, handler(async (request, response) => {
    const recipientId = String(request.body?.recipientId || "");
    if (!recipientId || recipientId === request.vineUser.profile.id) return response.status(400).json({ error: "Choose another Vine member." });
    const { data: ring, error } = await supabase.from("member_rings").insert({
      sender_id: request.vineUser.profile.id, recipient_id: recipientId,
    }).select("id,created_at").single();
    if (error) throw error;
    await pushToUsers([recipientId], {
      title: `${memberName(request.vineUser.profile)} is ringing you`,
      body: "Open Vine Connect to check your messages.", kind: "ring", url: `/?direct=${encodeURIComponent(request.vineUser.profile.id)}`, tag: `ring-${request.vineUser.profile.id}`,
    }, "rings");
    response.json({ ring });
  }));

  app.post("/api/messages", authenticate, handler(async (request, response) => {
    const messageType = request.body?.messageType === "direct" ? "direct" : "channel";
    const body = String(request.body?.body || "").trim().slice(0, 10000);
    const attachments = Array.isArray(request.body?.attachments) ? request.body.attachments.slice(0, 20) : [];
    if (!body && !attachments.length) return response.status(400).json({ error: "Write a message or attach a file." });
    const scheduledFor = request.body?.scheduledFor ? new Date(request.body.scheduledFor) : null;
    const target = {
      messageType,
      channelId: messageType === "channel" ? String(request.body?.channelId || "") : null,
      recipientId: messageType === "direct" ? String(request.body?.recipientId || "") : null,
    };
    if (scheduledFor && Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 60 * 1000) {
      const { data, error } = await supabase.from("scheduled_messages").insert({
        sender_id: request.vineUser.profile.id,
        message_type: messageType,
        channel_id: target.channelId,
        recipient_id: target.recipientId,
        body,
        attachments,
        scheduled_for: scheduledFor.toISOString(),
      }).select("id,scheduled_for,status").single();
      if (error) throw error;
      return response.status(201).json({ scheduled: true, message: data });
    }
    const message = await postMessage({ sender: request.vineUser.profile, ...target, body, attachments });
    response.status(201).json({ scheduled: false, message });
  }));

  app.delete("/api/messages/:messageType/:id/attachments", authenticate, handler(async (request, response) => {
    const messageType = request.params.messageType;
    if (!new Set(["channel", "direct"]).has(messageType)) return response.status(400).json({ error: "The message type is invalid." });
    const table = messageType === "direct" ? "direct_messages" : "messages";
    const authorColumn = messageType === "direct" ? "sender_id" : "author_id";
    const { data: message, error: messageError } = await supabase
      .from(table)
      .select(`id,body,attachments,${authorColumn}`)
      .eq("id", request.params.id)
      .single();
    if (messageError || !message) return response.status(404).json({ error: "Message not found." });
    if (message[authorColumn] !== request.vineUser.profile.id && request.vineUser.profile.role !== "admin") {
      return response.status(403).json({ error: "Only the sender or an administrator can delete this file." });
    }

    const attachmentId = String(request.body?.attachmentId || "");
    const attachmentPath = String(request.body?.path || "");
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const attachment = attachments.find((item) => (
      (attachmentId && String(item?.id || "") === attachmentId)
      || (attachmentPath && String(item?.path || "") === attachmentPath)
    ));
    if (!attachment?.path) return response.status(404).json({ error: "The file is no longer attached to this message." });

    const nextAttachments = attachments.filter((item) => item !== attachment);
    const deleteEmptyMessage = !nextAttachments.length && !String(message.body || "").trim();
    const { error: databaseError } = deleteEmptyMessage
      ? await supabase.from(table).delete().eq("id", message.id)
      : await supabase.from(table).update({ attachments: nextAttachments }).eq("id", message.id);
    if (databaseError) throw databaseError;

    const { error: storageError } = await supabase.storage.from("chat-files").remove([attachment.path]);
    if (storageError) {
      if (!deleteEmptyMessage) await supabase.from(table).update({ attachments }).eq("id", message.id);
      throw storageError;
    }
    await audit(request, "message.attachment_delete", messageType === "direct" ? "direct_message" : "channel_message", message.id, `Deleted attachment ${String(attachment.name || "file").slice(0, 160)}`, { path: attachment.path });
    response.json({ ok: true, messageDeleted: deleteEmptyMessage, attachments: nextAttachments });
  }));

  app.post("/api/files/validate", authenticate, handler(async (request, response) => {
    const files = Array.isArray(request.body?.files) ? request.body.files : [];
    const invalid = files.find((file) => {
      const type = String(file.type || "application/octet-stream").toLowerCase();
      return Number(file.size || 0) > MAX_FILE_BYTES || !(ALLOWED_FILE_PREFIXES.some((prefix) => type.startsWith(prefix)) || ALLOWED_FILE_TYPES.has(type));
    });
    if (invalid) return response.status(400).json({ error: `${String(invalid.name || "A file")} is too large or its type is not allowed.` });
    const channelId = String(request.body?.channelId || "");
    if (channelId) {
      const [{ data: channel }, { data: stored }] = await Promise.all([
        supabase.from("channels").select("id,storage_quota_bytes").eq("id", channelId).single(),
        supabase.from("file_library_items").select("size_bytes").eq("channel_id", channelId).eq("item_type", "file"),
      ]);
      const replaceFileId = String(request.body?.replaceFileId || "");
      let usedBytes = (stored || []).reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
      if (replaceFileId) {
        const { data: replacing } = await supabase.from("file_library_items").select("size_bytes").eq("id", replaceFileId).eq("channel_id", channelId).single();
        usedBytes -= Number(replacing?.size_bytes || 0);
      }
      const incomingBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
      if (channel && usedBytes + incomingBytes > Number(channel.storage_quota_bytes || 0)) {
        return response.status(413).json({ error: `This Files channel would exceed its ${Math.round(Number(channel.storage_quota_bytes) / 1048576)} MB storage quota.` });
      }
    }
    response.json({ ok: true, maxFileBytes: MAX_FILE_BYTES });
  }));

  app.post("/api/files/:id/download", authenticate, handler(async (request, response) => {
    await supabase.from("file_downloads").insert({ file_item_id: request.params.id, user_id: request.vineUser.profile.id });
    response.json({ ok: true });
  }));

  app.patch("/api/files/:id", authenticate, handler(async (request, response) => {
    const { data: file, error: fileError } = await supabase.from("file_library_items").select("id,uploaded_by,channel_id").eq("id", request.params.id).single();
    if (fileError || !file) return response.status(404).json({ error: "File not found." });
    if (file.uploaded_by !== request.vineUser.profile.id && request.vineUser.profile.role !== "admin") return response.status(403).json({ error: "Only the uploader or an admin can edit this file." });
    const changes = {};
    if (request.body?.description !== undefined) changes.description = String(request.body.description || "").slice(0, 1000);
    if (request.body?.retentionUntil !== undefined) changes.retention_until = request.body.retentionUntil || null;
    const { error } = await supabase.from("file_library_items").update(changes).eq("id", file.id);
    if (error) throw error;
    await audit(request, "file.update", "file", file.id, "Updated file metadata", { channelId: file.channel_id });
    response.json({ ok: true });
  }));

  app.post("/api/files/:id/replace", authenticate, handler(async (request, response) => {
    const { data: file, error: fileError } = await supabase.from("file_library_items").select("*").eq("id", request.params.id).single();
    if (fileError || !file || file.item_type !== "file") return response.status(404).json({ error: "File not found." });
    if (file.uploaded_by !== request.vineUser.profile.id && request.vineUser.profile.role !== "admin") return response.status(403).json({ error: "Only the uploader or an admin can replace this file." });
    const nextPath = String(request.body?.storagePath || "");
    if (!nextPath) return response.status(400).json({ error: "The replacement storage path is required." });
    const expectedPrefix = `${request.vineUser.profile.id}/libraries/${file.channel_id}/${file.id}/`;
    if (!nextPath.startsWith(expectedPrefix) || nextPath.includes("..")) return response.status(400).json({ error: "The replacement storage path is invalid." });
    if (Number(request.body?.sizeBytes || 0) > MAX_FILE_BYTES) return response.status(400).json({ error: "The replacement file is larger than 30 MB." });
    await supabase.from("file_versions").insert({
      file_item_id: file.id, version_number: file.version_number || 1, storage_path: file.storage_path,
      size_bytes: file.size_bytes || 0, mime_type: file.mime_type, uploaded_by: file.uploaded_by,
    });
    const { error } = await supabase.from("file_library_items").update({
      storage_path: nextPath,
      size_bytes: Number(request.body?.sizeBytes || 0),
      mime_type: String(request.body?.mimeType || "application/octet-stream"),
      content_hash: request.body?.contentHash || null,
      version_number: Number(file.version_number || 1) + 1,
      replaced_at: new Date().toISOString(),
    }).eq("id", file.id);
    if (error) throw error;
    await audit(request, "file.replace", "file", file.id, `Replaced ${file.name}`, { version: Number(file.version_number || 1) + 1 });
    response.json({ ok: true });
  }));

  app.post("/api/admin/members", authenticate, requireAdmin, handler(async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const displayName = String(request.body?.displayName || "").trim().slice(0, 60);
    const role = ALLOWED_MEMBER_ROLES.has(request.body?.role) ? request.body.role : "employee";
    if (!email || !displayName) return response.status(400).json({ error: "Display name and email are required." });
    const password = temporaryPassword();
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { must_change_password: true },
    });
    if (authError) throw authError;
    const { data: profile, error: profileError } = await supabase.from("profiles").upsert({
      id: authData.user.id, email, display_name: displayName,
      job_title: String(request.body?.jobTitle || "").trim().slice(0, 80), role, member_status: "active",
    }).select("id,email,display_name,job_title,role,member_status").single();
    if (profileError) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      throw profileError;
    }
    await audit(request, "member.create", "member", profile.id, `Created member ${email}`, { role });
    response.status(201).json({ member: publicMember(profile), temporaryPassword: password });
  }));

  app.patch("/api/admin/members/:id", authenticate, requireAdmin, handler(async (request, response) => {
    const changes = {};
    if (request.body?.displayName !== undefined) changes.display_name = String(request.body.displayName).trim().slice(0, 60);
    if (request.body?.jobTitle !== undefined) changes.job_title = String(request.body.jobTitle || "").trim().slice(0, 80);
    if (ALLOWED_MEMBER_ROLES.has(request.body?.role) && request.params.id !== request.vineUser.profile.id) changes.role = request.body.role;
    if (ALLOWED_MEMBER_STATUSES.has(request.body?.status) && request.params.id !== request.vineUser.profile.id) changes.member_status = request.body.status;
    const { data, error } = await supabase.from("profiles").update(changes).eq("id", request.params.id).select("id,email,display_name,job_title,role,member_status").single();
    if (error) throw error;
    if (changes.member_status) {
      const { error: authError } = await supabase.auth.admin.updateUserById(request.params.id, {
        ban_duration: changes.member_status === "active" ? "none" : "876000h",
      });
      if (authError) throw authError;
    }
    await audit(request, "member.update", "member", data.id, `Updated member ${data.email}`, changes);
    response.json({ member: publicMember(data) });
  }));

  app.post("/api/admin/members/:id/reset-password", authenticate, requireAdmin, handler(async (request, response) => {
    if (request.params.id === request.vineUser.profile.id) return response.status(400).json({ error: "Ask the other administrator to reset your password." });
    const password = temporaryPassword();
    const { data: profile } = await supabase.from("profiles").select("email").eq("id", request.params.id).single();
    const { error } = await supabase.auth.admin.updateUserById(request.params.id, { password, user_metadata: { must_change_password: true } });
    if (error) throw error;
    await audit(request, "member.reset_password", "member", request.params.id, `Reset password for ${profile?.email || request.params.id}`);
    response.json({ member: { id: request.params.id, email: profile?.email }, temporaryPassword: password });
  }));

  app.delete("/api/admin/members/:id", authenticate, requireAdmin, handler(async (request, response) => {
    if (request.params.id === request.vineUser.profile.id) return response.status(400).json({ error: "You cannot delete your own signed-in account." });
    const { data: profile } = await supabase.from("profiles").select("email").eq("id", request.params.id).single();
    await audit(request, "member.delete", "member", request.params.id, `Deleted member ${profile?.email || request.params.id}`);
    const { error } = await supabase.auth.admin.deleteUser(request.params.id);
    if (error) throw error;
    response.json({ ok: true });
  }));

  app.post("/api/channels", authenticate, requireAdmin, handler(async (request, response) => {
    const name = String(request.body?.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    if (!name) return response.status(400).json({ error: "Enter a valid channel name." });
    const channel = {
      name,
      description: String(request.body?.description || "").trim().slice(0, 160),
      channel_type: request.body?.channelType === "files" ? "files" : "chat",
      parent_id: request.body?.parentId || null,
      visibility: request.body?.visibility === "private" ? "private" : "workspace",
      posting_policy: request.body?.postingPolicy === "admins" ? "admins" : "everyone",
      storage_quota_bytes: Math.min(107374182400, Math.max(10485760, Number(request.body?.storageQuotaBytes || 1073741824))),
      created_by: request.vineUser.profile.id,
    };
    const { data, error } = await supabase.from("channels").insert(channel).select("*").single();
    if (error) throw error;
    const memberIds = [...new Set([request.vineUser.profile.id, ...(Array.isArray(request.body?.memberIds) ? request.body.memberIds : [])])];
    if (channel.visibility === "private") {
      await supabase.from("channel_members").insert(memberIds.map((userId) => ({ channel_id: data.id, user_id: userId, added_by: request.vineUser.profile.id })));
    }
    await audit(request, "channel.create", "channel", data.id, `Created #${data.name}`, { visibility: channel.visibility, postingPolicy: channel.posting_policy });
    response.status(201).json({ channel: data });
  }));

  app.patch("/api/channels/:id", authenticate, requireAdmin, handler(async (request, response) => {
    const changes = {};
    if (request.body?.description !== undefined) changes.description = String(request.body.description || "").slice(0, 160);
    if (request.body?.visibility) changes.visibility = request.body.visibility === "private" ? "private" : "workspace";
    if (request.body?.postingPolicy) changes.posting_policy = request.body.postingPolicy === "admins" ? "admins" : "everyone";
    if (request.body?.storageQuotaBytes !== undefined) changes.storage_quota_bytes = Math.min(107374182400, Math.max(10485760, Number(request.body.storageQuotaBytes || 1073741824)));
    const { data, error } = await supabase.from("channels").update(changes).eq("id", request.params.id).select("*").single();
    if (error) throw error;
    if (Array.isArray(request.body?.memberIds)) {
      await supabase.from("channel_members").delete().eq("channel_id", data.id);
      const ids = [...new Set([request.vineUser.profile.id, ...request.body.memberIds])];
      if (data.visibility === "private") await supabase.from("channel_members").insert(ids.map((userId) => ({ channel_id: data.id, user_id: userId, added_by: request.vineUser.profile.id })));
    }
    await audit(request, "channel.update", "channel", data.id, `Updated #${data.name}`, changes);
    response.json({ channel: data });
  }));

  app.post("/api/channels/:id/move", authenticate, requireAdmin, handler(async (request, response) => {
    const parentId = String(request.body?.parentId || "");
    const position = Number(request.body?.position);
    if (!parentId || !Number.isInteger(position) || position < 0) return response.status(400).json({ error: "Choose a valid channel position." });
    const { error } = await supabase.rpc("move_vine_subchannel", {
      target_channel_id: request.params.id,
      target_parent_id: parentId,
      target_position: position,
    });
    if (error) throw error;
    await audit(request, "channel.move", "channel", request.params.id, "Moved a sub-channel", { parentId, position });
    response.json({ ok: true });
  }));

  app.delete("/api/channels/:id", authenticate, requireAdmin, handler(async (request, response) => {
    const { data: channel } = await supabase.from("channels").select("name").eq("id", request.params.id).single();
    if (!channel) return response.status(404).json({ error: "Channel not found." });
    const { error } = await supabase.from("channels").delete().eq("id", request.params.id);
    if (error) throw error;
    await audit(request, "channel.delete", "channel", request.params.id, `Deleted #${channel?.name || request.params.id}`);
    response.json({ ok: true });
  }));

  app.get("/api/admin/audit", authenticate, requireAdmin, handler(async (request, response) => {
    const { data, error } = await supabase.from("audit_logs").select("id,actor_id,action,entity_type,entity_id,summary,metadata,created_at").order("created_at", { ascending: false }).limit(250);
    if (error) throw error;
    response.json({ logs: data || [] });
  }));

  app.get("/api/admin/export/:kind", authenticate, requireAdmin, handler(async (request, response) => {
    const kind = request.params.kind;
    let rows;
    if (kind === "employees") rows = (await supabase.from("profiles").select("email,display_name,job_title,role,member_status,last_login_at,last_active_at").order("display_name")).data || [];
    else if (kind === "clients") rows = (await supabase.from("crm_clients").select("name,company,email,phone,status,notes,created_at,updated_at").order("updated_at", { ascending: false })).data || [];
    else if (kind === "audit") rows = (await supabase.from("audit_logs").select("created_at,action,entity_type,entity_id,summary").order("created_at", { ascending: false }).limit(5000)).data || [];
    else return response.status(404).json({ error: "Unknown export." });
    const csv = toCsv(rows);
    await audit(request, "report.export", "report", kind, `Exported ${kind} report`, { rows: rows.length });
    response.type("text/csv").attachment(`vine-connect-${kind}.csv`).send(csv);
  }));

  app.post("/api/cron/maintenance", handler(async (request, response) => {
    if (!supabase) return response.status(503).json({ error: "Supabase is not configured on this server." });
    if (!cronAuthorized(request)) return response.status(401).json({ error: "Cron authorization failed." });
    const now = new Date().toISOString();
    const { data: due } = await supabase.from("scheduled_messages").select("*").eq("status", "pending").lte("scheduled_for", now).order("scheduled_for").limit(100);
    let sent = 0;
    let failed = 0;
    for (const scheduled of due || []) {
      await supabase.from("scheduled_messages").update({ status: "processing" }).eq("id", scheduled.id).eq("status", "pending");
      const { data: sender } = await supabase.from("profiles").select("id,email,display_name,role,member_status").eq("id", scheduled.sender_id).single();
      try {
        if (!sender || sender.member_status !== "active") throw new Error("Sender is not active.");
        const message = await postMessage({
          sender, messageType: scheduled.message_type, channelId: scheduled.channel_id,
          recipientId: scheduled.recipient_id, body: scheduled.body, attachments: scheduled.attachments,
        });
        await supabase.from("scheduled_messages").update({ status: "sent", posted_message_id: message.id, error_message: null }).eq("id", scheduled.id);
        sent += 1;
      } catch (error) {
        await supabase.from("scheduled_messages").update({ status: "failed", error_message: String(error.message || "Delivery failed").slice(0, 1000) }).eq("id", scheduled.id);
        failed += 1;
      }
    }
    const stale = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const { count: subscriptionsRemoved } = await supabase.from("push_subscriptions").delete({ count: "exact" }).lt("last_used_at", stale);
    const { data: expiredFiles } = await supabase.from("file_library_items").select("id,storage_path,name").eq("item_type", "file").not("retention_until", "is", null).lte("retention_until", now).limit(500);
    const expiredIds = (expiredFiles || []).map((item) => item.id);
    const { data: expiredVersions } = expiredIds.length
      ? await supabase.from("file_versions").select("storage_path").in("file_item_id", expiredIds)
      : { data: [] };
    const expiredPaths = [...(expiredFiles || []).map((item) => item.storage_path), ...(expiredVersions || []).map((item) => item.storage_path)].filter(Boolean);
    if (expiredPaths.length) await supabase.storage.from("chat-files").remove(expiredPaths);
    if (expiredIds.length) await supabase.from("file_library_items").delete().in("id", expiredIds);
    const filesExpired = (expiredFiles || []).length;
    await supabase.from("audit_logs").insert({ action: "cron.maintenance", entity_type: "system", summary: "Completed scheduled maintenance", metadata: { sent, failed, subscriptionsRemoved: subscriptionsRemoved || 0, filesExpired } });
    response.json({ ok: true, sent, failed, subscriptionsRemoved: subscriptionsRemoved || 0, filesExpired });
  }));
}

function cronAuthorized(request) {
  const expected = String(process.env.CRON_SECRET || "");
  const supplied = String(request.headers["x-cron-secret"] || request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || !supplied) return false;
  const first = Buffer.from(expected);
  const second = Buffer.from(supplied);
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toCsv(rows) {
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return `${columns.map(cell).join(",")}\r\n${rows.map((row) => columns.map((column) => cell(typeof row[column] === "object" ? JSON.stringify(row[column]) : row[column])).join(",")).join("\r\n")}\r\n`;
}
