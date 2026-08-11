"use strict";

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 120;
const STORAGE_BUCKET = "chat-files";
const RING_DURATION_MS = 30 * 1000;

const state = {
  channels: [],
  messages: [],
  directMessages: [],
  threadReplies: [],
  reactions: [],
  reactionsReady: false,
  reactionTarget: null,
  reactionBusy: false,
  readReceipts: [],
  readsReady: false,
  readReceiptPending: new Set(),
  readWriteErrorShown: false,
  memberRings: [],
  ringsReady: false,
  activeRing: null,
  ringSendingTo: null,
  handledRingIds: new Set(),
  pins: [],
  fileItems: [],
  filesFeatureReady: false,
  members: [],
  clients: [],
  meetings: [],
  meetingParticipants: [],
  meetingsReady: false,
  activeMeetingRecord: null,
  platformReady: false,
  channelMembers: [],
  bookmarks: [],
  scheduledMessages: [],
  notificationPreferences: null,
  auditLogs: [],
  deletedMessageHistory: [],
  fileFavorites: [],
  fileVersions: [],
  presence: new Map(),
  typingMembers: new Map(),
  typingTimer: null,
  fileSearch: "",
  selectedChannelId: null,
  selectedDirectUserId: null,
  selectedFileFolderId: null,
  libraryUploadContext: null,
  activeThread: null,
  composerTarget: "message-input",
  expanded: new Set(),
  movingSubchannelId: null,
  pendingFiles: [],
  pendingPreviews: new Map(),
  attachmentUrls: new Map(),
  realtime: null,
  reloadTimer: null,
  lastViewed: {},
  viewStateInitialized: false,
  notificationsMuted: false,
  busy: false,
};

let supabaseClient = null;
let currentSession = null;
let currentProfile = null;
let jitsiApi = null;
let loadedJitsiScriptUrl = "";
let jitsiScriptPromise = null;
let toastTimer = null;
let ringTimer = null;
let heartbeatTimer = null;
let deferredInstallPrompt = null;
const defaultDocumentTitle = document.title;
const notificationAudio = new Audio("notification.mp3?v=20260716-2");
notificationAudio.preload = "auto";
const ringAudio = new Audio("ringtone.mp3?v=20260717-1");
ringAudio.preload = "auto";
ringAudio.loop = true;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  applySavedTheme();
  applyNotificationPreference();
  initializePwa();

  const config = window.VINE_SUPABASE_CONFIG || {};
  const configured = /^https:\/\/.+\.supabase\.co$/i.test(config.url || "")
    && config.publishableKey
    && !String(config.publishableKey).includes("YOUR_");

  if (!configured || !window.supabase?.createClient) {
    $("#config-alert").hidden = false;
    $("#login-submit").disabled = true;
    if (!window.supabase?.createClient) {
      $("#config-alert span").textContent = "The Supabase library could not load. Check your internet connection, then refresh.";
    }
    return;
  }

  supabaseClient = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) showLoginError(error.message);
  await syncSession(data?.session || null);

  supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
    window.setTimeout(() => syncSession(nextSession), 0);
  });
}

function bindEvents() {
  $("#login-form").addEventListener("submit", login);
  $("#password-form").addEventListener("submit", changeTemporaryPassword);
  $("#channel-form").addEventListener("submit", createChannel);
  $("#new-channel-type").addEventListener("change", updateChannelTypeTip);
  $("#move-subchannel-form").addEventListener("submit", moveSubchannel);
  $("#move-subchannel-parent").addEventListener("change", () => renderMoveSubchannelPositions());
  $("#profile-form").addEventListener("submit", updateProfile);
  $("#message-input").addEventListener("input", () => {
    updateSendState();
    broadcastTyping();
  });
  $("#message-input").addEventListener("focus", () => { state.composerTarget = "message-input"; });
  $("#message-input").addEventListener("paste", handleComposerPaste);
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#send-message").addEventListener("click", () => sendMessage());
  $("#schedule-message").addEventListener("click", openScheduleMessageModal);
  $("#schedule-message-form").addEventListener("submit", scheduleCurrentMessage);
  $("#format-bold").addEventListener("click", () => applyTextFormat("message-input", "**", "bold text"));
  $("#format-italic").addEventListener("click", () => applyTextFormat("message-input", "*", "italic text"));
  $("#format-mention").addEventListener("click", () => openMentionPicker("message-input"));
  $("#format-emoji").addEventListener("click", () => openEmojiPicker("message-input"));
  $("#attach-files").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (event) => queueFiles(event.target.files));
  $("#library-file-input").addEventListener("change", (event) => uploadLibraryFiles(event.target.files));
  $("#focus-composer").addEventListener("click", () => $("#message-input").focus());
  $("#open-channel-modal").addEventListener("click", openChannelModal);
  $("#open-profile").addEventListener("click", openProfileModal);
  $("#open-members").addEventListener("click", openMembersModal);
  $("#open-add-member").addEventListener("click", openAddMemberModal);
  $("#add-member-form").addEventListener("submit", createMember);
  $("#copy-member-password").addEventListener("click", copyTemporaryPassword);
  $("#finish-member-created").addEventListener("click", () => closeModal("member-created-modal"));
  $("#open-search").addEventListener("click", openSearch);
  $("#open-recent").addEventListener("click", openThreadsOverview);
  $("#workspace-menu").addEventListener("click", openMembersModal);
  $("#conversation-more").addEventListener("click", openConversationOptions);
  $("#open-crm").addEventListener("click", openCrm);
  $("#open-client-form").addEventListener("click", openClientForm);
  $("#client-form").addEventListener("submit", createClient);
  $("#employee-form").addEventListener("submit", updateEmployee);
  $("#reset-employee-password").addEventListener("click", resetEmployeePassword);
  $("#delete-employee").addEventListener("click", deleteEmployee);
  $("#open-threads").addEventListener("click", openThreadsOverview);
  $("#open-mentions").addEventListener("click", openMentionsOverview);
  $("#open-pins").addEventListener("click", openPinnedMessages);
  $("#open-meeting").addEventListener("click", () => openMeeting());
  $("#open-meetings").addEventListener("click", openMeetingsHub);
  $("#start-context-meeting").addEventListener("click", () => {
    closeModal("meetings-hub-modal");
    openMeeting();
  });
  $("#open-schedule-meeting").addEventListener("click", openScheduleMeeting);
  $("#schedule-meeting-form").addEventListener("submit", scheduleMeeting);
  $("#open-ring-direct").addEventListener("click", () => sendMemberRing(state.selectedDirectUserId));
  $("#leave-meeting").addEventListener("click", closeMeeting);
  $("#open-pins-sidebar").addEventListener("click", openPinnedMessages);
  $("#open-bookmarks").addEventListener("click", openBookmarks);
  $("#open-scheduled-messages").addEventListener("click", openScheduledMessages);
  $("#thread-form").addEventListener("submit", sendThreadReply);
  $("#thread-input").addEventListener("focus", () => { state.composerTarget = "thread-input"; });
  $("#thread-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#thread-form").requestSubmit();
    }
  });
  $("#thread-bold").addEventListener("click", () => applyTextFormat("thread-input", "**", "bold text"));
  $("#thread-italic").addEventListener("click", () => applyTextFormat("thread-input", "*", "italic text"));
  $("#thread-mention").addEventListener("click", () => openMentionPicker("thread-input"));
  $("#thread-emoji").addEventListener("click", () => openEmojiPicker("thread-input"));
  $("#emoji-picker-list").addEventListener("emoji-click", async (event) => {
    const emoji = event.detail?.unicode;
    if (!emoji) return;
    const reactionTarget = state.reactionTarget;
    if (reactionTarget) {
      closeModal("emoji-modal");
      await toggleReaction(reactionTarget, emoji);
      return;
    }
    insertAtCursor(state.composerTarget, emoji);
    closeModal("emoji-modal");
  });
  $("#search-input").addEventListener("input", renderSearchResults);
  ["#search-type", "#search-channel", "#search-member", "#search-file-type", "#search-date", "#search-mentions", "#search-pinned"].forEach((selector) => {
    $(selector)?.addEventListener("change", renderSearchResults);
  });
  $("#mobile-menu").addEventListener("click", openSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $("#sign-out").addEventListener("click", signOut);
  $("#sign-out-quick").addEventListener("click", signOut);
  $("#toggle-notifications").addEventListener("click", toggleNotifications);
  $("#install-vine-app").addEventListener("click", installVineApp);
  $("#enable-push").addEventListener("click", enablePushNotifications);
  $$('[data-notification-pref]').forEach((input) => input.addEventListener("change", saveNotificationPreferences));
  $("#new-channel-visibility").addEventListener("change", updateChannelMemberPickerVisibility);
  $("#channel-settings-visibility").addEventListener("change", updateChannelSettingsMemberVisibility);
  $("#channel-settings-form").addEventListener("submit", saveChannelSettings);
  $$('[data-export]').forEach((button) => button.addEventListener("click", () => exportAdminReport(button.dataset.export)));
  $("#dismiss-ring").addEventListener("click", () => dismissActiveRing(false));
  $("#open-ring-message").addEventListener("click", () => dismissActiveRing(true));
  $$(".theme-toggle").forEach((button) => button.addEventListener("click", toggleTheme));
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  $$(".modal-layer, .search-layer").forEach((layer) => layer.addEventListener("click", (event) => {
    if (event.target === layer) closeModal(layer.id);
  }));
  document.addEventListener("pointerdown", unlockNotificationAudio, { once: true });

  const composer = $("#composer-wrap");
  ["dragenter", "dragover"].forEach((name) => composer.addEventListener(name, (event) => {
    event.preventDefault();
    $("#drop-overlay").hidden = false;
  }));
  ["dragleave", "drop"].forEach((name) => composer.addEventListener(name, (event) => {
    event.preventDefault();
    if (name === "drop") queueFiles(event.dataTransfer.files);
    $("#drop-overlay").hidden = true;
  }));

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    }
    if (event.key === "Escape") {
      $$(".modal-layer:not([hidden]), .search-layer:not([hidden])").forEach((layer) => closeModal(layer.id));
      closeSidebar();
    }
  });
}

async function login(event) {
  event.preventDefault();
  if (!supabaseClient || state.busy) return;
  const button = $("#login-submit");
  setButtonBusy(button, true, "Signing in...");
  hideError("login-error");

  const { error } = await supabaseClient.auth.signInWithPassword({
    email: $("#login-email").value.trim().toLowerCase(),
    password: $("#login-password").value,
  });

  setButtonBusy(button, false, "Sign in");
  if (error) showLoginError(error.message === "Invalid login credentials" ? "Email or password is incorrect." : error.message);
}

async function syncSession(session) {
  currentSession = session;
  if (!session) {
    closeMeeting();
    unsubscribeRealtime();
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    currentProfile = null;
    state.channels = [];
    state.messages = [];
    state.directMessages = [];
    state.threadReplies = [];
    state.reactions = [];
    state.reactionsReady = false;
    state.reactionTarget = null;
    state.readReceipts = [];
    state.readsReady = false;
    state.readReceiptPending.clear();
    state.readWriteErrorShown = false;
    state.memberRings = [];
    state.ringsReady = false;
    state.ringSendingTo = null;
    state.handledRingIds.clear();
    clearActiveRingUi();
    state.pins = [];
    state.fileItems = [];
    state.filesFeatureReady = false;
    state.members = [];
    state.clients = [];
    state.meetings = [];
    state.meetingParticipants = [];
    state.meetingsReady = false;
    state.activeMeetingRecord = null;
    state.platformReady = false;
    state.channelMembers = [];
    state.bookmarks = [];
    state.scheduledMessages = [];
    state.notificationPreferences = null;
    state.auditLogs = [];
    state.deletedMessageHistory = [];
    state.fileFavorites = [];
    state.fileVersions = [];
    state.presence.clear();
    state.typingMembers.clear();
    state.selectedDirectUserId = null;
    state.selectedFileFolderId = null;
    state.activeThread = null;
    state.movingSubchannelId = null;
    state.lastViewed = {};
    state.viewStateInitialized = false;
    $("#app").hidden = true;
    $("#auth-screen").hidden = false;
    $("#login-form").hidden = false;
    $("#password-form").hidden = true;
    return;
  }

  $("#login-error").hidden = true;
  if (session.user.user_metadata?.must_change_password) {
    $("#app").hidden = true;
    $("#auth-screen").hidden = false;
    $("#login-form").hidden = true;
    $("#password-form").hidden = false;
    return;
  }

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("id,email,display_name,role,job_title")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) {
    $("#app").hidden = true;
    $("#auth-screen").hidden = false;
    $("#login-form").hidden = false;
    showLoginError("Your account exists, but its Vine profile is missing. Ask an administrator to run supabase-setup.sql, then sign in again.");
    return;
  }

  currentProfile = profile;
  loadViewState();
  $("#auth-screen").hidden = true;
  $("#app").hidden = false;
  applyProfile();
  await loadWorkspace(true);
  subscribeRealtime();
  sendHeartbeat();
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(sendHeartbeat, 4 * 60 * 1000);
}

async function changeTemporaryPassword(event) {
  event.preventDefault();
  if (!supabaseClient || state.busy) return;
  const password = $("#new-password").value;
  const confirm = $("#confirm-password").value;
  hideError("password-error");
  if (password.length < 12) return showFormError("password-error", "Use at least 12 characters.");
  if (password !== confirm) return showFormError("password-error", "The passwords do not match.");

  const button = $("#password-submit");
  setButtonBusy(button, true, "Saving...");
  const metadata = { ...currentSession.user.user_metadata, must_change_password: false };
  const { data, error } = await supabaseClient.auth.updateUser({ password, data: metadata });
  setButtonBusy(button, false, "Save password and continue");
  if (error) return showFormError("password-error", error.message);

  $("#password-form").reset();
  await syncSession({ ...currentSession, user: data.user });
}

async function loadWorkspace(scrollToBottom = false) {
  if (!supabaseClient || !currentSession) return;
  const messagePane = $("#message-pane");
  if (!state.channels.length) messagePane.innerHTML = '<div class="message-loading"><i class="glyph spin">&#9696;</i> Loading workspace...</div>';

  const clientsRequest = currentProfile?.role === "admin"
    ? supabaseClient.from("crm_clients").select("id,name,company,email,phone,status,notes,created_at,updated_at").order("updated_at", { ascending: false })
    : Promise.resolve({ data: [], error: null });
  const recentRingCutoff = new Date(Date.now() - 60 * 1000).toISOString();
  const meetingHistoryCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [channelsResult, messagesResult, directResult, threadResult, pinsResult, membersResult, clientsResult, fileItemsResult, reactionsResult, ringsResult, readsResult, meetingsResult, meetingParticipantsResult, profileMetadataResult, channelMembersResult, bookmarksResult, scheduledResult, notificationPreferencesResult, auditResult, fileFavoritesResult, fileVersionsResult, fileMetadataResult, deletedHistoryResult] = await Promise.all([
    supabaseClient.from("channels").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("messages").select("id,channel_id,author_id,body,attachments,created_at,edited_at,author:profiles!messages_author_id_fkey(display_name,email)").order("created_at", { ascending: true }).limit(1000),
    supabaseClient.from("direct_messages").select("id,sender_id,recipient_id,body,attachments,created_at,edited_at").order("created_at", { ascending: true }).limit(1000),
    supabaseClient.from("thread_replies").select("id,channel_message_id,direct_message_id,author_id,body,created_at,edited_at,author:profiles!thread_replies_author_id_fkey(display_name,email)").order("created_at", { ascending: true }).limit(2000),
    supabaseClient.from("message_pins").select("id,message_id,channel_id,pinned_by,created_at").order("created_at", { ascending: false }),
    supabaseClient.from("profiles").select("id,email,display_name,role,job_title").order("display_name", { ascending: true }),
    clientsRequest,
    supabaseClient.from("file_library_items")
      .select("id,channel_id,parent_id,name,item_type,storage_path,external_url,mime_type,size_bytes,uploaded_by,created_at,updated_at")
      .order("created_at", { ascending: true }),
    supabaseClient.from("message_reactions")
      .select("id,channel_message_id,direct_message_id,thread_reply_id,user_id,emoji,created_at")
      .order("created_at", { ascending: true })
      .limit(5000),
    supabaseClient.from("member_rings")
      .select("id,sender_id,recipient_id,created_at,acknowledged_at")
      .or(`sender_id.eq.${currentSession.user.id},recipient_id.eq.${currentSession.user.id}`)
      .gte("created_at", recentRingCutoff)
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseClient.from("message_reads")
      .select("id,channel_message_id,direct_message_id,user_id,seen_at")
      .order("seen_at", { ascending: true })
      .limit(5000),
    supabaseClient.from("meetings")
      .select("id,title,description,room_name,host_id,scope,channel_id,direct_user_id,starts_at,duration_minutes,status,started_at,ended_at,created_at,updated_at")
      .gte("starts_at", meetingHistoryCutoff)
      .order("starts_at", { ascending: true })
      .limit(500),
    supabaseClient.from("meeting_participants")
      .select("meeting_id,user_id,participant_role,response,created_at")
      .limit(5000),
    supabaseClient.from("profiles").select("id,member_status,last_login_at,last_active_at"),
    supabaseClient.from("channel_members").select("channel_id,user_id,added_by,created_at"),
    supabaseClient.from("message_bookmarks").select("id,user_id,channel_message_id,direct_message_id,created_at").eq("user_id", currentSession.user.id),
    supabaseClient.from("scheduled_messages").select("id,sender_id,message_type,channel_id,recipient_id,body,attachments,scheduled_for,status,error_message,created_at").eq("sender_id", currentSession.user.id).order("scheduled_for", { ascending: true }).limit(500),
    supabaseClient.from("notification_preferences").select("user_id,direct_messages,mentions,rings,channel_messages,quiet_hours_start,quiet_hours_end").eq("user_id", currentSession.user.id).maybeSingle(),
    currentProfile?.role === "admin"
      ? supabaseClient.from("audit_logs").select("id,actor_id,action,entity_type,entity_id,summary,created_at").order("created_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [], error: null }),
    supabaseClient.from("file_favorites").select("user_id,file_item_id,created_at").eq("user_id", currentSession.user.id),
    supabaseClient.from("file_versions").select("id,file_item_id,version_number,storage_path,size_bytes,mime_type,uploaded_by,created_at").order("version_number", { ascending: false }).limit(2000),
    supabaseClient.from("file_library_items").select("id,description,version_number,content_hash,retention_until,replaced_at"),
    currentProfile?.role === "admin"
      ? supabaseClient.from("deleted_message_history").select("id,message_type,channel_id,sender_id,recipient_id,body,deleted_at,deleted_by").order("deleted_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const firstError = channelsResult.error || messagesResult.error || directResult.error || threadResult.error || pinsResult.error || membersResult.error || clientsResult.error;
  if (firstError) {
    messagePane.innerHTML = `<div class="empty-channel"><span class="empty-icon">!</span><h2>Workspace could not load</h2><p>${escapeHtml(firstError.message)}</p></div>`;
    showToast(firstError.message, "error");
    return;
  }

  state.channels = (channelsResult.data || []).map((channel) => ({ ...channel, channel_type: channel.channel_type || "chat" }));
  state.messages = messagesResult.data || [];
  state.directMessages = directResult.data || [];
  state.threadReplies = threadResult.data || [];
  state.reactions = reactionsResult.error ? [] : (reactionsResult.data || []);
  state.reactionsReady = !reactionsResult.error;
  state.memberRings = ringsResult.error ? [] : (ringsResult.data || []);
  state.ringsReady = !ringsResult.error;
  state.readReceipts = readsResult.error ? [] : (readsResult.data || []);
  state.readsReady = !readsResult.error;
  state.pins = pinsResult.data || [];
  const fileMetadata = new Map((fileMetadataResult.data || []).map((item) => [item.id, item]));
  state.fileItems = fileItemsResult.error ? [] : (fileItemsResult.data || []).map((item) => ({ ...item, ...(fileMetadata.get(item.id) || {}) }));
  state.filesFeatureReady = !fileItemsResult.error;
  const profileMetadata = new Map((profileMetadataResult.data || []).map((item) => [item.id, item]));
  state.members = (membersResult.data || []).map((item) => ({ ...item, member_status: "active", ...(profileMetadata.get(item.id) || {}) }));
  state.clients = clientsResult.data || [];
  state.meetingsReady = !meetingsResult.error && !meetingParticipantsResult.error;
  state.meetings = state.meetingsReady ? (meetingsResult.data || []) : [];
  state.meetingParticipants = state.meetingsReady ? (meetingParticipantsResult.data || []) : [];
  state.platformReady = !channelMembersResult.error && !bookmarksResult.error && !scheduledResult.error;
  state.channelMembers = channelMembersResult.error ? [] : (channelMembersResult.data || []);
  state.bookmarks = bookmarksResult.error ? [] : (bookmarksResult.data || []);
  state.scheduledMessages = scheduledResult.error ? [] : (scheduledResult.data || []);
  state.notificationPreferences = notificationPreferencesResult.error ? null : notificationPreferencesResult.data;
  state.auditLogs = auditResult.error ? [] : (auditResult.data || []);
  state.deletedMessageHistory = deletedHistoryResult.error ? [] : (deletedHistoryResult.data || []);
  state.fileFavorites = fileFavoritesResult.error ? [] : (fileFavoritesResult.data || []);
  state.fileVersions = fileVersionsResult.error ? [] : (fileVersionsResult.data || []);

  if (state.selectedDirectUserId && !state.members.some((member) => member.id === state.selectedDirectUserId)) {
    state.selectedDirectUserId = null;
  }

  const savedChannel = localStorage.getItem("vine-connect-channel");
  const selectionExists = state.channels.some((channel) => channel.id === state.selectedChannelId);
  if (!state.selectedDirectUserId && !selectionExists) {
    state.selectedChannelId = state.channels.some((channel) => channel.id === savedChannel)
      ? savedChannel
      : (state.channels.find((channel) => channel.name === "general") || state.channels[0])?.id || null;
  }

  const deepLink = new URLSearchParams(window.location.search);
  const requestedChannel = deepLink.get("channel");
  const requestedDirect = deepLink.get("direct");
  if (requestedDirect && state.members.some((member) => member.id === requestedDirect && member.id !== currentSession.user.id)) {
    state.selectedDirectUserId = requestedDirect;
    state.selectedChannelId = null;
  }
  if (!state.selectedDirectUserId && requestedChannel && state.channels.some((channel) => channel.id === requestedChannel)) {
    state.selectedChannelId = requestedChannel;
    const requestedFolder = deepLink.get("folder");
    state.selectedFileFolderId = state.fileItems.some((item) => item.id === requestedFolder && item.channel_id === requestedChannel && item.item_type === "folder")
      ? requestedFolder
      : null;
  }

  initializeViewState();

  renderChannels();
  renderDirectMessages();
  renderMembers();
  renderCrm();
  updatePlatformBadges();
  applyNotificationPreferencesUi();
  updateMeetingsBadge();
  renderConversation(scrollToBottom);
  renderActivityBadges();
  if (state.activeThread && !$("#thread-modal").hidden) renderThreadModal();
  if (!$("#meetings-hub-modal").hidden) renderMeetingsHub();
  processPendingRings();
  const requestedMessage = deepLink.get("message");
  if (requestedMessage) requestAnimationFrame(() => {
    const element = document.querySelector(`[data-message-id="${CSS.escape(requestedMessage)}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.classList.add("message-highlight");
    window.setTimeout(() => element?.classList.remove("message-highlight"), 2800);
  });
}

function applyProfile() {
  const name = currentProfile.display_name || currentProfile.email.split("@")[0];
  const initials = getInitials(name);
  const role = titleCase(currentProfile.role);
  $("#profile-name").textContent = name;
  $("#profile-role").textContent = role;
  $("#profile-avatar").textContent = initials;
  $("#profile-modal-avatar").textContent = initials;
  $("#profile-modal-role").textContent = role;
  $("#profile-modal-role").className = `role-pill ${currentProfile.role}`;
  $("#profile-email").textContent = currentProfile.email;
  $("#display-name").value = name;
  $("#open-channel-modal").hidden = currentProfile.role !== "admin";
  $("#open-add-member").hidden = currentProfile.role !== "admin";
  $("#open-crm").hidden = currentProfile.role !== "admin";
}

function renderChannels() {
  const container = $("#channel-list");
  container.replaceChildren();
  const topLevel = state.channels.filter((channel) => !channel.parent_id).sort(sortChannels);

  if (!topLevel.length) {
    const empty = document.createElement("p");
    empty.className = "channel-empty";
    empty.textContent = currentProfile?.role === "admin" ? "Create the first channel." : "No channels yet.";
    container.append(empty);
    return;
  }

  topLevel.forEach((channel) => {
    const children = state.channels.filter((item) => item.parent_id === channel.id).sort(sortChannels);
    const unread = isChannelUnread(channel.id) || children.some((child) => isChannelUnread(child.id));
    const group = document.createElement("div");
    const row = document.createElement("div");
    row.className = `channel-row${channel.id === state.selectedChannelId && !state.selectedDirectUserId ? " active" : ""}${unread ? " unread" : ""}`;

    if (children.length) {
      const caret = document.createElement("button");
      caret.className = "channel-caret";
      caret.type = "button";
      caret.setAttribute("aria-label", `Toggle ${channel.name} sub-channels`);
      caret.textContent = state.expanded.has(channel.id) ? "v" : ">";
      caret.addEventListener("click", () => {
        state.expanded.has(channel.id) ? state.expanded.delete(channel.id) : state.expanded.add(channel.id);
        renderChannels();
      });
      row.append(caret);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "channel-caret-spacer";
      row.append(spacer);
    }

    row.append(channelButton(channel, unread));
    if (currentProfile?.role === "admin") row.append(channelDeleteButton(channel));
    group.append(row);

    if (children.length && state.expanded.has(channel.id)) {
      children.forEach((child) => {
        const button = document.createElement("button");
        button.type = "button";
        const childUnread = isChannelUnread(child.id);
        button.className = `subchannel${child.id === state.selectedChannelId && !state.selectedDirectUserId ? " active" : ""}${childUnread ? " unread" : ""}`;
        button.innerHTML = `<span class="sub-line"></span><i class="glyph">${channelGlyph(child)}</i>`;
        const name = document.createElement("span");
        name.textContent = child.name;
        button.append(name);
        if (childUnread) button.append(unreadDot());
        button.addEventListener("click", () => selectChannel(child.id));
        const subRow = document.createElement("div");
        subRow.className = "subchannel-row";
        subRow.append(button);
        if (currentProfile?.role === "admin") subRow.append(channelMoveButton(child), channelDeleteButton(child));
        group.append(subRow);
      });
    }
    container.append(group);
  });
}

function sortChannels(first, second) {
  const firstOrder = Number.isFinite(Number(first.sort_order)) ? Number(first.sort_order) : 0;
  const secondOrder = Number.isFinite(Number(second.sort_order)) ? Number(second.sort_order) : 0;
  return firstOrder - secondOrder
    || new Date(first.created_at).getTime() - new Date(second.created_at).getTime()
    || String(first.id).localeCompare(String(second.id));
}

function channelButton(channel, unread = false) {
  const button = document.createElement("button");
  button.className = "channel-button";
  button.type = "button";
  button.innerHTML = `<i class="glyph">${channelGlyph(channel)}</i>`;
  const name = document.createElement("span");
  name.textContent = channel.name;
  button.append(name);
  if (unread) button.append(unreadDot());
  button.addEventListener("click", () => selectChannel(channel.id));
  return button;
}

function channelGlyph(channel) {
  if (channel.channel_type === "files") return "&#128193;";
  if (channel.visibility === "private") return "&#128274;";
  if (channel.posting_policy === "admins") return "&#128227;";
  return "#";
}

function channelDeleteButton(channel) {
  const button = document.createElement("button");
  button.className = "channel-delete-button";
  button.type = "button";
  button.title = `Delete ${channel.channel_type === "files" ? "files library" : "channel"} ${channel.name}`;
  button.setAttribute("aria-label", `Delete channel ${channel.name}`);
  button.textContent = "\u00D7";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteChannel(channel);
  });
  return button;
}

function channelMoveButton(channel) {
  const button = document.createElement("button");
  button.className = "channel-move-button";
  button.type = "button";
  button.title = `Move or reorder ${channel.name}`;
  button.setAttribute("aria-label", `Move or reorder sub-channel ${channel.name}`);
  button.textContent = "\u2195";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openMoveSubchannelModal(channel);
  });
  return button;
}

async function deleteChannel(channel) {
  if (currentProfile?.role !== "admin" || state.busy) return;
  const childCount = state.channels.filter((item) => item.parent_id === channel.id).length;
  const channelLabel = channel.channel_type === "files" ? `the ${channel.name} files library` : `#${channel.name}`;
  const warning = childCount
    ? `Delete ${channelLabel}, its ${childCount} sub-channel${childCount === 1 ? "" : "s"}, and all associated content?`
    : `Delete ${channelLabel} and all of its content?`;
  if (!window.confirm(`${warning}\n\nThis cannot be undone.`)) return;
  const channelIds = getChannelDescendantIds(channel.id);
  const attachmentPaths = state.messages
    .filter((message) => channelIds.has(message.channel_id))
    .flatMap((message) => Array.isArray(message.attachments) ? message.attachments : [])
    .map((attachment) => attachment.path)
    .filter(Boolean);
  const libraryPaths = state.fileItems
    .filter((item) => channelIds.has(item.channel_id))
    .map((item) => item.storage_path)
    .filter(Boolean);
  const libraryItemIds = new Set(state.fileItems.filter((item) => channelIds.has(item.channel_id)).map((item) => item.id));
  const versionPaths = state.fileVersions.filter((item) => libraryItemIds.has(item.file_item_id)).map((item) => item.storage_path).filter(Boolean);
  state.busy = true;
  let error = null;
  try {
    await apiRequest(`/channels/${channel.id}`, { method: "DELETE" });
  } catch (apiError) {
    if (![404, 503].includes(apiError.status)) error = apiError;
    else ({ error } = await supabaseClient.rpc("delete_vine_channel", { target_channel_id: channel.id }));
  }
  let storageWarning = "";
  const storedPaths = [...attachmentPaths, ...libraryPaths, ...versionPaths];
  if (!error && storedPaths.length) {
    const { error: storageError } = await supabaseClient.storage.from(STORAGE_BUCKET).remove(storedPaths);
    if (storageError) storageWarning = " Some old attachment files could not be cleared from storage.";
  }
  state.busy = false;
  if (error) return showToast(error.message, "error");
  if (state.selectedChannelId === channel.id || state.channels.find((item) => item.id === state.selectedChannelId)?.parent_id === channel.id) {
    state.selectedChannelId = null;
  }
  await loadWorkspace(false);
  showToast(`#${channel.name} deleted.${storageWarning}`, storageWarning ? "error" : "success");
}

function getChannelDescendantIds(channelId) {
  const ids = new Set([channelId]);
  let added = true;
  while (added) {
    added = false;
    state.channels.forEach((channel) => {
      if (channel.parent_id && ids.has(channel.parent_id) && !ids.has(channel.id)) {
        ids.add(channel.id);
        added = true;
      }
    });
  }
  return ids;
}

function selectChannel(id) {
  if (state.selectedChannelId !== id) {
    state.selectedFileFolderId = null;
    state.fileSearch = "";
  }
  state.selectedChannelId = id;
  state.selectedDirectUserId = null;
  clearFileLibraryDeepLink();
  localStorage.setItem("vine-connect-channel", id);
  const channel = state.channels.find((item) => item.id === id);
  if (channel?.parent_id) state.expanded.add(channel.parent_id);
  markConversationRead("channel", id);
  renderChannels();
  renderDirectMessages();
  renderConversation(true);
  renderTypingIndicator();
  closeSidebar();
}

function renderDirectMessages() {
  const container = $("#direct-list");
  container.replaceChildren();
  state.members.filter((member) => member.id !== currentSession?.user.id).forEach((member) => {
    const button = document.createElement("button");
    const unread = isDirectUnread(member.id);
    button.type = "button";
    button.className = `direct-message-button${member.id === state.selectedDirectUserId ? " active" : ""}${unread ? " unread" : ""}`;
    button.disabled = (member.member_status || "active") !== "active";
    const avatar = document.createElement("span");
    const presenceStatus = memberPresenceStatus(member);
    avatar.className = `direct-avatar ${avatarClass(member.id)} presence-${presenceStatus}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    avatar.title = `${titleCase(presenceStatus)} - ${member.display_name || member.email}`;
    const name = document.createElement("span");
    name.className = "direct-name";
    name.textContent = `${member.display_name || member.email.split("@")[0]}${button.disabled ? ` (${titleCase(member.member_status)})` : ""}`;
    button.append(avatar, name);
    if (unread) button.append(unreadDot());
    button.addEventListener("click", () => selectDirectMessage(member.id));
    container.append(button);
  });
}

function selectDirectMessage(memberId) {
  if (memberId === currentSession?.user.id) return;
  state.selectedDirectUserId = memberId;
  state.selectedChannelId = null;
  state.selectedFileFolderId = null;
  clearFileLibraryDeepLink();
  markConversationRead("direct", memberId);
  renderChannels();
  renderDirectMessages();
  renderConversation(true);
  renderTypingIndicator();
  closeModal("members-modal");
  closeSidebar();
}

function unreadDot() {
  const dot = document.createElement("span");
  dot.className = "unread-dot";
  dot.setAttribute("aria-label", "Unread messages");
  return dot;
}

function renderConversation(scrollToBottom = false) {
  $("#open-meeting").hidden = !(state.selectedChannelId || state.selectedDirectUserId);
  $("#open-ring-direct").hidden = !state.selectedDirectUserId;
  if (state.selectedDirectUserId) {
    $("#composer-wrap").hidden = false;
    const member = state.members.find((item) => item.id === state.selectedDirectUserId);
    if (!member) {
      state.selectedDirectUserId = null;
      return renderConversation(scrollToBottom);
    }
    const displayName = member.display_name || member.email.split("@")[0];
    $("#conversation-symbol").textContent = "@";
    $("#channel-name").textContent = displayName;
    $("#channel-description").textContent = `${member.email} - private conversation`;
    $("#open-pins").hidden = true;
    $("#message-input").placeholder = `Message ${displayName}`;
    $("#message-input").disabled = false;
    markConversationRead("direct", member.id);

    const messages = state.directMessages.filter((message) => (
      message.sender_id === currentSession.user.id && message.recipient_id === member.id
    ) || (
      message.sender_id === member.id && message.recipient_id === currentSession.user.id
    ));
    const pane = $("#message-pane");
    pane.replaceChildren();
    const intro = document.createElement("section");
    intro.className = "channel-intro";
    intro.innerHTML = `<div class="intro-hash">@</div><h2>${escapeHtml(displayName)}</h2><p>This private conversation is visible only to you and ${escapeHtml(displayName)}.</p>`;
    pane.append(intro);
    appendMessages(pane, messages);
    markMessagesSeen(messages);
    renderChannels();
    renderDirectMessages();
    if (scrollToBottom) requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
    updateSendState();
    return;
  }

  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel) {
    $("#composer-wrap").hidden = false;
    $("#conversation-symbol").textContent = "#";
    $("#channel-name").textContent = "Vine Connect";
    $("#channel-description").textContent = "Your workspace has no channels yet.";
    $("#open-pins").hidden = true;
    $("#open-meeting").hidden = true;
    $("#message-input").placeholder = "No channel selected";
    $("#message-input").disabled = true;
    $("#message-pane").innerHTML = '<div class="empty-channel"><span class="empty-icon">#</span><h2>No channels yet</h2><p>An administrator can create the first channel.</p></div>';
    updateSendState();
    return;
  }

  if (channel.channel_type === "files") {
    renderFileLibrary(channel);
    return;
  }

  $("#composer-wrap").hidden = false;
  const canPost = channel.posting_policy !== "admins" || currentProfile?.role === "admin";
  $("#message-input").disabled = !canPost;
  $("#conversation-symbol").textContent = "#";
  $("#channel-name").textContent = channel.name;
  $("#channel-description").textContent = channel.description || "Vine Solutions company conversation";
  $("#open-pins").hidden = false;
  $("#pin-count").textContent = state.pins.filter((pin) => pin.channel_id === channel.id).length;
  $("#message-input").placeholder = canPost ? `Message #${channel.name}` : "This is an admin announcement channel";
  const messages = state.messages.filter((message) => message.channel_id === channel.id);
  const pane = $("#message-pane");
  pane.replaceChildren();

  const intro = document.createElement("section");
  intro.className = "channel-intro";
  intro.innerHTML = `<div class="intro-hash">#</div><h2>${escapeHtml(channel.name)}</h2><p>${escapeHtml(channel.description || `This is the start of #${channel.name}.`)}</p>`;
  pane.append(intro);
  markConversationRead("channel", channel.id);
  appendMessages(pane, messages);
  markMessagesSeen(messages);
  renderChannels();
  renderDirectMessages();

  if (scrollToBottom) requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
  updateSendState();
}

function renderFileLibrary(channel) {
  const channelItems = state.fileItems.filter((item) => item.channel_id === channel.id);
  const currentFolder = channelItems.find((item) => item.id === state.selectedFileFolderId && item.item_type === "folder") || null;
  if (state.selectedFileFolderId && !currentFolder) state.selectedFileFolderId = null;

  $("#composer-wrap").hidden = true;
  $("#open-meeting").hidden = true;
  $("#open-pins").hidden = true;
  $("#conversation-symbol").textContent = "\uD83D\uDCC1";
  $("#channel-name").textContent = channel.name;
  $("#channel-description").textContent = channel.description || "Shared files for this channel";

  const pane = $("#message-pane");
  pane.replaceChildren();
  const library = document.createElement("section");
  library.className = "file-library";

  const heading = document.createElement("div");
  heading.className = "file-library-heading";
  const title = document.createElement("div");
  title.className = "file-library-title";
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "FILES LIBRARY";
  const headingText = document.createElement("h2");
  headingText.textContent = currentFolder?.name || channel.name;
  const description = document.createElement("p");
  const usedBytes = channelItems.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
  description.textContent = `Documents are kept in this channel's dedicated Supabase storage folder. ${formatBytes(usedBytes)} of ${formatBytes(channel.storage_quota_bytes || 1073741824)} used.`;
  title.append(eyebrow, headingText, description);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "file-library-search";
  search.placeholder = "Search files in this channel...";
  search.value = state.fileSearch;
  search.addEventListener("input", () => {
    state.fileSearch = search.value;
    renderFileLibrary(channel);
    requestAnimationFrame(() => {
      const nextSearch = document.querySelector(".file-library-search");
      nextSearch?.focus();
      nextSearch?.setSelectionRange(nextSearch.value.length, nextSearch.value.length);
    });
  });
  title.append(search);

  const actions = document.createElement("div");
  actions.className = "file-library-actions";
  const newFolderButton = document.createElement("button");
  newFolderButton.type = "button";
  newFolderButton.className = "secondary-button compact-button";
  newFolderButton.textContent = "+ New folder";
  newFolderButton.disabled = !state.filesFeatureReady;
  newFolderButton.addEventListener("click", () => createLibraryFolder(channel));
  const uploadButton = document.createElement("button");
  uploadButton.type = "button";
  uploadButton.className = "primary-button compact-button";
  uploadButton.textContent = "\u2191 Upload files";
  uploadButton.disabled = !state.filesFeatureReady || state.busy;
  uploadButton.addEventListener("click", () => beginLibraryUpload(channel));
  actions.append(newFolderButton, uploadButton);
  heading.append(title, actions);
  library.append(heading);

  const breadcrumbs = document.createElement("nav");
  breadcrumbs.className = "file-breadcrumbs";
  breadcrumbs.setAttribute("aria-label", "File library folder path");
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.textContent = channel.name;
  rootButton.addEventListener("click", () => browseLibraryFolder(null));
  breadcrumbs.append(rootButton);
  getLibraryAncestors(currentFolder, channelItems).forEach((folder) => {
    const divider = document.createElement("span");
    divider.textContent = "/";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = folder.name;
    button.addEventListener("click", () => browseLibraryFolder(folder.id));
    breadcrumbs.append(divider, button);
  });
  library.append(breadcrumbs);

  if (!state.filesFeatureReady) {
    const setup = document.createElement("div");
    setup.className = "file-library-setup";
    setup.innerHTML = '<strong>One Supabase update is required</strong><span>Run <code>vine-connect-files-update.sql</code> in the Supabase SQL Editor before creating a Files channel.</span>';
    library.append(setup);
    pane.append(library);
    renderChannels();
    renderDirectMessages();
    return;
  }

  const list = document.createElement("div");
  list.className = "file-library-list";
  const currentItems = channelItems
    .filter((item) => (item.parent_id || null) === (state.selectedFileFolderId || null))
    .filter((item) => !state.fileSearch || `${item.name} ${item.description || ""}`.toLowerCase().includes(state.fileSearch.toLowerCase()))
    .sort((a, b) => Number(b.item_type === "folder") - Number(a.item_type === "folder") || a.name.localeCompare(b.name));

  const galleryImages = currentItems.filter((item) => item.item_type === "file" && String(item.mime_type || "").startsWith("image/")).slice(0, 24);
  if (galleryImages.length) {
    const gallery = document.createElement("section");
    gallery.className = "file-image-gallery";
    const galleryTitle = document.createElement("h3");
    galleryTitle.textContent = "Image gallery";
    const grid = document.createElement("div");
    galleryImages.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = `Preview ${item.name}`;
      const fallback = document.createElement("span");
      fallback.textContent = "IMAGE";
      const label = document.createElement("small");
      label.textContent = item.name;
      button.append(fallback, label);
      button.addEventListener("click", () => openLibraryItem(channel, item));
      grid.append(button);
      hydrateLibraryThumbnail(button, item);
    });
    gallery.append(galleryTitle, grid);
    library.append(gallery);
  }

  if (!currentItems.length) {
    const empty = document.createElement("div");
    empty.className = "file-library-empty";
    empty.innerHTML = '<span>\uD83D\uDCC2</span><strong>This folder is empty</strong><p>Upload documents or create a folder to organize this library.</p>';
    list.append(empty);
  } else {
    const columns = document.createElement("div");
    columns.className = "file-library-columns";
    columns.innerHTML = "<span>Name</span><span>Added by</span><span>Modified</span><span>Size</span><span></span>";
    list.append(columns);
    currentItems.forEach((item) => list.append(renderLibraryItem(channel, item)));
  }

  library.append(list);
  pane.append(library);
  markConversationRead("channel", channel.id);
  renderChannels();
  renderDirectMessages();
}

async function hydrateLibraryThumbnail(button, item) {
  const { data } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(item.storage_path, 600);
  if (!data?.signedUrl || !button.isConnected) return;
  const image = document.createElement("img");
  image.src = data.signedUrl;
  image.alt = "";
  button.replaceChildren(image, button.querySelector("small"));
}

function renderLibraryItem(channel, item) {
  const row = document.createElement("div");
  row.className = "file-library-row";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "file-item-open";
  open.title = `Open ${item.name} in a new tab`;
  const icon = document.createElement("span");
  icon.className = `file-type-icon ${item.item_type}`;
  icon.textContent = item.item_type === "folder" ? "\uD83D\uDCC1" : fileTypeLabel(item);
  const name = document.createElement("span");
  name.className = "file-item-name";
  name.textContent = item.name;
  const external = document.createElement("span");
  external.className = "new-tab-mark";
  external.textContent = "\u2197";
  open.append(icon, name, external);
  open.addEventListener("click", () => openLibraryItem(channel, item));

  const owner = document.createElement("span");
  owner.className = "file-item-meta";
  const uploader = state.members.find((member) => member.id === item.uploaded_by);
  owner.textContent = uploader?.display_name || uploader?.email?.split("@")[0] || "Vine member";
  const modified = document.createElement("span");
  modified.className = "file-item-meta";
  modified.textContent = formatDateLabel(item.updated_at || item.created_at);
  const size = document.createElement("span");
  size.className = "file-item-meta";
  size.textContent = item.item_type === "folder" ? "Folder" : formatBytes(item.size_bytes || 0);
  const controls = document.createElement("span");
  controls.className = "file-item-controls";
  if (item.item_type === "file") {
    const favorite = state.fileFavorites.some((entry) => entry.file_item_id === item.id);
    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.title = favorite ? "Remove from favorites" : "Add to favorites";
    favoriteButton.setAttribute("aria-label", favoriteButton.title);
    favoriteButton.textContent = favorite ? "\u2605" : "\u2606";
    favoriteButton.addEventListener("click", () => toggleFileFavorite(item));
    controls.append(favoriteButton);
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.title = "Edit description and retention";
    detailsButton.setAttribute("aria-label", detailsButton.title);
    detailsButton.textContent = "\u24D8";
    detailsButton.addEventListener("click", () => editFileDetails(item));
    const historyButton = document.createElement("button");
    historyButton.type = "button";
    historyButton.title = "Version history";
    historyButton.setAttribute("aria-label", historyButton.title);
    historyButton.textContent = "\u21BA";
    historyButton.addEventListener("click", () => openFileVersionHistory(item));
    controls.append(detailsButton, historyButton);
    if (item.uploaded_by === currentSession?.user.id || currentProfile?.role === "admin") {
      const replaceButton = document.createElement("button");
      replaceButton.type = "button";
      replaceButton.title = "Replace with a new version";
      replaceButton.setAttribute("aria-label", replaceButton.title);
      replaceButton.textContent = "\u21C5";
      replaceButton.addEventListener("click", () => replaceLibraryFile(item));
      controls.append(replaceButton);
    }
  }
  const canDelete = currentProfile?.role === "admin" || (item.item_type !== "folder" && item.uploaded_by === currentSession?.user.id);
  if (canDelete) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Delete ${item.name}`;
    remove.setAttribute("aria-label", `Delete ${item.name}`);
    remove.textContent = "\u00D7";
    remove.addEventListener("click", () => deleteLibraryItem(channel, item));
    controls.append(remove);
  }
  row.append(open, owner, modified, size, controls);
  return row;
}

function getLibraryAncestors(folder, items) {
  if (!folder) return [];
  const ancestors = [];
  let current = folder;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.unshift(current);
    current = items.find((item) => item.id === current.parent_id && item.item_type === "folder") || null;
  }
  return ancestors;
}

function browseLibraryFolder(folderId) {
  state.selectedFileFolderId = folderId || null;
  const url = new URL(window.location.href);
  url.searchParams.set("channel", state.selectedChannelId);
  if (state.selectedFileFolderId) url.searchParams.set("folder", state.selectedFileFolderId);
  else url.searchParams.delete("folder");
  replaceCurrentUrl(url);
  renderConversation(false);
}

function clearFileLibraryDeepLink() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("channel") && !url.searchParams.has("folder")) return;
  url.searchParams.delete("channel");
  url.searchParams.delete("folder");
  replaceCurrentUrl(url);
}

function replaceCurrentUrl(url) {
  try {
    window.history.replaceState(null, "", url);
  } catch (_error) {
    // Some browsers restrict history changes when previewing the app from file://.
  }
}

function beginLibraryUpload(channel) {
  if (!state.filesFeatureReady || state.busy) return;
  state.libraryUploadContext = { channelId: channel.id, parentId: state.selectedFileFolderId || null };
  $("#library-file-input").click();
}

async function uploadLibraryFiles(fileList) {
  const input = $("#library-file-input");
  const files = [...(fileList || [])];
  const context = state.libraryUploadContext;
  input.value = "";
  if (!files.length || !context || !state.filesFeatureReady || state.busy) return;
  const channel = state.channels.find((item) => item.id === context.channelId && item.channel_type === "files");
  if (!channel) return showToast("This Files channel is no longer available.", "error");
  const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized) return showToast(`${oversized.name} is larger than the 30 MB per-file limit.`, "error");
  try {
    await apiRequest("/files/validate", { method: "POST", body: { channelId: channel.id, files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })) } });
  } catch (error) {
    if (![404, 503].includes(error.status)) return showToast(error.message, "error");
  }

  const existingNames = new Set(state.fileItems
    .filter((item) => item.channel_id === channel.id && (item.parent_id || null) === context.parentId)
    .map((item) => item.name.toLowerCase()));
  const duplicate = files.find((file) => existingNames.has(file.name.toLowerCase()));
  if (duplicate) return showToast(`${duplicate.name} already exists in this folder.`, "error");

  state.busy = true;
  renderConversation(false);
  let uploaded = 0;
  try {
    for (const file of files) {
      const itemId = makeId();
      const contentHash = state.platformReady ? await fileSha256(file).catch(() => null) : null;
      if (contentHash && state.fileItems.some((item) => item.channel_id === channel.id && item.content_hash === contentHash)) {
        throw new Error(`${file.name} is a duplicate of a file already stored in this channel.`);
      }
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const path = `${currentSession.user.id}/libraries/${channel.id}/${itemId}-${safeName}`;
      const { error: storageError } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (storageError) throw storageError;

      const metadata = {
        id: itemId,
        channel_id: channel.id,
        parent_id: context.parentId,
        name: file.name,
        item_type: "file",
        storage_path: path,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        uploaded_by: currentSession.user.id,
      };
      if (state.platformReady) metadata.content_hash = contentHash;
      const { error: metadataError } = await supabaseClient.from("file_library_items").insert(metadata);
      if (metadataError) {
        await supabaseClient.storage.from(STORAGE_BUCKET).remove([path]);
        throw metadataError;
      }
      existingNames.add(file.name.toLowerCase());
      uploaded += 1;
    }
    await loadWorkspace(false);
    showToast(`${uploaded} file${uploaded === 1 ? "" : "s"} uploaded to ${channel.name}.`, "success");
  } catch (error) {
    await loadWorkspace(false);
    showToast(error.message || "The files could not be uploaded.", "error");
  } finally {
    state.busy = false;
    state.libraryUploadContext = null;
    renderConversation(false);
  }
}

async function createLibraryFolder(channel) {
  if (!state.filesFeatureReady || state.busy) return;
  const requested = window.prompt("Folder name");
  if (requested === null) return;
  const name = requested.trim().replace(/[\\/]+/g, "-").slice(0, 120);
  if (!name) return showToast("Enter a folder name.", "error");
  const duplicate = state.fileItems.some((item) => item.channel_id === channel.id
    && (item.parent_id || null) === (state.selectedFileFolderId || null)
    && item.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return showToast(`${name} already exists in this folder.`, "error");

  state.busy = true;
  const { error } = await supabaseClient.from("file_library_items").insert({
    channel_id: channel.id,
    parent_id: state.selectedFileFolderId || null,
    name,
    item_type: "folder",
    uploaded_by: currentSession.user.id,
  });
  state.busy = false;
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
  showToast(`${name} folder created.`, "success");
}

async function openLibraryItem(channel, item) {
  if (item.item_type === "folder") {
    const url = new URL(window.location.href);
    url.searchParams.set("channel", channel.id);
    url.searchParams.set("folder", item.id);
    window.open(url.href, "_blank", "noopener,noreferrer");
    return;
  }
  if (item.item_type === "link" && item.external_url) {
    window.open(item.external_url, "_blank", "noopener,noreferrer");
    return;
  }

  const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(item.storage_path, 600);
  if (error || !data?.signedUrl) {
    return showToast(error?.message || "The file could not be opened.", "error");
  }
  apiRequest(`/files/${item.id}/download`, { method: "POST" }).catch(() => {});
  $("#file-preview-title").textContent = item.name;
  $("#file-preview-meta").textContent = `${formatBytes(item.size_bytes || 0)} - Version ${item.version_number || 1}${item.description ? ` - ${item.description}` : ""}`;
  $("#file-preview-new-tab").href = data.signedUrl;
  const frame = $("#file-preview-frame");
  frame.replaceChildren();
  let preview;
  if (String(item.mime_type || "").startsWith("image/")) {
    preview = document.createElement("img");
    preview.alt = item.name;
  } else if (String(item.mime_type || "").startsWith("video/")) {
    preview = document.createElement("video");
    preview.controls = true;
  } else {
    preview = document.createElement("iframe");
    preview.title = `Preview ${item.name}`;
  }
  const officeTypes = ["word", "excel", "powerpoint", "msword", "ms-excel", "ms-powerpoint"];
  const isOfficeDocument = officeTypes.some((type) => String(item.mime_type || "").toLowerCase().includes(type)) || /\.(docx?|xlsx?|pptx?)$/i.test(item.name);
  preview.src = isOfficeDocument
    ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(data.signedUrl)}`
    : data.signedUrl;
  frame.append(preview);
  openModal("file-preview-modal");
}

async function editFileDetails(item) {
  const description = window.prompt("File description (leave blank to clear):", item.description || "");
  if (description === null) return;
  const currentRetention = item.retention_until ? String(item.retention_until).slice(0, 10) : "";
  const retention = window.prompt("Retention date in YYYY-MM-DD (leave blank for no expiration):", currentRetention);
  if (retention === null) return;
  if (retention && !/^\d{4}-\d{2}-\d{2}$/.test(retention)) return showToast("Use the date format YYYY-MM-DD.", "error");
  try {
    await apiRequest(`/files/${item.id}`, { method: "PATCH", body: { description: description.trim(), retentionUntil: retention ? new Date(`${retention}T23:59:59`).toISOString() : null } });
    await loadWorkspace(false);
    showToast("File details updated.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openFileVersionHistory(item) {
  const versions = [
    { version_number: item.version_number || 1, storage_path: item.storage_path, size_bytes: item.size_bytes, created_at: item.replaced_at || item.updated_at || item.created_at },
    ...state.fileVersions.filter((version) => version.file_item_id === item.id),
  ].sort((first, second) => Number(second.version_number) - Number(first.version_number));
  const items = versions.map((version) => ({
    message: { body: `${item.name} - ${formatBytes(version.size_bytes || 0)}`, created_at: version.created_at },
    label: `Version ${version.version_number}`,
    action: async () => {
      const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(version.storage_path, 600);
      if (error || !data?.signedUrl) return showToast(error?.message || "This version could not be opened.", "error");
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    },
  }));
  showActivityModal("Version history", `Versions of ${item.name}.`, items);
}

function replaceLibraryFile(item) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,video/mp4,video/webm,video/quicktime,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return showToast(`${file.name} is larger than 30 MB.`, "error");
    try {
      await apiRequest("/files/validate", { method: "POST", body: { channelId: item.channel_id, replaceFileId: item.id, files: [{ name: file.name, size: file.size, type: file.type }] } });
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-") || "file";
      const storagePath = `${currentSession.user.id}/libraries/${item.channel_id}/${item.id}/v${Number(item.version_number || 1) + 1}-${makeId()}-${safeName}`;
      const { error: uploadError } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(storagePath, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (uploadError) throw uploadError;
      const contentHash = await fileSha256(file).catch(() => null);
      try {
        await apiRequest(`/files/${item.id}/replace`, { method: "POST", body: { storagePath, sizeBytes: file.size, mimeType: file.type || "application/octet-stream", contentHash } });
      } catch (error) {
        await supabaseClient.storage.from(STORAGE_BUCKET).remove([storagePath]);
        throw error;
      }
      await loadWorkspace(false);
      showToast(`${item.name} replaced with version ${Number(item.version_number || 1) + 1}.`, "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  }, { once: true });
  input.click();
}

async function fileSha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deleteLibraryItem(channel, item) {
  if (state.busy) return;
  const canDelete = currentProfile?.role === "admin" || (item.item_type !== "folder" && item.uploaded_by === currentSession?.user.id);
  if (!canDelete) return showToast("Only an administrator can delete this folder.", "error");
  if (!window.confirm(`Delete ${item.name}${item.item_type === "folder" ? " and everything inside it" : ""}?\n\nThis cannot be undone.`)) return;

  const ids = new Set([item.id]);
  let changed = true;
  while (changed) {
    changed = false;
    state.fileItems.forEach((candidate) => {
      if (candidate.channel_id === channel.id && candidate.parent_id && ids.has(candidate.parent_id) && !ids.has(candidate.id)) {
        ids.add(candidate.id);
        changed = true;
      }
    });
  }
  const paths = [
    ...state.fileItems.filter((candidate) => ids.has(candidate.id)).map((candidate) => candidate.storage_path),
    ...state.fileVersions.filter((version) => ids.has(version.file_item_id)).map((version) => version.storage_path),
  ].filter(Boolean);
  state.busy = true;
  if (paths.length) {
    const { error: storageError } = await supabaseClient.storage.from(STORAGE_BUCKET).remove(paths);
    if (storageError) {
      state.busy = false;
      return showToast(storageError.message, "error");
    }
  }
  const { error } = await supabaseClient.from("file_library_items").delete().eq("id", item.id);
  state.busy = false;
  if (error) return showToast(error.message, "error");
  if (ids.has(state.selectedFileFolderId)) state.selectedFileFolderId = null;
  await loadWorkspace(false);
  showToast(`${item.name} deleted.`, "success");
}

function fileTypeLabel(item) {
  const extension = item.name.includes(".") ? item.name.split(".").pop().slice(0, 4).toUpperCase() : "FILE";
  return extension || "FILE";
}

function getMeetingContext() {
  if (!currentSession?.user || !currentProfile) return null;
  if (state.selectedDirectUserId) {
    const member = state.members.find((item) => item.id === state.selectedDirectUserId);
    if (!member) return null;
    const participantIds = [currentSession.user.id, member.id]
      .sort()
      .map((id) => id.replace(/[^a-z0-9]/gi, ""))
      .join("");
    return {
      roomName: `VineConnectDirect${participantIds}`,
      title: `Meeting with ${member.display_name || member.email.split("@")[0]}`,
      scope: "direct",
      channelId: null,
      directUserId: member.id,
      participantIds: [currentSession.user.id, member.id],
    };
  }

  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel) return null;
  return {
    roomName: `VineConnectChannel${channel.id.replace(/[^a-z0-9]/gi, "")}`,
    title: `#${channel.name} meeting`,
    scope: "channel",
    channelId: channel.id,
    directUserId: null,
    participantIds: state.members.map((member) => member.id),
  };
}

function meetingContextFromRecord(meeting) {
  if (!meeting) return null;
  return {
    roomName: meeting.room_name,
    title: meeting.title,
    scope: meeting.scope,
    channelId: meeting.channel_id,
    directUserId: meeting.direct_user_id,
    participantIds: state.meetingParticipants.filter((item) => item.meeting_id === meeting.id).map((item) => item.user_id),
  };
}

async function openMeeting(meetingRecord = null) {
  const context = meetingRecord ? meetingContextFromRecord(meetingRecord) : getMeetingContext();
  if (!context) return showToast("Open a channel or direct message first.", "error");

  closeMeeting();
  state.activeMeetingRecord = meetingRecord;
  const frame = $("#meeting-frame");
  frame.innerHTML = '<div class="meeting-loading"><i class="glyph spin">&#9696;</i> Preparing the meeting...</div>';
  $("#meeting-title").textContent = context.title;
  $("#meeting-provider").textContent = "Preparing secure meeting...";
  $("#meeting-new-tab").href = "#";
  openModal("meeting-modal");

  let access;
  try {
    access = await requestMeetingAccess(context, meetingRecord);
  } catch (error) {
    access = fallbackMeetingAccess(context);
    $("#meeting-provider").textContent = "Demo service - add JaaS keys in Hostinger for protected meetings";
    if (error?.name !== "AbortError") console.warn("Secure meeting backend unavailable; using demo meeting.", error);
  }

  $("#meeting-new-tab").href = access.meetingUrl;
  if (access.provider === "jaas") $("#meeting-provider").textContent = "Protected by Vine Connect sign-in";

  try {
    await loadJitsiExternalApi(access.externalApiUrl);
  } catch (_error) {
    frame.innerHTML = '<div class="meeting-error"><strong>The embedded meeting could not load.</strong><span>Check your internet connection, or use Open in new tab.</span></div>';
    return;
  }

  if ($("#meeting-modal").hidden || state.activeMeetingRecord !== meetingRecord) return;
  frame.replaceChildren();
  jitsiApi = new window.JitsiMeetExternalAPI(access.domain, {
    roomName: access.roomName,
    jwt: access.jwt || undefined,
    width: "100%",
    height: "100%",
    parentNode: frame,
    onload: () => frame.querySelector(".meeting-loading")?.remove(),
    lang: "en",
    userInfo: {
      email: currentProfile.email,
      displayName: currentProfile.display_name || currentProfile.email.split("@")[0],
    },
    configOverwrite: {
      startWithAudioMuted: true,
      startWithVideoMuted: false,
      prejoinConfig: { enabled: true },
      disableDeepLinking: true,
    },
  });
  window.setTimeout(() => frame.querySelector(".meeting-loading")?.remove(), 6000);
  jitsiApi.addEventListener("readyToClose", closeMeeting);
  jitsiApi.addEventListener("videoConferenceJoined", () => markMeetingLive(meetingRecord));
}

function closeMeeting() {
  if (jitsiApi) {
    try { jitsiApi.dispose(); } catch (_error) { /* The meeting may already be closed. */ }
    jitsiApi = null;
  }
  state.activeMeetingRecord = null;
  const frame = $("#meeting-frame");
  if (frame) frame.innerHTML = '<div class="meeting-loading"><i class="glyph spin">&#9696;</i> Preparing the meeting...</div>';
  const modal = $("#meeting-modal");
  if (modal) modal.hidden = true;
}

async function requestMeetingAccess(context, meetingRecord) {
  const endpoint = meetingApiEndpoint("/meetings/join-token");
  if (!endpoint || !currentSession?.access_token) throw new Error("The secure meeting API is not available on this host.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentSession.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        roomName: context.roomName,
        title: context.title,
        meetingId: meetingRecord?.id || null,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Meeting service returned ${response.status}.`);
    if (!payload.domain || !payload.roomName || !payload.externalApiUrl || !payload.meetingUrl) {
      throw new Error("The meeting service returned an incomplete response.");
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

function meetingApiEndpoint(path) {
  if (!/^https?:$/.test(window.location.protocol)) return "";
  const configuredBase = String(window.VINE_SUPABASE_CONFIG?.meetingApiUrl || "").trim().replace(/\/$/, "");
  if (!configuredBase) return `/api${path}`;
  return `${configuredBase}${/\/api$/i.test(configuredBase) ? "" : "/api"}${path}`;
}

function fallbackMeetingAccess(context) {
  return {
    provider: "demo",
    domain: "meet.jit.si",
    roomName: context.roomName,
    jwt: "",
    externalApiUrl: "https://meet.jit.si/external_api.js",
    meetingUrl: `https://meet.jit.si/${encodeURIComponent(context.roomName)}`,
  };
}

function loadJitsiExternalApi(scriptUrl) {
  if (loadedJitsiScriptUrl === scriptUrl && typeof window.JitsiMeetExternalAPI === "function") return Promise.resolve();
  if (jitsiScriptPromise && loadedJitsiScriptUrl === scriptUrl) return jitsiScriptPromise;
  document.querySelectorAll("script[data-vine-jitsi]").forEach((script) => script.remove());
  loadedJitsiScriptUrl = scriptUrl;
  window.JitsiMeetExternalAPI = undefined;
  jitsiScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => reject(new Error("Meeting library timed out.")), 15000);
    script.src = scriptUrl;
    script.async = true;
    script.dataset.vineJitsi = "true";
    script.onload = () => {
      window.clearTimeout(timeout);
      if (typeof window.JitsiMeetExternalAPI === "function") resolve();
      else reject(new Error("Meeting library did not initialize."));
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Meeting library could not be downloaded."));
    };
    document.head.append(script);
  }).finally(() => { jitsiScriptPromise = null; });
  return jitsiScriptPromise;
}

async function markMeetingLive(meeting) {
  if (!meeting || !state.meetingsReady || (meeting.host_id !== currentSession?.user.id && currentProfile?.role !== "admin")) return;
  const changes = { status: "live" };
  if (!meeting.started_at) changes.started_at = new Date().toISOString();
  const { error } = await supabaseClient.from("meetings").update(changes).eq("id", meeting.id);
  if (!error) scheduleReload(false);
}

function openMeetingsHub() {
  renderMeetingsHub();
  openModal("meetings-hub-modal");
  closeSidebar();
}

function visibleMeetings() {
  const userId = currentSession?.user.id;
  if (!userId) return [];
  const invitedIds = new Set(state.meetingParticipants.filter((item) => item.user_id === userId).map((item) => item.meeting_id));
  return state.meetings.filter((meeting) => meeting.host_id === userId || invitedIds.has(meeting.id));
}

function meetingEndTime(meeting) {
  return new Date(meeting.starts_at).getTime() + Number(meeting.duration_minutes || 30) * 60 * 1000;
}

function isPastMeeting(meeting) {
  return ["ended", "cancelled"].includes(meeting.status) || meetingEndTime(meeting) < Date.now();
}

function updateMeetingsBadge() {
  const badge = $("#meeting-total");
  if (!badge) return;
  const count = state.meetingsReady
    ? visibleMeetings().filter((meeting) => !isPastMeeting(meeting) && meeting.status !== "cancelled").length
    : 0;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function renderMeetingsHub() {
  const setupNote = $("#meeting-setup-note");
  setupNote.hidden = state.meetingsReady;
  $("#open-schedule-meeting").disabled = !state.meetingsReady;
  $("#start-context-meeting").disabled = !getMeetingContext();

  const meetings = visibleMeetings();
  const now = new Date();
  const today = meetings.filter((meeting) => !isPastMeeting(meeting) && new Date(meeting.starts_at).toDateString() === now.toDateString());
  const upcoming = meetings.filter((meeting) => !isPastMeeting(meeting)).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const past = meetings.filter(isPastMeeting).sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  $("#meeting-today-count").textContent = String(today.length);
  $("#meeting-upcoming-count").textContent = String(upcoming.length);
  $("#meeting-past-count").textContent = String(past.length);
  renderMeetingList("upcoming-meetings-list", upcoming, false);
  renderMeetingList("past-meetings-list", past.slice(0, 20), true);
}

function renderMeetingList(containerId, meetings, past) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  if (!meetings.length) {
    const empty = document.createElement("div");
    empty.className = "meeting-list-empty";
    empty.innerHTML = past
      ? "<strong>No recent meetings</strong><span>Completed and cancelled meetings appear here.</span>"
      : "<strong>No meetings scheduled</strong><span>Plan the next team sync or start one now.</span>";
    container.append(empty);
    return;
  }
  meetings.forEach((meeting) => container.append(renderMeetingCard(meeting, past)));
}

function renderMeetingCard(meeting, past) {
  const card = document.createElement("article");
  card.className = `meeting-card${meeting.status === "live" ? " live" : ""}${meeting.status === "cancelled" ? " cancelled" : ""}`;
  const date = new Date(meeting.starts_at);
  const dateBlock = document.createElement("div");
  dateBlock.className = "meeting-date-block";
  dateBlock.innerHTML = `<span>${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "short" }).format(date))}</span><strong>${date.getDate()}</strong>`;
  const copy = document.createElement("div");
  copy.className = "meeting-card-copy";
  const status = meeting.status === "live" ? "Live now" : meeting.status === "cancelled" ? "Cancelled" : past ? "Finished" : meetingScopeLabel(meeting);
  const host = state.members.find((member) => member.id === meeting.host_id);
  const hostName = host?.display_name || host?.email?.split("@")[0] || "Vine member";
  copy.innerHTML = `<div class="meeting-card-title"><h4>${escapeHtml(meeting.title)}</h4><span class="meeting-status ${escapeHtml(meeting.status)}">${escapeHtml(status)}</span></div><p>${escapeHtml(formatMeetingDateTime(meeting.starts_at))} &middot; ${Number(meeting.duration_minutes || 30)} min</p><small>Hosted by ${escapeHtml(hostName)}</small>`;

  const invited = state.meetingParticipants.filter((item) => item.meeting_id === meeting.id);
  const avatars = document.createElement("div");
  avatars.className = "meeting-card-avatars";
  invited.slice(0, 5).forEach((participant) => {
    const member = state.members.find((item) => item.id === participant.user_id);
    if (!member) return;
    const avatar = document.createElement("span");
    avatar.className = `mini-avatar ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    avatar.title = member.display_name || member.email;
    avatars.append(avatar);
  });
  if (invited.length > 5) {
    const more = document.createElement("strong");
    more.textContent = `+${invited.length - 5}`;
    avatars.append(more);
  }

  const actions = document.createElement("div");
  actions.className = "meeting-card-actions";
  if (meeting.status !== "cancelled" && !past) {
    const join = document.createElement("button");
    join.type = "button";
    join.className = "primary-button compact-button";
    join.textContent = meeting.status === "live" ? "Join now" : "Join";
    join.addEventListener("click", () => {
      closeModal("meetings-hub-modal");
      openMeeting(meeting);
    });
    actions.append(join);
  }
  if (!past && (meeting.host_id === currentSession?.user.id || currentProfile?.role === "admin")) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "meeting-cancel-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => cancelMeeting(meeting));
    actions.append(cancel);
  }
  copy.append(avatars);
  card.append(dateBlock, copy, actions);
  return card;
}

function meetingScopeLabel(meeting) {
  if (meeting.scope === "channel") {
    const channel = state.channels.find((item) => item.id === meeting.channel_id);
    return channel ? `#${channel.name}` : "Channel";
  }
  if (meeting.scope === "direct") {
    const member = state.members.find((item) => item.id === meeting.direct_user_id);
    return member?.display_name || "Direct meeting";
  }
  return "Company-wide";
}

function formatMeetingDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

async function cancelMeeting(meeting) {
  if (!window.confirm(`Cancel “${meeting.title}”?`)) return;
  const { error } = await supabaseClient.from("meetings").update({ status: "cancelled" }).eq("id", meeting.id);
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
  renderMeetingsHub();
  showToast("Meeting cancelled.", "success");
}

function openScheduleMeeting() {
  if (!state.meetingsReady) return showToast("Run vine-connect-meetings-update.sql in Supabase first.", "error");
  populateMeetingContextOptions();
  const next = new Date(Date.now() + 30 * 60 * 1000);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0);
  $("#scheduled-meeting-date").value = localDateInputValue(next);
  $("#scheduled-meeting-time").value = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  $("#scheduled-meeting-name").value = getMeetingContext()?.title || "Team meeting";
  renderMeetingInviteList(defaultMeetingInvitees($("#scheduled-meeting-context").value));
  $("#scheduled-meeting-context").onchange = () => renderMeetingInviteList(defaultMeetingInvitees($("#scheduled-meeting-context").value));
  hideError("schedule-meeting-error");
  closeModal("meetings-hub-modal");
  openModal("schedule-meeting-modal");
}

function populateMeetingContextOptions() {
  const select = $("#scheduled-meeting-context");
  select.replaceChildren();
  const options = [{ value: "workspace", label: "Company-wide" }];
  state.channels.filter((channel) => channel.channel_type !== "files").sort(sortChannels).forEach((channel) => {
    options.push({ value: `channel:${channel.id}`, label: `#${channel.name}` });
  });
  state.members.filter((member) => member.id !== currentSession?.user.id).forEach((member) => {
    options.push({ value: `direct:${member.id}`, label: `Direct: ${member.display_name || member.email.split("@")[0]}` });
  });
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  });
  if (state.selectedDirectUserId) select.value = `direct:${state.selectedDirectUserId}`;
  else if (state.selectedChannelId && state.channels.find((channel) => channel.id === state.selectedChannelId)?.channel_type !== "files") select.value = `channel:${state.selectedChannelId}`;
}

function defaultMeetingInvitees(contextValue) {
  const [scope, id] = String(contextValue || "workspace").split(":");
  if (scope === "direct" && id) return new Set([id]);
  return new Set(state.members.filter((member) => member.id !== currentSession?.user.id).map((member) => member.id));
}

function renderMeetingInviteList(selectedIds = new Set()) {
  const container = $("#meeting-invite-list");
  container.replaceChildren();
  state.members.filter((member) => member.id !== currentSession?.user.id).forEach((member) => {
    const label = document.createElement("label");
    label.className = "meeting-invite-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "meeting-invite";
    checkbox.value = member.id;
    checkbox.checked = selectedIds.has(member.id);
    const avatar = document.createElement("span");
    avatar.className = `avatar small ${avatarClass(member.id)} presence-${memberPresenceStatus(member)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    avatar.title = memberLastActiveLabel(member);
    const copy = document.createElement("span");
    copy.innerHTML = `<strong>${escapeHtml(member.display_name || member.email.split("@")[0])}</strong><small>${escapeHtml(member.job_title || titleCase(member.role))}</small>`;
    label.append(checkbox, avatar, copy);
    container.append(label);
  });
}

async function scheduleMeeting(event) {
  event.preventDefault();
  if (!state.meetingsReady || state.busy) return;
  hideError("schedule-meeting-error");
  const startsAt = new Date(`${$("#scheduled-meeting-date").value}T${$("#scheduled-meeting-time").value}`);
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < Date.now() - 60 * 1000) {
    return showFormError("schedule-meeting-error", "Choose a future date and time.");
  }
  const title = $("#scheduled-meeting-name").value.trim();
  const [scope, contextId] = $("#scheduled-meeting-context").value.split(":");
  const invitedIds = $$('input[name="meeting-invite"]:checked').map((input) => input.value);
  const meetingId = makeId();
  const meeting = {
    id: meetingId,
    title,
    description: "",
    room_name: `VineConnectMeeting${meetingId.replace(/[^a-z0-9]/gi, "")}`,
    host_id: currentSession.user.id,
    scope,
    channel_id: scope === "channel" ? contextId : null,
    direct_user_id: scope === "direct" ? contextId : null,
    starts_at: startsAt.toISOString(),
    duration_minutes: Number($("#scheduled-meeting-duration").value),
    status: "scheduled",
  };
  const button = $("#schedule-meeting-submit");
  setButtonBusy(button, true, "Scheduling...");
  const { error } = await supabaseClient.from("meetings").insert(meeting);
  if (error) {
    setButtonBusy(button, false, "Schedule meeting");
    return showFormError("schedule-meeting-error", error.message);
  }
  const participantIds = [...new Set([currentSession.user.id, ...invitedIds])];
  const rows = participantIds.map((userId) => ({
    meeting_id: meetingId,
    user_id: userId,
    participant_role: userId === currentSession.user.id ? "moderator" : "attendee",
    response: userId === currentSession.user.id ? "accepted" : "invited",
  }));
  const { error: participantError } = await supabaseClient.from("meeting_participants").insert(rows);
  if (participantError) {
    await supabaseClient.from("meetings").delete().eq("id", meetingId);
    setButtonBusy(button, false, "Schedule meeting");
    return showFormError("schedule-meeting-error", participantError.message);
  }
  setButtonBusy(button, false, "Schedule meeting");
  $("#schedule-meeting-form").reset();
  closeModal("schedule-meeting-modal");
  await loadWorkspace(false);
  openMeetingsHub();
  showToast("Meeting scheduled.", "success");
}

function localDateInputValue(date) {
  const offset = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function appendMessages(pane, messages) {
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-message-note";
    empty.textContent = "Start the conversation.";
    pane.append(empty);
  }

  let lastDate = "";
  messages.forEach((message) => {
    const dateLabel = formatDateLabel(message.created_at);
    if (dateLabel !== lastDate) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.innerHTML = `<span>${escapeHtml(dateLabel)}</span>`;
      pane.append(divider);
      lastDate = dateLabel;
    }
    pane.append(renderMessage(message));
  });
}

function renderMessage(message) {
  const authorId = message.author_id || message.sender_id;
  const author = message.author || state.members.find((member) => member.id === authorId) || {};
  const name = author.display_name || author.email?.split("@")[0] || "Vine member";
  const row = document.createElement("article");
  row.className = "message-row";
  row.dataset.messageId = message.id;

  const avatar = document.createElement("span");
  avatar.className = `avatar ${avatarClass(authorId)}`;
  avatar.textContent = getInitials(name);
  row.append(avatar);

  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const strong = document.createElement("strong");
  strong.textContent = name;
  const time = document.createElement("time");
  time.dateTime = message.created_at;
  time.textContent = formatTime(message.created_at);
  meta.append(strong, time);
  if (message.edited_at) {
    const edited = document.createElement("span");
    edited.className = "edited-label";
    edited.textContent = "edited";
    meta.append(edited);
  }
  content.append(meta);

  if (message.body) {
    const body = document.createElement("p");
    appendFormattedText(body, message.body);
    content.append(body);
  }

  const pin = message.channel_id ? state.pins.find((item) => item.message_id === message.id) : null;
  if (pin) {
    const pinned = document.createElement("span");
    pinned.className = "pinned-label";
    pinned.textContent = "\u2605 Pinned to this channel";
    content.append(pinned);
  }

  (Array.isArray(message.attachments) ? message.attachments : []).forEach((attachment) => {
    const holder = document.createElement("div");
    holder.className = "attachment-holder";
    holder.innerHTML = '<span class="attachment-preview-fallback spin">&#9696;</span>';
    content.append(holder);
    hydrateAttachment(holder, attachment);
  });

  const reactionTarget = reactionTargetFor(message);
  const reactionBar = renderReactionBar(reactionTarget);
  if (reactionBar) content.append(reactionBar);

  const replyCount = getThreadReplies(message).length;
  if (replyCount) {
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "thread-summary";
    summary.textContent = `${replyCount} ${replyCount === 1 ? "reply" : "replies"} - View thread`;
    summary.addEventListener("click", () => openThread(message));
    content.append(summary);
  }

  const seenBy = renderSeenBy(message);
  if (seenBy) content.append(seenBy);

  row.append(content);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const reactionButton = document.createElement("button");
  reactionButton.type = "button";
  reactionButton.title = "Add emoji reaction";
  reactionButton.setAttribute("aria-label", "Add emoji reaction");
  reactionButton.textContent = "\u263A";
  reactionButton.addEventListener("click", () => openReactionPicker(reactionTarget));
  const threadButton = document.createElement("button");
  threadButton.type = "button";
  threadButton.title = "Reply in thread";
  threadButton.setAttribute("aria-label", "Reply in thread");
  threadButton.textContent = "\u21B3";
  threadButton.addEventListener("click", () => openThread(message));
  const bookmark = state.bookmarks.find((item) => item.channel_message_id === message.id || item.direct_message_id === message.id);
  const bookmarkButton = document.createElement("button");
  bookmarkButton.type = "button";
  bookmarkButton.title = bookmark ? "Remove bookmark" : "Save private bookmark";
  bookmarkButton.setAttribute("aria-label", bookmark ? "Remove bookmark" : "Save private bookmark");
  bookmarkButton.textContent = bookmark ? "\uD83D\uDD16" : "\uD83D\uDD17";
  bookmarkButton.addEventListener("click", () => toggleBookmark(message));
  actions.append(reactionButton, threadButton, bookmarkButton);
  if (message.channel_id) {
    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.title = pin ? "Unpin message" : "Pin message";
    pinButton.setAttribute("aria-label", pin ? "Unpin message" : "Pin message");
    pinButton.textContent = pin ? "\u2605" : "\u2606";
    pinButton.addEventListener("click", () => togglePin(message));
    actions.append(pinButton);
  }
  if (authorId === currentSession?.user.id) {
    row.classList.add("own-message");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.title = "Edit message";
    editButton.setAttribute("aria-label", "Edit message");
    editButton.textContent = "\u270E";
    editButton.addEventListener("click", () => editMessage(message));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.title = "Delete message";
    deleteButton.setAttribute("aria-label", "Delete message");
    deleteButton.textContent = "\u00D7";
    deleteButton.addEventListener("click", () => deleteMessage(message));
    actions.append(editButton, deleteButton);
  }
  row.append(actions);
  return row;
}

function readReceiptKey(message, userId = currentSession?.user?.id) {
  if (!message?.id || !userId) return "";
  return `${message.channel_id ? "channel" : "direct"}:${message.id}:${userId}`;
}

function hasReadReceipt(message, userId) {
  return state.readReceipts.some((receipt) => receipt.user_id === userId && (
    (message.channel_id && receipt.channel_message_id === message.id)
    || (message.sender_id && receipt.direct_message_id === message.id)
  ));
}

async function markMessagesSeen(messages) {
  if (!state.readsReady || !currentSession?.user?.id || !Array.isArray(messages)) return;
  const userId = currentSession.user.id;
  const unseen = messages.filter((message) => {
    const authorId = message.author_id || message.sender_id;
    const key = readReceiptKey(message, userId);
    return authorId !== userId && key && !hasReadReceipt(message, userId) && !state.readReceiptPending.has(key);
  });
  if (!unseen.length) return;

  unseen.forEach((message) => state.readReceiptPending.add(readReceiptKey(message, userId)));
  const seenAt = new Date().toISOString();
  const channelRows = unseen.filter((message) => message.channel_id).map((message) => ({
    channel_message_id: message.id,
    direct_message_id: null,
    user_id: userId,
    seen_at: seenAt,
  }));
  const directRows = unseen.filter((message) => message.sender_id).map((message) => ({
    channel_message_id: null,
    direct_message_id: message.id,
    user_id: userId,
    seen_at: seenAt,
  }));

  let { error } = await supabaseClient.rpc("mark_vine_messages_seen", {
    target_channel_message_ids: channelRows.map((row) => row.channel_message_id),
    target_direct_message_ids: directRows.map((row) => row.direct_message_id),
  });

  if (error && (error.code === "PGRST202" || /mark_vine_messages_seen|schema cache/i.test(error.message || ""))) {
    const fallbackRequests = [];
    if (channelRows.length) {
      fallbackRequests.push(supabaseClient.from("message_reads").upsert(channelRows, {
        onConflict: "channel_message_id,user_id",
        ignoreDuplicates: true,
      }));
    }
    if (directRows.length) {
      fallbackRequests.push(supabaseClient.from("message_reads").upsert(directRows, {
        onConflict: "direct_message_id,user_id",
        ignoreDuplicates: true,
      }));
    }
    const fallbackResults = await Promise.all(fallbackRequests);
    error = fallbackResults.find((result) => result.error)?.error || null;
  }

  if (error) {
    unseen.forEach((message) => state.readReceiptPending.delete(readReceiptKey(message, userId)));
    console.warn("Vine Connect could not save one or more read receipts.", error);
    if (!state.readWriteErrorShown) {
      state.readWriteErrorShown = true;
      showToast("Seen receipts could not sync. Ask an admin to rerun the latest Supabase update.", "error");
    }
    return;
  }
  state.readWriteErrorShown = false;
  state.readReceipts.push(...channelRows, ...directRows);
}

function renderSeenBy(message) {
  const authorId = message.author_id || message.sender_id;
  if (authorId !== currentSession?.user?.id) return null;
  if (!state.readsReady) return renderSeenStatus("Sent - seen status unavailable", true);
  const receipts = state.readReceipts
    .filter((receipt) => receipt.user_id !== authorId && (
      (message.channel_id && receipt.channel_message_id === message.id)
      || (message.sender_id && receipt.direct_message_id === message.id)
    ))
    .sort((first, second) => new Date(first.seen_at).getTime() - new Date(second.seen_at).getTime());
  if (!receipts.length) return renderSeenStatus("Sent - not seen yet");

  const viewers = receipts.map((receipt) => ({ receipt, member: state.members.find((member) => member.id === receipt.user_id) })).filter((item) => item.member);
  if (!viewers.length) return renderSeenStatus("Sent - not seen yet");
  const container = document.createElement("div");
  container.className = "seen-by";
  const label = document.createElement("span");
  label.className = "seen-label";
  label.textContent = "Seen by";
  label.title = viewers.map(({ member, receipt }) => `${member.display_name || member.email} at ${new Date(receipt.seen_at).toLocaleString()}`).join("\n");
  container.append(label);
  viewers.slice(0, 7).forEach(({ member, receipt }) => {
    const name = member.display_name || member.email?.split("@")[0] || "Vine member";
    const avatar = document.createElement("span");
    avatar.className = `seen-avatar ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(name);
    avatar.title = `Seen by ${name} at ${new Date(receipt.seen_at).toLocaleString()}`;
    avatar.setAttribute("aria-hidden", "true");
    container.append(avatar);
  });
  if (viewers.length > 7) {
    const more = document.createElement("span");
    more.className = "seen-more";
    more.textContent = `+${viewers.length - 7}`;
    container.append(more);
  }
  return container;
}

function renderSeenStatus(text, unavailable = false) {
  const status = document.createElement("div");
  status.className = `seen-status${unavailable ? " unavailable" : ""}`;
  status.textContent = text;
  if (unavailable) status.title = "An administrator must run vine-connect-ordering-seen-update.sql in Supabase.";
  return status;
}

function appendFormattedText(container, text) {
  const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|@[a-zA-Z0-9._-]+)/g;
  let cursor = 0;
  for (const match of String(text || "").matchAll(pattern)) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      container.append(strong);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      const italic = document.createElement("em");
      italic.textContent = token.slice(1, -1);
      container.append(italic);
    } else {
      const mention = document.createElement("span");
      mention.className = "mention-token";
      mention.textContent = token;
      container.append(mention);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function applyTextFormat(inputId, marker, placeholder) {
  const input = document.getElementById(inputId);
  if (!input || input.disabled) return;
  state.composerTarget = inputId;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const selected = input.value.slice(start, end) || placeholder;
  const replacement = `${marker}${selected}${marker}`;
  input.setRangeText(replacement, start, end, "end");
  input.focus();
  input.setSelectionRange(start + marker.length, start + marker.length + selected.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertAtCursor(inputId, value) {
  const input = document.getElementById(inputId);
  if (!input || input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const prefix = start > 0 && !/\s/.test(input.value[start - 1]) ? " " : "";
  input.setRangeText(`${prefix}${value} `, start, end, "end");
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function memberHandle(member) {
  return String(member?.email || "member").split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").toLowerCase();
}

function openMentionPicker(inputId) {
  state.composerTarget = inputId;
  const container = $("#mention-picker-list");
  container.replaceChildren();
  state.members.forEach((member) => {
    const button = document.createElement("button");
    button.type = "button";
    const avatar = document.createElement("span");
    avatar.className = `avatar small ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = member.display_name || member.email.split("@")[0];
    const handle = document.createElement("small");
    handle.textContent = `@${memberHandle(member)}`;
    copy.append(name, handle);
    button.append(avatar, copy);
    button.addEventListener("click", () => {
      insertAtCursor(state.composerTarget, `@${memberHandle(member)}`);
      closeModal("mention-modal");
    });
    container.append(button);
  });
  openModal("mention-modal");
}

function openEmojiPicker(inputId) {
  state.composerTarget = inputId;
  state.reactionTarget = null;
  configureEmojiPicker("Add an emoji", "Search or browse every emoji category, including skin tones, symbols, and flags.");
  showEmojiPicker();
}

function openReactionPicker(target) {
  if (!state.reactionsReady) {
    return showToast("Run vine-connect-reactions-update.sql in Supabase before using message reactions.", "error");
  }
  state.reactionTarget = target;
  configureEmojiPicker("React to this message", "Choose an emoji. Selecting one again removes your reaction.");
  showEmojiPicker();
}

function configureEmojiPicker(title, description) {
  $("#emoji-picker-title").textContent = title;
  $("#emoji-picker-description").textContent = description;
}

function showEmojiPicker() {
  const picker = $("#emoji-picker-list");
  picker.classList.toggle("dark", document.body.dataset.theme === "dark");
  picker.classList.toggle("light", document.body.dataset.theme !== "dark");
  openModal("emoji-modal");
}

function reactionTargetFor(message) {
  if (message.channel_id) return { type: "channel", id: message.id, field: "channel_message_id" };
  if (message.sender_id) return { type: "direct", id: message.id, field: "direct_message_id" };
  return { type: "thread", id: message.id, field: "thread_reply_id" };
}

function reactionsForTarget(target) {
  return state.reactions.filter((reaction) => reaction[target.field] === target.id);
}

function renderReactionBar(target) {
  if (!state.reactionsReady) return null;
  const reactions = reactionsForTarget(target);
  if (!reactions.length) return null;
  const grouped = new Map();
  reactions.forEach((reaction) => {
    if (!grouped.has(reaction.emoji)) grouped.set(reaction.emoji, []);
    grouped.get(reaction.emoji).push(reaction);
  });
  const bar = document.createElement("div");
  bar.className = "message-reactions";
  grouped.forEach((items, emoji) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = items.some((item) => item.user_id === currentSession?.user.id) ? "mine" : "";
    const names = items.map((item) => {
      const member = state.members.find((candidate) => candidate.id === item.user_id);
      return member?.display_name || member?.email?.split("@")[0] || "Vine member";
    });
    button.title = names.join(", ");
    button.setAttribute("aria-label", `${emoji} reaction from ${names.join(", ")}. Click to ${button.classList.contains("mine") ? "remove yours" : "add yours"}.`);
    const symbol = document.createElement("span");
    symbol.textContent = emoji;
    const count = document.createElement("strong");
    count.textContent = String(items.length);
    button.append(symbol, count);
    button.addEventListener("click", () => toggleReaction(target, emoji));
    bar.append(button);
  });
  return bar;
}

async function toggleReaction(target, emoji) {
  if (!state.reactionsReady) return showToast("Message reactions need the Supabase reactions update first.", "error");
  if (state.reactionBusy || !currentSession?.user) return;
  const existing = reactionsForTarget(target).find((reaction) => reaction.user_id === currentSession.user.id && reaction.emoji === emoji);
  state.reactionBusy = true;
  const result = existing
    ? await supabaseClient.from("message_reactions").delete().eq("id", existing.id)
    : await supabaseClient.from("message_reactions").insert({
      [target.field]: target.id,
      user_id: currentSession.user.id,
      emoji,
    });
  state.reactionBusy = false;
  if (result.error) return showToast(result.error.message, "error");
  await loadWorkspace(false);
}

function getThreadReplies(message) {
  const field = message.sender_id ? "direct_message_id" : "channel_message_id";
  return state.threadReplies.filter((reply) => reply[field] === message.id);
}

function getActiveThreadMessage() {
  if (!state.activeThread) return null;
  const source = state.activeThread.type === "direct" ? state.directMessages : state.messages;
  return source.find((message) => message.id === state.activeThread.messageId) || null;
}

function openThread(message) {
  state.activeThread = { type: message.sender_id ? "direct" : "channel", messageId: message.id };
  renderThreadModal();
  openModal("thread-modal");
  requestAnimationFrame(() => $("#thread-input").focus());
}

function renderThreadModal() {
  const message = getActiveThreadMessage();
  if (!message) {
    closeModal("thread-modal");
    state.activeThread = null;
    return;
  }
  const isDirect = Boolean(message.sender_id);
  const channel = !isDirect ? state.channels.find((item) => item.id === message.channel_id) : null;
  const otherId = isDirect ? (message.sender_id === currentSession.user.id ? message.recipient_id : message.sender_id) : null;
  const other = state.members.find((member) => member.id === otherId);
  $("#thread-context").textContent = isDirect
    ? `Private conversation with ${other?.display_name || other?.email || "a Vine member"}`
    : `Thread in #${channel?.name || "channel"}`;

  const original = $("#thread-original");
  original.replaceChildren(createCompactMessage(message, "Original message"));
  const replies = $("#thread-replies");
  replies.replaceChildren();
  const items = getThreadReplies(message);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "thread-empty";
    empty.textContent = "No replies yet. Start this thread.";
    replies.append(empty);
  } else {
    items.forEach((reply) => replies.append(renderThreadReply(reply)));
    requestAnimationFrame(() => { replies.scrollTop = replies.scrollHeight; });
  }
}

function createCompactMessage(message, label = "") {
  const authorId = message.author_id || message.sender_id;
  const author = message.author || state.members.find((member) => member.id === authorId) || {};
  const card = document.createElement("article");
  card.className = "compact-message";
  const avatar = document.createElement("span");
  avatar.className = `avatar small ${avatarClass(authorId)}`;
  avatar.textContent = getInitials(author.display_name || author.email || "Vine member");
  const copy = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "compact-message-meta";
  const name = document.createElement("strong");
  name.textContent = author.display_name || author.email?.split("@")[0] || "Vine member";
  const time = document.createElement("time");
  time.textContent = formatTime(message.created_at);
  meta.append(name, time);
  if (label) {
    const marker = document.createElement("span");
    marker.textContent = label;
    meta.append(marker);
  }
  const body = document.createElement("p");
  appendFormattedText(body, message.body || (message.attachments?.length ? "Shared an attachment" : "Message"));
  copy.append(meta, body);
  const reactionBar = renderReactionBar(reactionTargetFor(message));
  if (reactionBar) copy.append(reactionBar);
  card.append(avatar, copy);
  if (label) {
    const actions = document.createElement("div");
    actions.className = "thread-reply-actions";
    const react = document.createElement("button");
    react.type = "button";
    react.textContent = "React";
    react.addEventListener("click", () => openReactionPicker(reactionTargetFor(message)));
    actions.append(react);
    card.append(actions);
  }
  return card;
}

function renderThreadReply(reply) {
  const card = createCompactMessage(reply);
  card.classList.add("thread-reply");
  if (reply.edited_at) {
    const label = document.createElement("span");
    label.className = "edited-label";
    label.textContent = "edited";
    card.querySelector(".compact-message-meta").append(label);
  }
  const actions = document.createElement("div");
  actions.className = "thread-reply-actions";
  const react = document.createElement("button");
  react.type = "button";
  react.textContent = "React";
  react.addEventListener("click", () => openReactionPicker(reactionTargetFor(reply)));
  actions.append(react);
  if (reply.author_id === currentSession.user.id) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editThreadReply(reply));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-thread-reply";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteThreadReply(reply));
    actions.append(edit, remove);
  }
  card.append(actions);
  return card;
}

async function sendThreadReply(event) {
  event.preventDefault();
  const message = getActiveThreadMessage();
  const body = $("#thread-input").value.trim();
  if (!message || !body || state.busy) return;
  const button = $("#thread-submit");
  setButtonBusy(button, true, "Sending...");
  const payload = {
    author_id: currentSession.user.id,
    body,
    channel_message_id: message.sender_id ? null : message.id,
    direct_message_id: message.sender_id ? message.id : null,
  };
  const { error } = await supabaseClient.from("thread_replies").insert(payload);
  setButtonBusy(button, false, "Reply");
  if (error) return showToast(error.message, "error");
  $("#thread-input").value = "";
  await loadWorkspace(false);
}

async function editThreadReply(reply) {
  const next = window.prompt("Edit your thread reply:", reply.body || "");
  if (next === null || next.trim() === reply.body) return;
  if (!next.trim()) return showToast("A thread reply cannot be empty.", "error");
  const { error } = await supabaseClient.from("thread_replies")
    .update({ body: next.trim(), edited_at: new Date().toISOString() })
    .eq("id", reply.id);
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
}

async function deleteThreadReply(reply) {
  if (!window.confirm("Delete this thread reply permanently?")) return;
  const { error } = await supabaseClient.from("thread_replies").delete().eq("id", reply.id);
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
}

async function togglePin(message) {
  const existing = state.pins.find((pin) => pin.message_id === message.id);
  const request = existing
    ? supabaseClient.from("message_pins").delete().eq("id", existing.id)
    : supabaseClient.from("message_pins").insert({
      message_id: message.id,
      channel_id: message.channel_id,
      pinned_by: currentSession.user.id,
    });
  const { error } = await request;
  if (error) return showToast(error.message, "error");
  showToast(existing ? "Message unpinned." : "Message pinned to the channel.", "success");
  await loadWorkspace(false);
}

function openPinnedMessages() {
  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel || state.selectedDirectUserId) return showToast("Open a channel to view its pinned messages.");
  const items = state.pins
    .filter((pin) => pin.channel_id === channel.id)
    .map((pin) => state.messages.find((message) => message.id === pin.message_id))
    .filter(Boolean);
  showActivityModal("Pinned messages", `Saved messages in #${channel.name}.`, items.map((message) => ({
    message,
    label: `#${channel.name}`,
    action: () => navigateToMessage(message),
  })));
}

function openConversationOptions() {
  if (state.selectedDirectUserId) {
    openMembersModal();
    return;
  }
  if (currentProfile?.role === "admin") openChannelSettings();
  else openPinnedMessages();
}

function openThreadsOverview() {
  const items = [...state.messages, ...state.directMessages]
    .map((message) => ({ message, replies: getThreadReplies(message) }))
    .filter((item) => item.replies.length)
    .sort((a, b) => new Date(b.replies.at(-1).created_at) - new Date(a.replies.at(-1).created_at))
    .map(({ message, replies }) => ({
      message,
      label: `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`,
      action: () => { closeModal("activity-modal"); openThread(message); },
    }));
  showActivityModal("Threads", "Messages with active reply threads.", items);
}

function mentionsCurrentMember(text) {
  const handle = memberHandle(currentProfile);
  return new RegExp(`(^|\\s)@${escapeRegExp(handle)}(?=\\s|[.,!?;:]|$)`, "i").test(String(text || ""));
}

function openMentionsOverview() {
  const items = [];
  [...state.messages, ...state.directMessages].forEach((message) => {
    if (mentionsCurrentMember(message.body)) {
      items.push({ message, label: "Mentioned you", action: () => navigateToMessage(message) });
    }
  });
  state.threadReplies.forEach((reply) => {
    if (!mentionsCurrentMember(reply.body)) return;
    const parent = state.messages.find((message) => message.id === reply.channel_message_id)
      || state.directMessages.find((message) => message.id === reply.direct_message_id);
    if (parent) items.push({ message: reply, label: "Mentioned you in a thread", action: () => { closeModal("activity-modal"); openThread(parent); } });
  });
  items.sort((a, b) => new Date(b.message.created_at) - new Date(a.message.created_at));
  showActivityModal("Mentions", `Messages containing @${memberHandle(currentProfile)}.`, items);
}

function showActivityModal(title, description, items) {
  $("#activity-title").textContent = title;
  $("#activity-description").textContent = description;
  const list = $("#activity-list");
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "activity-empty";
    empty.textContent = `No ${title.toLowerCase()} yet.`;
    list.append(empty);
  } else {
    items.forEach(({ message, label, action }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "activity-card";
      const marker = document.createElement("span");
      marker.className = "activity-card-label";
      marker.textContent = label;
      const body = document.createElement("p");
      appendFormattedText(body, message.body || "Shared an attachment");
      const time = document.createElement("time");
      time.textContent = `${formatDateLabel(message.created_at)} at ${formatTime(message.created_at)}`;
      button.append(marker, body, time);
      button.addEventListener("click", action);
      list.append(button);
    });
  }
  openModal("activity-modal");
}

function navigateToMessage(message) {
  closeModal("activity-modal");
  if (message.channel_id) {
    selectChannel(message.channel_id);
  } else {
    const otherId = message.sender_id === currentSession.user.id ? message.recipient_id : message.sender_id;
    selectDirectMessage(otherId);
  }
  requestAnimationFrame(() => {
    document.querySelector(`[data-message-id="${message.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function renderActivityBadges() {
  const threadCount = [...state.messages, ...state.directMessages].filter((message) => getThreadReplies(message).length).length;
  const mentionCount = [...state.messages, ...state.directMessages, ...state.threadReplies].filter((message) => mentionsCurrentMember(message.body)).length;
  $("#thread-total").textContent = threadCount;
  $("#thread-total").hidden = threadCount === 0;
  $("#mention-total").textContent = mentionCount;
  $("#mention-total").hidden = mentionCount === 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function editMessage(message) {
  const isDirect = Boolean(message.sender_id);
  const previousBody = message.body || "";
  const nextBody = window.prompt("Edit your message:", previousBody);
  if (nextBody === null || nextBody === previousBody) return;
  const body = nextBody.trim();
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  if (!body && !hasAttachments) {
    showToast("A message without an attachment cannot be empty.", "error");
    return;
  }
  if (body.length > 10000) {
    showToast("Messages can contain up to 10,000 characters.", "error");
    return;
  }

  const table = isDirect ? "direct_messages" : "messages";
  const { error } = await supabaseClient.from(table)
    .update({ body, edited_at: new Date().toISOString() })
    .eq("id", message.id);
  if (error) return showToast(error.message, "error");
  showToast("Message edited.");
  await loadWorkspace(false);
}

async function deleteMessage(message) {
  if (!window.confirm("Delete this message permanently?")) return;
  const isDirect = Boolean(message.sender_id);
  const table = isDirect ? "direct_messages" : "messages";
  const paths = (Array.isArray(message.attachments) ? message.attachments : [])
    .map((attachment) => attachment.path)
    .filter(Boolean);

  if (paths.length) {
    const { error: storageError } = await supabaseClient.storage.from(STORAGE_BUCKET).remove(paths);
    if (storageError) return showToast(`Attachment could not be deleted: ${storageError.message}`, "error");
    paths.forEach((path) => {
      const url = state.attachmentUrls.get(path);
      if (url) URL.revokeObjectURL(url);
      state.attachmentUrls.delete(path);
    });
  }

  const { error } = await supabaseClient.from(table).delete().eq("id", message.id);
  if (error) return showToast(error.message, "error");
  showToast("Message deleted.");
  await loadWorkspace(false);
}

async function hydrateAttachment(holder, attachment) {
  try {
    let url = state.attachmentUrls.get(attachment.path);
    if (!url) {
      const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET).download(attachment.path);
      if (error) throw error;
      url = URL.createObjectURL(data);
      state.attachmentUrls.set(attachment.path, url);
    }

    holder.replaceChildren();
    if (attachment.kind === "image") {
      const link = document.createElement("a");
      link.className = "image-attachment";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      const img = document.createElement("img");
      img.src = url;
      img.alt = attachment.name;
      const label = document.createElement("span");
      label.textContent = `${attachment.name} - ${formatBytes(attachment.size)}`;
      link.append(img, label);
      holder.append(link);
    } else if (attachment.kind === "video") {
      const wrap = document.createElement("div");
      wrap.className = "video-attachment";
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      const label = document.createElement("span");
      label.textContent = `${attachment.name} - ${formatBytes(attachment.size)}`;
      wrap.append(video, label);
      holder.append(wrap);
    } else {
      const link = document.createElement("a");
      link.className = "file-attachment";
      link.href = url;
      link.download = attachment.name;
      link.innerHTML = '<span class="file-icon">&#8681;</span>';
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = attachment.name;
      const size = document.createElement("small");
      size.textContent = formatBytes(attachment.size);
      copy.append(name, size);
      link.append(copy);
      holder.append(link);
    }
  } catch (_error) {
    holder.innerHTML = `<div class="file-attachment disabled"><span class="file-icon">!</span><span><strong>${escapeHtml(attachment.name || "Attachment")}</strong><small>Could not load this private file</small></span></div>`;
  }
}

async function queueFiles(fileList) {
  for (const file of [...fileList]) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} is larger than 30 MB.`, "error");
      continue;
    }
    if (file.type.startsWith("video/")) {
      const duration = await getVideoDuration(file).catch(() => 0);
      if (duration > MAX_VIDEO_SECONDS) {
        showToast(`${file.name} is longer than 2 minutes.`, "error");
        continue;
      }
    }
    const id = makeId();
    state.pendingFiles.push({ id, file });
    if (file.type.startsWith("image/")) state.pendingPreviews.set(id, URL.createObjectURL(file));
  }
  $("#file-input").value = "";
  renderPendingFiles();
}

async function handleComposerPaste(event) {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  let images = [...(clipboard.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!images.length) {
    images = [...(clipboard.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }
  if (!images.length) return;

  event.preventDefault();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const namedImages = images.map((image, index) => {
    const extension = image.type === "image/jpeg" ? "jpg"
      : image.type === "image/gif" ? "gif"
        : image.type === "image/webp" ? "webp"
          : "png";
    const suffix = images.length > 1 ? `-${index + 1}` : "";
    return new File([image], `snip-${stamp}${suffix}.${extension}`, {
      type: image.type || "image/png",
      lastModified: Date.now(),
    });
  });

  const previousCount = state.pendingFiles.length;
  await queueFiles(namedImages);
  const attachedCount = state.pendingFiles.length - previousCount;
  if (attachedCount > 0) {
    showToast(attachedCount === 1 ? "Screenshot attached." : `${attachedCount} screenshots attached.`, "success");
  }
}

function renderPendingFiles() {
  const container = $("#pending-files");
  container.hidden = !state.pendingFiles.length;
  container.replaceChildren();
  state.pendingFiles.forEach(({ id, file }) => {
    const item = document.createElement("div");
    item.className = "pending-file";
    const previewUrl = state.pendingPreviews.get(id);
    if (previewUrl) {
      const img = document.createElement("img");
      img.src = previewUrl;
      img.alt = "";
      item.append(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-preview-fallback";
      icon.textContent = file.type.startsWith("video/") ? ">" : "DOC";
      item.append(icon);
    }
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = formatBytes(file.size);
    copy.append(name, size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.textContent = "x";
    remove.addEventListener("click", () => removePendingFile(id));
    item.append(copy, remove);
    container.append(item);
  });
  updateSendState();
}

function removePendingFile(id) {
  state.pendingFiles = state.pendingFiles.filter((item) => item.id !== id);
  const preview = state.pendingPreviews.get(id);
  if (preview) URL.revokeObjectURL(preview);
  state.pendingPreviews.delete(id);
  renderPendingFiles();
}

async function sendMessage(scheduledFor = null) {
  const body = $("#message-input").value.trim();
  const hasConversation = Boolean(state.selectedChannelId || state.selectedDirectUserId);
  if ((!body && !state.pendingFiles.length) || !hasConversation || state.busy) return;
  state.busy = true;
  updateSendState();
  const button = $("#send-message");
  button.innerHTML = '<i class="glyph spin">&#9696;</i>';

  try {
    if (state.pendingFiles.length) {
      await apiRequest("/files/validate", {
        method: "POST",
        body: { files: state.pendingFiles.map(({ file }) => ({ name: file.name, size: file.size, type: file.type })) },
      }).catch((error) => {
        if (![404, 503].includes(error.status)) throw error;
      });
    }
    const attachments = [];
    for (const { file } of state.pendingFiles) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const folder = state.selectedDirectUserId
        ? `${currentSession.user.id}/dm/${state.selectedDirectUserId}`
        : `${currentSession.user.id}/channels/${state.selectedChannelId}`;
      const path = `${folder}/${makeId()}-${safeName}`;
      const { error } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (error) throw error;
      attachments.push({
        id: makeId(), path, name: file.name, size: file.size, type: file.type || "application/octet-stream",
        kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
      });
    }

    let result;
    try {
      result = await apiRequest("/messages", {
        method: "POST",
        body: {
          messageType: state.selectedDirectUserId ? "direct" : "channel",
          channelId: state.selectedChannelId,
          recipientId: state.selectedDirectUserId,
          body,
          attachments,
          scheduledFor,
        },
      });
    } catch (apiError) {
      if (scheduledFor || ![404, 503].includes(apiError.status)) throw apiError;
      const { error } = state.selectedDirectUserId
        ? await supabaseClient.from("direct_messages").insert({ sender_id: currentSession.user.id, recipient_id: state.selectedDirectUserId, body, attachments })
        : await supabaseClient.from("messages").insert({ channel_id: state.selectedChannelId, author_id: currentSession.user.id, body, attachments });
      if (error) throw error;
      result = { scheduled: false };
    }

    $("#message-input").value = "";
    [...state.pendingPreviews.values()].forEach((url) => URL.revokeObjectURL(url));
    state.pendingFiles = [];
    state.pendingPreviews.clear();
    renderPendingFiles();
    closeModal("schedule-message-modal");
    await loadWorkspace(true);
    if (result?.scheduled) showToast(`Message scheduled for ${new Date(result.message.scheduled_for).toLocaleString()}.`, "success");
  } catch (error) {
    showToast(error.message || "Message could not be sent.", "error");
  } finally {
    state.busy = false;
    button.innerHTML = '<i class="glyph">&#10148;</i>';
    updateSendState();
  }
}

function openChannelModal() {
  if (currentProfile?.role !== "admin") return showToast("Only administrators can create channels.", "error");
  $("#channel-form").reset();
  $("#new-channel-type").value = "chat";
  $("#new-channel-visibility").value = "workspace";
  $("#new-channel-posting-policy").value = "everyone";
  updateChannelTypeTip();
  const parentSelect = $("#new-channel-parent");
  parentSelect.innerHTML = '<option value="">No parent - top-level channel</option>';
  state.channels.filter((channel) => !channel.parent_id).sort(sortChannels).forEach((channel) => {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = `Under #${channel.name}`;
    parentSelect.append(option);
  });
  renderChannelMemberPicker("channel-member-picker", []);
  updateChannelMemberPickerVisibility();
  hideError("channel-error");
  openModal("channel-modal");
  $("#new-channel-name").focus();
}

function openMoveSubchannelModal(channel) {
  if (currentProfile?.role !== "admin") return showToast("Only administrators can move sub-channels.", "error");
  if (!channel?.parent_id) return showToast("Only sub-channels can be moved with this control.", "error");
  state.movingSubchannelId = channel.id;
  const title = $("#move-subchannel-title");
  const description = $("#move-subchannel-description");
  title.textContent = `Move #${channel.name}`;
  description.textContent = "Choose its parent channel and exact position. The new order is synchronized for every member.";

  const parentSelect = $("#move-subchannel-parent");
  parentSelect.replaceChildren();
  state.channels.filter((item) => !item.parent_id).sort(sortChannels).forEach((parent) => {
    const option = document.createElement("option");
    option.value = parent.id;
    option.textContent = `#${parent.name}`;
    option.selected = parent.id === channel.parent_id;
    parentSelect.append(option);
  });
  renderMoveSubchannelPositions();
  hideError("move-subchannel-error");
  openModal("move-subchannel-modal");
  parentSelect.focus();
}

function renderMoveSubchannelPositions() {
  const channel = state.channels.find((item) => item.id === state.movingSubchannelId);
  const parentId = $("#move-subchannel-parent")?.value;
  const positionSelect = $("#move-subchannel-position");
  if (!channel || !parentId || !positionSelect) return;
  const siblings = state.channels
    .filter((item) => item.parent_id === parentId && item.id !== channel.id)
    .sort(sortChannels);
  const currentOrder = state.channels.filter((item) => item.parent_id === channel.parent_id).sort(sortChannels);
  const currentPosition = parentId === channel.parent_id ? Math.max(0, currentOrder.findIndex((item) => item.id === channel.id)) : siblings.length;
  positionSelect.replaceChildren();
  for (let index = 0; index <= siblings.length; index += 1) {
    const option = document.createElement("option");
    option.value = String(index);
    if (index === 0) option.textContent = "First";
    else if (index === siblings.length) option.textContent = `Last (after #${siblings[index - 1].name})`;
    else option.textContent = `After #${siblings[index - 1].name}`;
    option.selected = index === currentPosition;
    positionSelect.append(option);
  }
}

async function moveSubchannel(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin" || state.busy) return;
  const channel = state.channels.find((item) => item.id === state.movingSubchannelId);
  const parentId = $("#move-subchannel-parent").value;
  const position = Number($("#move-subchannel-position").value);
  if (!channel || !parentId || !Number.isInteger(position)) return showFormError("move-subchannel-error", "Choose a valid destination.");

  const button = $("#move-subchannel-submit");
  hideError("move-subchannel-error");
  setButtonBusy(button, true, "Moving...");
  let error = null;
  try {
    await apiRequest(`/channels/${channel.id}/move`, { method: "POST", body: { parentId, position } });
  } catch (apiError) {
    if (![404, 503].includes(apiError.status)) error = apiError;
    else ({ error } = await supabaseClient.rpc("move_vine_subchannel", {
      target_channel_id: channel.id,
      target_parent_id: parentId,
      target_position: position,
    }));
  }
  setButtonBusy(button, false, "Move sub-channel");
  if (error) return showFormError("move-subchannel-error", error.message.includes("function public.move_vine_subchannel")
    ? "Run vine-connect-ordering-seen-update.sql in Supabase first."
    : error.message);

  state.expanded.add(parentId);
  closeModal("move-subchannel-modal");
  await loadWorkspace(false);
  showToast(`#${channel.name} moved for everyone.`, "success");
}

async function createChannel(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin") return showFormError("channel-error", "Only administrators can create channels.");
  const rawName = $("#new-channel-name").value.trim().toLowerCase();
  const name = rawName.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) return showFormError("channel-error", "Enter a valid channel name.");
  const button = $("#channel-submit");
  setButtonBusy(button, true, "Creating...");
  hideError("channel-error");

  const parentId = $("#new-channel-parent").value || null;
  const channelType = $("#new-channel-type").value === "files" ? "files" : "chat";
  const visibility = $("#new-channel-visibility").value;
  const postingPolicy = $("#new-channel-posting-policy").value;
  const memberIds = $$('#channel-member-picker input:checked').map((input) => input.value);
  let data;
  let error;
  try {
    const result = await apiRequest("/channels", {
      method: "POST",
      body: { name, description: $("#new-channel-description").value.trim(), channelType, parentId, visibility, postingPolicy, memberIds },
    });
    data = result.channel;
  } catch (apiError) {
    if (visibility === "private" || postingPolicy === "admins" || ![404, 503].includes(apiError.status)) error = apiError;
    else ({ data, error } = await supabaseClient.from("channels").insert({
      name, description: $("#new-channel-description").value.trim(), channel_type: channelType,
      parent_id: parentId, created_by: currentSession.user.id,
    }).select("id").single());
  }

  setButtonBusy(button, false, "Create channel");
  if (error) return showFormError("channel-error", error.code === "23505" ? "That channel name already exists here." : error.message);
  $("#channel-form").reset();
  closeModal("channel-modal");
  state.selectedChannelId = data.id;
  if (parentId) state.expanded.add(parentId);
  await loadWorkspace(true);
  showToast(`${channelType === "files" ? `${name} Files library` : `#${name}`} created.`, "success");
}

function updateChannelMemberPickerVisibility() {
  $("#channel-member-fieldset").hidden = $("#new-channel-visibility").value !== "private";
}

function updateChannelSettingsMemberVisibility() {
  $("#channel-settings-members").closest("fieldset").hidden = $("#channel-settings-visibility").value !== "private";
}

function renderChannelMemberPicker(containerId, selectedIds) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const selected = new Set(selectedIds);
  container.replaceChildren();
  state.members.filter((member) => member.member_status !== "terminated").forEach((member) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = member.id;
    input.checked = member.id === currentSession.user.id || selected.has(member.id);
    input.disabled = member.id === currentSession.user.id;
    const name = document.createElement("span");
    name.textContent = member.display_name || member.email;
    label.append(input, name);
    container.append(label);
  });
}

function openChannelSettings() {
  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel || currentProfile?.role !== "admin") return openPinnedMessages();
  $("#channel-settings-description").textContent = `Control access and posting rights for #${channel.name}.`;
  $("#channel-settings-visibility").value = channel.visibility || "workspace";
  $("#channel-settings-posting").value = channel.posting_policy || "everyone";
  $("#channel-settings-quota").value = Math.round(Number(channel.storage_quota_bytes || 1073741824) / 1048576);
  const selected = state.channelMembers.filter((item) => item.channel_id === channel.id).map((item) => item.user_id);
  renderChannelMemberPicker("channel-settings-members", selected);
  updateChannelSettingsMemberVisibility();
  hideError("channel-settings-error");
  openModal("channel-settings-modal");
}

async function saveChannelSettings(event) {
  event.preventDefault();
  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel || currentProfile?.role !== "admin" || state.busy) return;
  const button = $("#channel-settings-submit");
  setButtonBusy(button, true, "Saving...");
  try {
    await apiRequest(`/channels/${channel.id}`, {
      method: "PATCH",
      body: {
        visibility: $("#channel-settings-visibility").value,
        postingPolicy: $("#channel-settings-posting").value,
        storageQuotaBytes: Number($("#channel-settings-quota").value) * 1048576,
        memberIds: $$('#channel-settings-members input:checked').map((input) => input.value),
      },
    });
    closeModal("channel-settings-modal");
    await loadWorkspace(false);
    showToast("Channel permissions updated.", "success");
  } catch (error) {
    showFormError("channel-settings-error", error.message);
  } finally {
    setButtonBusy(button, false, "Save permissions");
  }
}

function updateChannelTypeTip() {
  const isFiles = $("#new-channel-type")?.value === "files";
  const tip = $("#channel-type-tip");
  if (tip) tip.textContent = isFiles
    ? "A Files library has no chat composer. Members can upload and organize documents in its dedicated storage folder."
    : "Chat channels contain messages, threads, pins, and meetings.";
}

function openProfileModal() {
  applyProfile();
  openModal("profile-modal");
}

async function updateProfile(event) {
  event.preventDefault();
  const displayName = $("#display-name").value.trim();
  if (!displayName) return;
  const button = event.currentTarget.querySelector("button[type=submit]");
  setButtonBusy(button, true, "Saving...");
  const { data, error } = await supabaseClient.from("profiles")
    .update({ display_name: displayName })
    .eq("id", currentSession.user.id)
    .select("id,email,display_name,role,job_title")
    .single();
  setButtonBusy(button, false, "Save profile");
  if (error) return showToast(error.message, "error");
  currentProfile = data;
  applyProfile();
  closeModal("profile-modal");
  await loadWorkspace(false);
  showToast("Profile updated.", "success");
}

function renderMembers() {
  $("#member-count").textContent = state.members.length;
  const minis = [$("#member-mini-1"), $("#member-mini-2"), $("#member-mini-3")];
  minis.forEach((mini, index) => {
    const member = state.members[index];
    mini.hidden = !member;
    if (member) mini.textContent = getInitials(member.display_name || member.email);
  });

  const container = $("#members-list");
  container.replaceChildren();
  state.members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("span");
    avatar.className = `avatar small ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = member.display_name || member.email.split("@")[0];
    const email = document.createElement("small");
    email.textContent = member.email;
    copy.append(name, email);
    const role = document.createElement("span");
    role.className = `role-pill ${member.role}`;
    role.textContent = titleCase(member.role);
    row.append(avatar, copy, role);
    if (member.id !== currentSession.user.id) {
      const memberActions = document.createElement("div");
      memberActions.className = "member-actions";
      const ringButton = document.createElement("button");
      ringButton.type = "button";
      ringButton.className = "ring-member-button";
      ringButton.title = `Ring ${member.display_name || member.email}`;
      ringButton.setAttribute("aria-label", `Ring ${member.display_name || member.email}`);
      ringButton.textContent = "Ring";
      ringButton.disabled = (member.member_status || "active") !== "active";
      ringButton.addEventListener("click", () => sendMemberRing(member.id));
      const messageButton = document.createElement("button");
      messageButton.type = "button";
      messageButton.className = "message-member-button";
      messageButton.textContent = "Message";
      messageButton.disabled = (member.member_status || "active") !== "active";
      messageButton.addEventListener("click", () => selectDirectMessage(member.id));
      memberActions.append(ringButton, messageButton);
      row.append(memberActions);
    }
    container.append(row);
  });
}

function openMembersModal() {
  renderMembers();
  $("#open-add-member").hidden = currentProfile?.role !== "admin";
  openModal("members-modal");
}

async function sendMemberRing(memberId) {
  if (!memberId || memberId === currentSession?.user.id || state.ringSendingTo) return;
  const member = state.members.find((item) => item.id === memberId);
  const name = member?.display_name || member?.email?.split("@")[0] || "this member";
  if (!state.ringsReady) {
    return showToast("Run vine-connect-rings-update.sql in Supabase before using attention rings.", "error");
  }
  state.ringSendingTo = memberId;
  let data;
  let error = null;
  try {
    const result = await apiRequest("/notifications/ring", { method: "POST", body: { recipientId: memberId } });
    data = result.ring;
  } catch (apiError) {
    if (![404, 503].includes(apiError.status)) error = apiError;
    else ({ data, error } = await supabaseClient.rpc("send_member_ring", { target_member: memberId }));
  }
  state.ringSendingTo = null;
  if (error) return showToast(error.message, "error");
  const createdRing = Array.isArray(data) ? data[0] : data;
  if (createdRing) state.memberRings.unshift(createdRing);
  showToast(`Ringing ${name}. This will not start a call.`, "success");
}

function processPendingRings() {
  if (!state.ringsReady || state.activeRing || !currentSession?.user) return;
  const now = Date.now();
  const pending = state.memberRings.find((ring) => ring.recipient_id === currentSession.user.id
    && !ring.acknowledged_at
    && !state.handledRingIds.has(ring.id)
    && now - new Date(ring.created_at).getTime() < RING_DURATION_MS);
  if (pending) receiveMemberRing(pending);
}

function receiveMemberRing(ring) {
  if (!ring || ring.recipient_id !== currentSession?.user.id || ring.acknowledged_at || state.handledRingIds.has(ring.id)) return;
  state.handledRingIds.add(ring.id);
  clearActiveRingUi();
  state.activeRing = ring;
  const sender = state.members.find((member) => member.id === ring.sender_id);
  const name = sender?.display_name || sender?.email?.split("@")[0] || "A Vine member";
  $("#ring-title").textContent = `${name} is ringing you`;
  $("#ring-sender-name").textContent = name;
  $("#ring-sender-avatar").textContent = getInitials(name);
  $("#ring-sender-avatar").className = `avatar ${avatarClass(ring.sender_id)}`;
  $("#ring-modal").hidden = false;
  document.title = `\uD83D\uDD14 ${name} is ringing you | Vine Connect`;
  if (!state.notificationsMuted) {
    ringAudio.currentTime = 0;
    ringAudio.volume = 0.9;
    ringAudio.play().catch(() => {
      // The visual alert remains available if the browser blocks background audio.
    });
  }
  if (navigator.vibrate) navigator.vibrate([400, 180, 400, 180, 650]);
  ringTimer = window.setTimeout(() => {
    const activeName = $("#ring-sender-name").textContent;
    clearActiveRingUi();
    showToast(`The attention ring from ${activeName} ended.`, "success");
  }, RING_DURATION_MS);
}

async function dismissActiveRing(openMessage) {
  const ring = state.activeRing;
  if (!ring) return clearActiveRingUi();
  const senderId = ring.sender_id;
  clearActiveRingUi();
  const acknowledgedAt = new Date().toISOString();
  const { error } = await supabaseClient.from("member_rings")
    .update({ acknowledged_at: acknowledgedAt })
    .eq("id", ring.id)
    .eq("recipient_id", currentSession.user.id);
  if (error) showToast(error.message, "error");
  if (openMessage) selectDirectMessage(senderId);
}

function clearActiveRingUi() {
  if (ringTimer) window.clearTimeout(ringTimer);
  ringTimer = null;
  ringAudio.pause();
  ringAudio.currentTime = 0;
  if (navigator.vibrate) navigator.vibrate(0);
  const modal = $("#ring-modal");
  if (modal) modal.hidden = true;
  state.activeRing = null;
  document.title = defaultDocumentTitle;
}

function openAddMemberModal() {
  if (currentProfile?.role !== "admin") {
    return showToast("Only administrators can add members.", "error");
  }
  $("#add-member-form").reset();
  hideError("member-error");
  closeModal("members-modal");
  openModal("add-member-modal");
  $("#member-display-name").focus();
}

async function createMember(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin" || state.busy) {
    return showFormError("member-error", "Only administrators can add members.");
  }

  const displayName = $("#member-display-name").value.trim();
  const email = $("#member-email").value.trim().toLowerCase();
  const jobTitle = $("#member-job-title").value.trim();
  const role = $("#member-role").value;
  const button = $("#member-submit");
  hideError("member-error");
  setButtonBusy(button, true, "Creating member...");

  try {
    const data = await apiRequest("/admin/members", { method: "POST", body: { displayName, email, jobTitle, role } });
    if (!data?.temporaryPassword || !data?.member?.email) {
      throw new Error(data?.error || "The member was not created. Check the Edge Function logs.");
    }

    $("#member-created-title").textContent = "Member created";
    $("#member-created-description").textContent = "Send these temporary login details privately. The password is shown only in this window.";
    $("#created-member-email").textContent = data.member.email;
    $("#created-member-password").value = data.temporaryPassword;
    closeModal("add-member-modal");
    openModal("member-created-modal");
    await loadWorkspace(false);
  } catch (error) {
    showFormError("member-error", error.message || "The member could not be created.");
  } finally {
    setButtonBusy(button, false, "Create member");
  }
}

async function copyTemporaryPassword() {
  const input = $("#created-member-password");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (_error) {
    input.focus();
    input.select();
    document.execCommand("copy");
  }
  showToast("Temporary password copied.", "success");
}

function openCrm() {
  if (currentProfile?.role !== "admin") return showToast("The mini CRM is for administrators.", "error");
  renderCrm();
  openModal("crm-modal");
}

function renderCrm() {
  if (!currentProfile || currentProfile.role !== "admin") return;
  $("#crm-employee-count").textContent = state.members.length;
  $("#crm-client-count").textContent = state.clients.length;
  $("#crm-active-now").textContent = state.members.filter((member) => memberPresenceStatus(member) === "online").length;
  $("#crm-active-week").textContent = state.members.filter((member) => member.last_active_at && Date.now() - new Date(member.last_active_at).getTime() < 7 * 24 * 60 * 60 * 1000).length;
  $("#crm-private-channel-count").textContent = state.channels.filter((channel) => channel.visibility === "private").length;
  $("#crm-storage-usage").textContent = formatBytes(
    state.fileItems.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0)
    + state.fileVersions.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0),
  );

  const employees = $("#crm-employees");
  employees.replaceChildren();
  state.members.forEach((member) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "crm-row";
    row.setAttribute("aria-label", `Edit ${member.display_name || member.email}`);
    const avatar = document.createElement("span");
    avatar.className = `avatar small ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    const copy = document.createElement("span");
    copy.className = "crm-row-copy";
    const name = document.createElement("strong");
    name.textContent = member.display_name || member.email.split("@")[0];
    const detail = document.createElement("small");
    detail.textContent = [member.job_title, member.email, `${titleCase(member.member_status || "active")} - ${memberLastActiveLabel(member)}`].filter(Boolean).join(" - ");
    copy.append(name, detail);
    const role = document.createElement("span");
    role.className = `role-pill ${member.role}`;
    role.textContent = titleCase(member.role);
    row.append(avatar, copy, role);
    row.addEventListener("click", () => openEmployeeEditor(member));
    employees.append(row);
  });

  const clients = $("#crm-clients");
  clients.replaceChildren();
  if (!state.clients.length) {
    clients.innerHTML = '<div class="crm-empty">No clients yet. Use Add client to create the first record.</div>';
  }
  state.clients.forEach((client) => {
    const row = document.createElement("div");
    row.className = "crm-row";
    row.title = client.notes || "";
    const avatar = document.createElement("span");
    avatar.className = "avatar small avatar-mint";
    avatar.textContent = getInitials(client.company || client.name);
    const copy = document.createElement("span");
    copy.className = "crm-row-copy";
    const name = document.createElement("strong");
    name.textContent = client.name;
    const detail = document.createElement("small");
    detail.textContent = [client.company, client.email, client.phone].filter(Boolean).join(" - ") || "No contact details yet";
    copy.append(name, detail);
    const status = document.createElement("span");
    status.className = `crm-status ${client.status}`;
    status.textContent = client.status.replace("-", " ");
    row.append(avatar, copy, status);
    clients.append(row);
  });

  const audit = $("#crm-audit-list");
  audit.replaceChildren();
  $("#crm-audit-count").textContent = state.auditLogs.length + state.deletedMessageHistory.length;
  if (!state.auditLogs.length && !state.deletedMessageHistory.length) {
    audit.innerHTML = '<div class="crm-empty">No admin activity recorded yet.</div>';
  } else {
    state.auditLogs.slice(0, 30).forEach((log) => {
      const row = document.createElement("div");
      row.className = "crm-audit-row";
      const actor = state.members.find((member) => member.id === log.actor_id);
      const copy = document.createElement("span");
      const summary = document.createElement("strong");
      summary.textContent = log.summary;
      const meta = document.createElement("small");
      meta.textContent = `${actor?.display_name || "System"} - ${new Date(log.created_at).toLocaleString()}`;
      copy.append(summary, meta);
      row.append(copy);
      audit.append(row);
    });
    state.deletedMessageHistory.slice(0, 20).forEach((entry) => {
      const row = document.createElement("div");
      row.className = "crm-audit-row deleted-history-row";
      const actor = state.members.find((member) => member.id === entry.deleted_by);
      const copy = document.createElement("span");
      const summary = document.createElement("strong");
      summary.textContent = `Deleted ${entry.message_type} message: ${String(entry.body || "Attachment").slice(0, 90)}`;
      const meta = document.createElement("small");
      meta.textContent = `${actor?.display_name || "Member"} - ${new Date(entry.deleted_at).toLocaleString()}`;
      copy.append(summary, meta);
      row.append(copy);
      audit.append(row);
    });
  }
}

function openEmployeeEditor(member) {
  if (currentProfile?.role !== "admin") return;
  $("#employee-id").value = member.id;
  $("#employee-display-name").value = member.display_name || member.email.split("@")[0];
  $("#employee-job-title").value = member.job_title || "";
  $("#employee-role").value = member.role;
  $("#employee-status").value = member.member_status || "active";
  $("#employee-role").disabled = member.id === currentSession.user.id;
  $("#employee-modal-email").textContent = member.email;
  $("#reset-employee-password").disabled = member.id === currentSession.user.id;
  $("#reset-employee-password").title = member.id === currentSession.user.id ? "Ask the other administrator to reset your password." : "Generate a temporary password for this employee";
  $("#delete-employee").disabled = member.id === currentSession.user.id;
  $("#delete-employee").title = member.id === currentSession.user.id ? "You cannot delete your own signed-in account." : "Delete this employee";
  hideError("employee-error");
  closeModal("crm-modal");
  openModal("employee-modal");
  $("#employee-display-name").focus();
}

async function updateEmployee(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin" || state.busy) return;
  const button = $("#employee-submit");
  const userId = $("#employee-id").value;
  hideError("employee-error");
  setButtonBusy(button, true, "Saving...");
  try {
    await apiRequest(`/admin/members/${userId}`, {
      method: "PATCH",
      body: {
        displayName: $("#employee-display-name").value.trim(),
        jobTitle: $("#employee-job-title").value.trim(),
        role: $("#employee-role").value,
        status: $("#employee-status").value,
      },
    });
    closeModal("employee-modal");
    await loadWorkspace(false);
    if (userId === currentSession.user.id) {
      currentProfile = state.members.find((member) => member.id === userId) || currentProfile;
      applyProfile();
    }
    openCrm();
    showToast("Employee updated.", "success");
  } catch (error) {
    showFormError("employee-error", error.message || "The employee could not be updated.");
  } finally {
    setButtonBusy(button, false, "Save employee");
  }
}

async function resetEmployeePassword() {
  if (currentProfile?.role !== "admin" || state.busy) return;
  const userId = $("#employee-id").value;
  const member = state.members.find((item) => item.id === userId);
  if (!member || userId === currentSession.user.id) {
    return showFormError("employee-error", "Ask the other administrator to reset your password.");
  }

  const name = member.display_name || member.email;
  if (!window.confirm(`Reset the password for ${name}?\n\nTheir previous password will stop working. A new temporary password will be generated.`)) return;

  const button = $("#reset-employee-password");
  hideError("employee-error");
  setButtonBusy(button, true, "Resetting...");
  try {
    const data = await apiRequest(`/admin/members/${userId}/reset-password`, { method: "POST" });
    if (!data?.temporaryPassword || !data?.member?.email) {
      throw new Error("The password was not returned. Check the Edge Function logs.");
    }

    $("#member-created-title").textContent = "Password reset";
    $("#member-created-description").textContent = "Send this temporary password privately. The employee must replace it after signing in.";
    $("#created-member-email").textContent = data.member.email;
    $("#created-member-password").value = data.temporaryPassword;
    closeModal("employee-modal");
    openModal("member-created-modal");
  } catch (error) {
    showFormError("employee-error", error.message || "The password could not be reset.");
  } finally {
    setButtonBusy(button, false, "Reset password");
  }
}

async function deleteEmployee() {
  if (currentProfile?.role !== "admin" || state.busy) return;
  const userId = $("#employee-id").value;
  const member = state.members.find((item) => item.id === userId);
  if (!member || userId === currentSession.user.id) return showFormError("employee-error", "You cannot delete your own signed-in account.");
  const name = member.display_name || member.email;
  if (!window.confirm(`Delete ${name} from Vine Connect?\n\nTheir account, messages, and access will be permanently removed.`)) return;
  const button = $("#delete-employee");
  hideError("employee-error");
  setButtonBusy(button, true, "Deleting...");
  try {
    await apiRequest(`/admin/members/${userId}`, { method: "DELETE" });
    closeModal("employee-modal");
    await loadWorkspace(false);
    openCrm();
    showToast("Employee deleted.", "success");
  } catch (error) {
    showFormError("employee-error", error.message || "The employee could not be deleted.");
  } finally {
    setButtonBusy(button, false, "Delete employee");
  }
}

async function memberFunctionError(error, fallback) {
  let message = error?.message || fallback;
  try {
    const details = await error.context?.json();
    message = details?.error || details?.message || message;
  } catch (_ignored) {
    // The Supabase client message is used when the response body is unavailable.
  }
  return new Error(message);
}

function openClientForm() {
  if (currentProfile?.role !== "admin") return;
  $("#client-form").reset();
  hideError("client-error");
  closeModal("crm-modal");
  openModal("client-form-modal");
  $("#client-name").focus();
}

async function createClient(event) {
  event.preventDefault();
  if (currentProfile?.role !== "admin" || state.busy) return;
  const button = $("#client-submit");
  hideError("client-error");
  setButtonBusy(button, true, "Saving client...");

  const { error } = await supabaseClient.from("crm_clients").insert({
    name: $("#client-name").value.trim(),
    company: $("#client-company").value.trim(),
    email: $("#client-email").value.trim().toLowerCase() || null,
    phone: $("#client-phone").value.trim(),
    status: $("#client-status").value,
    notes: $("#client-notes").value.trim(),
    created_by: currentSession.user.id,
  });

  setButtonBusy(button, false, "Save client");
  if (error) return showFormError("client-error", error.message);
  closeModal("client-form-modal");
  await loadWorkspace(false);
  openCrm();
  showToast("Client added to the CRM.", "success");
}

function openSearch() {
  openModal("search-modal");
  $("#search-input").value = "";
  $("#search-type").value = "all";
  $("#search-date").value = "";
  $("#search-file-type").value = "";
  $("#search-mentions").checked = false;
  $("#search-pinned").checked = false;
  const select = $("#search-channel");
  select.innerHTML = '<option value="">All channels</option>';
  state.channels.forEach((channel) => {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = `#${channel.name}`;
    select.append(option);
  });
  const memberSelect = $("#search-member");
  memberSelect.innerHTML = '<option value="">All members</option>';
  state.members.forEach((member) => {
    const option = document.createElement("option");
    option.value = member.id;
    option.textContent = member.display_name || member.email;
    memberSelect.append(option);
  });
  renderSearchResults();
  $("#search-input").focus();
}

function renderSearchResults() {
  const query = $("#search-input").value.trim().toLowerCase();
  const type = $("#search-type").value;
  const channelId = $("#search-channel").value;
  const memberId = $("#search-member").value;
  const fileType = $("#search-file-type").value;
  const date = $("#search-date").value;
  const mentionsOnly = $("#search-mentions").checked;
  const pinnedOnly = $("#search-pinned").checked;
  const matchesText = (value) => !query || String(value || "").toLowerCase().includes(query);
  const matchesDate = (value) => !date || String(value || "").slice(0, 10) === date;
  const results = [];

  if (["all", "messages"].includes(type)) {
    [...state.messages, ...state.directMessages].forEach((message) => {
      if (!matchesText(message.body) || !matchesDate(message.created_at)) return;
      if (channelId && message.channel_id !== channelId) return;
      if (memberId && (message.author_id || message.sender_id) !== memberId) return;
      if (mentionsOnly && !String(message.body || "").includes("@")) return;
      if (pinnedOnly && !state.pins.some((pin) => pin.message_id === message.id)) return;
      const authorId = message.author_id || message.sender_id;
      const author = state.members.find((member) => member.id === authorId);
      const label = message.channel_id
        ? `#${state.channels.find((channel) => channel.id === message.channel_id)?.name || "channel"}`
        : `Direct message - ${author?.display_name || author?.email || "member"}`;
      results.push({ icon: "\uD83D\uDCAC", title: message.body || "Attachment", detail: `${label} - ${new Date(message.created_at).toLocaleString()}`, action: () => navigateToMessage(message) });
    });
  }
  if (["all", "files"].includes(type) && !pinnedOnly) {
    state.fileItems.filter((item) => item.item_type !== "folder" && matchesText(`${item.name} ${item.description || ""}`) && matchesDate(item.created_at) && (!channelId || item.channel_id === channelId) && (!memberId || item.uploaded_by === memberId) && !mentionsOnly && (!fileType || fileSearchType(item) === fileType)).forEach((item) => {
      const channel = state.channels.find((entry) => entry.id === item.channel_id);
      results.push({ icon: "\uD83D\uDCC4", title: item.name, detail: `#${channel?.name || "files"} - ${formatBytes(item.size_bytes)}`, action: () => { closeModal("search-modal"); selectChannel(item.channel_id); openLibraryItem(channel, item); } });
    });
  }
  if (["all", "channels"].includes(type) && !memberId && !fileType && !date && !mentionsOnly && !pinnedOnly) {
    state.channels.filter((channel) => matchesText(`${channel.name} ${channel.description || ""}`) && (!channelId || channel.id === channelId)).forEach((channel) => {
      results.push({ icon: channel.channel_type === "files" ? "\uD83D\uDCC1" : channel.visibility === "private" ? "\uD83D\uDD12" : "#", title: channel.name, detail: channel.description || "Vine Connect channel", action: () => selectChannel(channel.id) });
    });
  }
  if (["all", "members"].includes(type) && !channelId && !fileType && !date && !mentionsOnly && !pinnedOnly) {
    state.members.filter((member) => matchesText(`${member.display_name} ${member.email} ${member.job_title || ""}`)).forEach((member) => {
      results.push({ icon: "@", title: member.display_name || member.email, detail: `${member.email} - ${titleCase(memberPresenceStatus(member))}`, action: () => member.id === currentSession.user.id ? openProfileModal() : selectDirectMessage(member.id) });
    });
  }
  const container = $("#search-results");
  container.replaceChildren();
  if (!results.length) {
    container.innerHTML = '<p class="no-results">No matching messages, files, channels or members.</p>';
    return;
  }
  const label = document.createElement("span");
  label.className = "search-label";
  label.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
  container.append(label);
  results.slice(0, 100).forEach((result) => {
    const button = document.createElement("button");
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "search-result-icon";
    icon.textContent = result.icon;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = result.title;
    const description = document.createElement("small");
    description.textContent = result.detail;
    copy.append(name, description);
    const arrow = document.createElement("span");
    arrow.textContent = ">";
    button.append(icon, copy, arrow);
    button.addEventListener("click", () => {
      result.action();
      closeModal("search-modal");
    });
    container.append(button);
  });
}

function subscribeRealtime() {
  unsubscribeRealtime();
  let realtime = supabaseClient.channel("vine-connect-live", { config: { presence: { key: currentSession.user.id } } })
    .on("presence", { event: "sync" }, syncPresence)
    .on("broadcast", { event: "typing" }, handleTypingBroadcast)
    .on("postgres_changes", { event: "*", schema: "public", table: "channels" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => handleMessageChange(payload, "channel"))
    .on("postgres_changes", { event: "*", schema: "public", table: "direct_messages" }, (payload) => handleMessageChange(payload, "direct"))
    .on("postgres_changes", { event: "*", schema: "public", table: "thread_replies" }, handleThreadReplyChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "message_pins" }, () => scheduleReload(false));
  if (state.filesFeatureReady) {
    realtime = realtime.on("postgres_changes", { event: "*", schema: "public", table: "file_library_items" }, handleFileLibraryChange);
  }
  if (state.reactionsReady) {
    realtime = realtime.on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, () => scheduleReload(false));
  }
  if (state.ringsReady) {
    realtime = realtime.on("postgres_changes", { event: "*", schema: "public", table: "member_rings" }, handleMemberRingChange);
  }
  if (state.readsReady) {
    realtime = realtime.on("postgres_changes", { event: "*", schema: "public", table: "message_reads" }, () => scheduleReload(false));
  }
  if (state.meetingsReady) {
    realtime = realtime
      .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, () => scheduleReload(false))
      .on("postgres_changes", { event: "*", schema: "public", table: "meeting_participants" }, () => scheduleReload(false));
  }
  if (state.platformReady) {
    realtime = realtime
      .on("postgres_changes", { event: "*", schema: "public", table: "message_bookmarks" }, () => scheduleReload(false))
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_messages" }, () => scheduleReload(false))
      .on("postgres_changes", { event: "*", schema: "public", table: "channel_members" }, () => scheduleReload(false));
  }
  state.realtime = realtime
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "crm_clients" }, () => scheduleReload(false))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await state.realtime.track({ user_id: currentSession.user.id, online_at: new Date().toISOString() });
      }
    });
}

function handleMemberRingChange(payload) {
  const ring = payload.new;
  if (!ring?.id || !currentSession?.user) return;
  const existingIndex = state.memberRings.findIndex((item) => item.id === ring.id);
  if (existingIndex >= 0) state.memberRings[existingIndex] = ring;
  else state.memberRings.unshift(ring);

  if (payload.eventType === "INSERT" && ring.recipient_id === currentSession.user.id) {
    receiveMemberRing(ring);
    return;
  }
  if (payload.eventType === "UPDATE" && ring.sender_id === currentSession.user.id && ring.acknowledged_at) {
    const recipient = state.members.find((member) => member.id === ring.recipient_id);
    const name = recipient?.display_name || recipient?.email?.split("@")[0] || "The member";
    showToast(`${name} saw your attention ring.`, "success");
  }
}

function fileSearchType(item) {
  const mime = String(item.mime_type || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function handleFileLibraryChange(payload) {
  if (payload.eventType === "INSERT" && payload.new.uploaded_by !== currentSession?.user.id) {
    playNotificationSound();
    if (!state.selectedDirectUserId && state.selectedChannelId === payload.new.channel_id) {
      markConversationRead("channel", payload.new.channel_id);
    }
  }
  scheduleReload(false);
}

function handleThreadReplyChange(payload) {
  if (payload.eventType === "INSERT" && payload.new.author_id !== currentSession?.user.id) {
    playNotificationSound();
    const parent = state.messages.find((message) => message.id === payload.new.channel_message_id)
      || state.directMessages.find((message) => message.id === payload.new.direct_message_id);
    if (parent?.channel_id && state.selectedChannelId === parent.channel_id && !state.selectedDirectUserId) {
      markConversationRead("channel", parent.channel_id);
    } else if (parent?.sender_id) {
      const otherId = parent.sender_id === currentSession.user.id ? parent.recipient_id : parent.sender_id;
      if (state.selectedDirectUserId === otherId) markConversationRead("direct", otherId);
    }
  }
  scheduleReload(false);
}

function handleMessageChange(payload, type) {
  if (payload.eventType === "INSERT") {
    handleIncomingMessage(payload.new, type);
    return;
  }
  scheduleReload(false);
}

function unsubscribeRealtime() {
  if (state.realtime && supabaseClient) supabaseClient.removeChannel(state.realtime);
  state.realtime = null;
}

function handleIncomingMessage(message, type) {
  const senderId = type === "channel" ? message.author_id : message.sender_id;
  const isOwn = senderId === currentSession?.user.id;
  const active = type === "channel"
    ? !state.selectedDirectUserId && state.selectedChannelId === message.channel_id
    : state.selectedDirectUserId === (message.sender_id === currentSession?.user.id ? message.recipient_id : message.sender_id);
  if (active) {
    const conversationId = type === "channel"
      ? message.channel_id
      : (message.sender_id === currentSession?.user.id ? message.recipient_id : message.sender_id);
    markConversationRead(type === "channel" ? "channel" : "direct", conversationId);
  }
  if (!isOwn) playNotificationSound();
  scheduleReload(active);
}

function scheduleReload(scrollToBottom = false) {
  window.clearTimeout(state.reloadTimer);
  state.reloadTimer = window.setTimeout(() => loadWorkspace(scrollToBottom), 250);
}

function loadViewState() {
  try {
    const saved = localStorage.getItem(`vine-connect-last-viewed:${currentSession.user.id}`);
    state.lastViewed = saved ? JSON.parse(saved) : {};
    state.viewStateInitialized = Boolean(saved);
  } catch (_error) {
    state.lastViewed = {};
    state.viewStateInitialized = false;
  }
}

function initializeViewState() {
  if (state.viewStateInitialized || !currentSession) return;
  const now = new Date().toISOString();
  state.channels.forEach((channel) => { state.lastViewed[`channel:${channel.id}`] = now; });
  state.members.filter((member) => member.id !== currentSession.user.id).forEach((member) => {
    state.lastViewed[`direct:${member.id}`] = now;
  });
  state.viewStateInitialized = true;
  saveViewState();
}

function markConversationRead(type, id) {
  if (!id || !currentSession) return;
  state.lastViewed[`${type}:${id}`] = new Date().toISOString();
  saveViewState();
}

function saveViewState() {
  if (!currentSession) return;
  localStorage.setItem(`vine-connect-last-viewed:${currentSession.user.id}`, JSON.stringify(state.lastViewed));
}

function isChannelUnread(channelId) {
  const viewedAt = state.lastViewed[`channel:${channelId}`] || "1970-01-01T00:00:00.000Z";
  const unreadMessage = state.messages.some((message) => message.channel_id === channelId
    && message.author_id !== currentSession?.user.id
    && new Date(message.created_at) > new Date(viewedAt));
  const unreadReply = state.threadReplies.some((reply) => {
    const parent = state.messages.find((message) => message.id === reply.channel_message_id);
    return parent?.channel_id === channelId
      && reply.author_id !== currentSession?.user.id
      && new Date(reply.created_at) > new Date(viewedAt);
  });
  const unreadFile = state.fileItems.some((item) => item.channel_id === channelId
    && item.uploaded_by !== currentSession?.user.id
    && new Date(item.created_at) > new Date(viewedAt));
  return unreadMessage || unreadReply || unreadFile;
}

function isDirectUnread(memberId) {
  const viewedAt = state.lastViewed[`direct:${memberId}`] || "1970-01-01T00:00:00.000Z";
  const unreadMessage = state.directMessages.some((message) => message.sender_id === memberId
    && message.recipient_id === currentSession?.user.id
    && new Date(message.created_at) > new Date(viewedAt));
  const unreadReply = state.threadReplies.some((reply) => {
    const parent = state.directMessages.find((message) => message.id === reply.direct_message_id);
    if (!parent || reply.author_id === currentSession?.user.id || new Date(reply.created_at) <= new Date(viewedAt)) return false;
    return (parent.sender_id === memberId && parent.recipient_id === currentSession?.user.id)
      || (parent.sender_id === currentSession?.user.id && parent.recipient_id === memberId);
  });
  return unreadMessage || unreadReply;
}

function unlockNotificationAudio() {
  unlockAudio(notificationAudio);
  if (state.activeRing && !state.notificationsMuted) {
    ringAudio.currentTime = 0;
    ringAudio.volume = 0.9;
    ringAudio.play().catch(() => {});
  } else {
    unlockAudio(ringAudio);
  }
}

function unlockAudio(audio) {
  const previousVolume = audio.volume;
  audio.volume = 0;
  audio.play().then(() => {
    audio.pause();
    audio.currentTime = 0;
    audio.volume = previousVolume;
  }).catch(() => { audio.volume = previousVolume; });
}

function playNotificationSound() {
  if (state.notificationsMuted) return;
  notificationAudio.currentTime = 0;
  notificationAudio.volume = 0.85;
  notificationAudio.play().catch(() => {
    // Browsers can block sound until the member interacts with the page once.
  });
}

function applyNotificationPreference() {
  state.notificationsMuted = localStorage.getItem("vine-connect-notifications-muted") === "true";
  updateNotificationButton();
}

function toggleNotifications() {
  state.notificationsMuted = !state.notificationsMuted;
  localStorage.setItem("vine-connect-notifications-muted", String(state.notificationsMuted));
  if (state.notificationsMuted) {
    notificationAudio.pause();
    notificationAudio.currentTime = 0;
    ringAudio.pause();
    ringAudio.currentTime = 0;
  } else if (state.activeRing) {
    ringAudio.currentTime = 0;
    ringAudio.volume = 0.9;
    ringAudio.play().catch(() => {});
  }
  updateNotificationButton();
  showToast(state.notificationsMuted ? "Notification and ring sounds muted." : "Notification and ring sounds turned on.", "success");
}

function updateNotificationButton() {
  const button = $("#toggle-notifications");
  if (!button) return;
  const label = state.notificationsMuted ? "Turn on notification and ring sounds" : "Mute notification and ring sounds";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.classList.toggle("muted", state.notificationsMuted);
  button.querySelector(".glyph").textContent = state.notificationsMuted ? "\uD83D\uDD15" : "\uD83D\uDD14";
}

async function apiRequest(path, { method = "GET", body, responseType = "json" } = {}) {
  const endpoint = meetingApiEndpoint(path);
  if (!endpoint || !currentSession?.access_token) {
    const error = new Error("The secure Hostinger API is not available.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${currentSession.access_token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const error = new Error(details.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return responseType === "blob" ? response.blob() : response.json();
}

async function sendHeartbeat() {
  if (!currentSession) return;
  await apiRequest("/session/heartbeat", { method: "POST" }).catch(() => {});
}

function openScheduleMessageModal() {
  if (!$("#message-input").value.trim() && !state.pendingFiles.length) return showToast("Write a message or attach a file first.", "error");
  if (!state.selectedChannelId && !state.selectedDirectUserId) return;
  const date = new Date(Date.now() + 30 * 60 * 1000);
  $("#scheduled-message-date").value = localDateInputValue(date);
  $("#scheduled-message-time").value = date.toTimeString().slice(0, 5);
  hideError("schedule-message-error");
  openModal("schedule-message-modal");
}

async function scheduleCurrentMessage(event) {
  event.preventDefault();
  const scheduledFor = new Date(`${$("#scheduled-message-date").value}T${$("#scheduled-message-time").value}`);
  if (!Number.isFinite(scheduledFor.getTime()) || scheduledFor.getTime() < Date.now() + 60 * 1000) {
    return showFormError("schedule-message-error", "Choose a time at least one minute in the future.");
  }
  await sendMessage(scheduledFor.toISOString());
}

async function toggleBookmark(message) {
  if (!state.platformReady) return showToast("Run vine-connect-platform-upgrade.sql in Supabase first.", "error");
  const bookmark = state.bookmarks.find((item) => item.channel_message_id === message.id || item.direct_message_id === message.id);
  const query = supabaseClient.from("message_bookmarks");
  const { error } = bookmark
    ? await query.delete().eq("id", bookmark.id)
    : await query.insert({ user_id: currentSession.user.id, channel_message_id: message.channel_id ? message.id : null, direct_message_id: message.sender_id ? message.id : null });
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
  showToast(bookmark ? "Bookmark removed." : "Message bookmarked privately.", "success");
}

function openBookmarks() {
  const items = state.bookmarks.map((bookmark) => {
    const message = bookmark.channel_message_id
      ? state.messages.find((entry) => entry.id === bookmark.channel_message_id)
      : state.directMessages.find((entry) => entry.id === bookmark.direct_message_id);
    if (!message) return null;
    const channel = state.channels.find((entry) => entry.id === message.channel_id);
    return { message, label: channel ? `#${channel.name}` : "Direct message", action: () => navigateToMessage(message) };
  }).filter(Boolean);
  showActivityModal("Bookmarks", "Messages saved privately for you.", items);
}

function openScheduledMessages() {
  const items = state.scheduledMessages.map((scheduled) => ({
    message: { body: scheduled.body, created_at: scheduled.scheduled_for },
    label: `${titleCase(scheduled.status)} - ${scheduled.message_type === "channel" ? `#${state.channels.find((channel) => channel.id === scheduled.channel_id)?.name || "channel"}` : state.members.find((member) => member.id === scheduled.recipient_id)?.display_name || "Direct message"}`,
    action: async () => {
      if (scheduled.status !== "pending" || !window.confirm("Cancel this scheduled message?")) return;
      const { error } = await supabaseClient.from("scheduled_messages").update({ status: "cancelled" }).eq("id", scheduled.id).eq("sender_id", currentSession.user.id);
      if (error) return showToast(error.message, "error");
      await loadWorkspace(false);
      openScheduledMessages();
    },
  }));
  showActivityModal("Scheduled messages", "Click a pending message to cancel it.", items);
}

function updatePlatformBadges() {
  const bookmarks = $("#bookmark-total");
  bookmarks.textContent = state.bookmarks.length;
  bookmarks.hidden = state.bookmarks.length === 0;
  const scheduled = $("#scheduled-total");
  const pendingCount = state.scheduledMessages.filter((item) => item.status === "pending").length;
  scheduled.textContent = pendingCount;
  scheduled.hidden = pendingCount === 0;
}

async function toggleFileFavorite(item) {
  const favorite = state.fileFavorites.find((entry) => entry.file_item_id === item.id);
  const query = supabaseClient.from("file_favorites");
  const { error } = favorite
    ? await query.delete().eq("user_id", currentSession.user.id).eq("file_item_id", item.id)
    : await query.insert({ user_id: currentSession.user.id, file_item_id: item.id });
  if (error) return showToast(error.message, "error");
  await loadWorkspace(false);
  showToast(favorite ? "Removed from file favorites." : "Added to file favorites.", "success");
}

function syncPresence() {
  const presenceState = state.realtime?.presenceState?.() || {};
  state.presence.clear();
  Object.values(presenceState).flat().forEach((presence) => {
    if (presence.user_id) state.presence.set(presence.user_id, presence);
  });
  renderDirectMessages();
  renderMembers();
  if (!$("#crm-modal").hidden) renderCrm();
}

function memberPresenceStatus(member) {
  if (state.presence.has(member.id)) return "online";
  if (member.last_active_at && Date.now() - new Date(member.last_active_at).getTime() < 15 * 60 * 1000) return "away";
  return "offline";
}

function memberLastActiveLabel(member) {
  const status = memberPresenceStatus(member);
  if (status === "online") return "Online now";
  if (!member.last_active_at) return "Never active";
  return `Last active ${new Date(member.last_active_at).toLocaleString()}`;
}

function conversationTypingKey() {
  return state.selectedDirectUserId ? `direct:${[currentSession.user.id, state.selectedDirectUserId].sort().join(":")}` : `channel:${state.selectedChannelId}`;
}

function broadcastTyping() {
  if (!state.realtime || !currentSession || (!state.selectedChannelId && !state.selectedDirectUserId)) return;
  const key = conversationTypingKey();
  state.realtime.send({ type: "broadcast", event: "typing", payload: { userId: currentSession.user.id, key, typing: true } });
  window.clearTimeout(state.typingTimer);
  state.typingTimer = window.setTimeout(() => {
    state.realtime?.send({ type: "broadcast", event: "typing", payload: { userId: currentSession.user.id, key, typing: false } });
  }, 1800);
}

function handleTypingBroadcast({ payload }) {
  if (!payload?.userId || payload.userId === currentSession?.user.id) return;
  const key = `${payload.key}:${payload.userId}`;
  if (payload.typing) {
    state.typingMembers.set(key, Date.now() + 2500);
    window.setTimeout(renderTypingIndicator, 2600);
  } else state.typingMembers.delete(key);
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const prefix = `${conversationTypingKey()}:`;
  const now = Date.now();
  const ids = [];
  state.typingMembers.forEach((expires, key) => {
    if (expires <= now) state.typingMembers.delete(key);
    else if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
  });
  const names = ids.map((id) => state.members.find((member) => member.id === id)?.display_name).filter(Boolean);
  const indicator = $("#typing-indicator");
  indicator.hidden = names.length === 0;
  indicator.textContent = names.length ? `${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""} ${names.length === 1 ? "is" : "are"} typing...` : "";
}

async function initializePwa() {
  const installButton = $("#install-vine-app");
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (installButton) installButton.hidden = installed;
  if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installButton) installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    if (installButton) installButton.hidden = true;
    showToast("Vine Connect installed.", "success");
  });
}

async function installVineApp() {
  if (!deferredInstallPrompt) return showToast("Use your browser menu and choose Install Vine Connect or Add to Home screen.");
  await deferredInstallPrompt.prompt();
  deferredInstallPrompt = null;
  $("#install-vine-app").hidden = true;
}

async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return showToast("This browser does not support web push.", "error");
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await apiRequest("/notifications/vapid-public-key");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    await apiRequest("/notifications/subscribe", { method: "POST", body: { subscription: subscription.toJSON() } });
    $("#enable-push").textContent = "Push enabled";
    showToast("Background push notifications enabled.", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function applyNotificationPreferencesUi() {
  const preferences = state.notificationPreferences || { direct_messages: true, mentions: true, rings: true, channel_messages: false };
  $$('[data-notification-pref]').forEach((input) => { input.checked = preferences[input.dataset.notificationPref] !== false; });
}

async function saveNotificationPreferences() {
  if (!currentSession) return;
  const values = { user_id: currentSession.user.id };
  $$('[data-notification-pref]').forEach((input) => { values[input.dataset.notificationPref] = input.checked; });
  const { error } = await supabaseClient.from("notification_preferences").upsert(values, { onConflict: "user_id" });
  if (error) return showToast(error.message, "error");
  state.notificationPreferences = values;
  showToast("Notification preferences saved.", "success");
}

async function exportAdminReport(kind) {
  try {
    const blob = await apiRequest(`/admin/export/${kind}`, { responseType: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vine-connect-${kind}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function signOut() {
  closeModal("profile-modal");
  if (!supabaseClient) return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (subscription) {
      await apiRequest("/notifications/subscribe", { method: "DELETE", body: { endpoint: subscription.endpoint } });
      await subscription.unsubscribe();
    }
  } catch (_error) {
    // Signing out must still continue if push cleanup is temporarily unavailable.
  }
  const { error } = await supabaseClient.auth.signOut();
  if (error) showToast(error.message, "error");
}

function openModal(id) {
  const element = document.getElementById(id);
  if (element) element.hidden = false;
}

function closeModal(id) {
  if (id === "meeting-modal") return closeMeeting();
  if (id === "ring-modal") return dismissActiveRing(false);
  if (id === "emoji-modal") state.reactionTarget = null;
  if (id === "move-subchannel-modal") state.movingSubchannelId = null;
  const element = document.getElementById(id);
  if (element) element.hidden = true;
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebar-scrim").hidden = false;
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebar-scrim").hidden = true;
}

function updateSendState() {
  const hasContent = Boolean($("#message-input")?.value.trim() || state.pendingFiles.length);
  const hasConversation = Boolean(state.selectedChannelId || state.selectedDirectUserId);
  $("#send-message").disabled = !hasContent || !hasConversation || state.busy;
}

function applySavedTheme() {
  const saved = localStorage.getItem("vine-connect-theme");
  const theme = saved || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.body.dataset.theme = theme;
  updateThemeButtons(theme);
}

function toggleTheme() {
  const theme = document.body.dataset.theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = theme;
  localStorage.setItem("vine-connect-theme", theme);
  updateThemeButtons(theme);
}

function updateThemeButtons(theme) {
  $$(".theme-toggle").forEach((button) => {
    button.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} mode`);
    const glyph = button.querySelector(".glyph") || button;
    glyph.textContent = theme === "dark" ? "\u2600" : "\u263e";
  });
}

function showLoginError(message) {
  showFormError("login-error", message);
}

function showFormError(id, message) {
  const element = document.getElementById(id);
  element.textContent = message;
  element.hidden = false;
}

function hideError(id) {
  const element = document.getElementById(id);
  element.hidden = true;
  element.textContent = "";
}

function setButtonBusy(button, busy, label) {
  state.busy = busy;
  button.disabled = busy;
  button.textContent = label;
}

function showToast(message, type = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast ${type}`.trim();
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3600);
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Video metadata could not be read."));
    };
    video.src = url;
  });
}

function getInitials(value) {
  return String(value || "Vine member").split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function avatarClass(seed = "") {
  const classes = ["avatar-coral", "avatar-blue", "avatar-gold", "avatar-mint", "avatar-lilac"];
  const total = [...String(seed)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return classes[total % classes.length];
}

function titleCase(value) {
  return String(value || "").replace(/^./, (character) => character.toUpperCase());
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDateLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(date);
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function makeId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}
