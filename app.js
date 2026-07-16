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
  selectedChannelId: null,
  selectedDirectUserId: null,
  selectedFileFolderId: null,
  libraryUploadContext: null,
  activeThread: null,
  composerTarget: "message-input",
  expanded: new Set(),
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
let toastTimer = null;
let ringTimer = null;
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
  $("#profile-form").addEventListener("submit", updateProfile);
  $("#message-input").addEventListener("input", updateSendState);
  $("#message-input").addEventListener("focus", () => { state.composerTarget = "message-input"; });
  $("#message-input").addEventListener("paste", handleComposerPaste);
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#send-message").addEventListener("click", sendMessage);
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
  $("#open-meeting").addEventListener("click", openMeeting);
  $("#open-ring-direct").addEventListener("click", () => sendMemberRing(state.selectedDirectUserId));
  $("#leave-meeting").addEventListener("click", closeMeeting);
  $("#open-pins-sidebar").addEventListener("click", openPinnedMessages);
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
  $("#mobile-menu").addEventListener("click", openSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $("#sign-out").addEventListener("click", signOut);
  $("#sign-out-quick").addEventListener("click", signOut);
  $("#toggle-notifications").addEventListener("click", toggleNotifications);
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
    currentProfile = null;
    state.channels = [];
    state.messages = [];
    state.directMessages = [];
    state.threadReplies = [];
    state.reactions = [];
    state.reactionsReady = false;
    state.reactionTarget = null;
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
    state.selectedDirectUserId = null;
    state.selectedFileFolderId = null;
    state.activeThread = null;
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
  const [channelsResult, messagesResult, directResult, threadResult, pinsResult, membersResult, clientsResult, fileItemsResult, reactionsResult, ringsResult] = await Promise.all([
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
  state.pins = pinsResult.data || [];
  state.fileItems = fileItemsResult.error ? [] : (fileItemsResult.data || []);
  state.filesFeatureReady = !fileItemsResult.error;
  state.members = membersResult.data || [];
  state.clients = clientsResult.data || [];

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
  renderConversation(scrollToBottom);
  renderActivityBadges();
  if (state.activeThread && !$("#thread-modal").hidden) renderThreadModal();
  processPendingRings();
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
  const topLevel = state.channels.filter((channel) => !channel.parent_id);

  if (!topLevel.length) {
    const empty = document.createElement("p");
    empty.className = "channel-empty";
    empty.textContent = currentProfile?.role === "admin" ? "Create the first channel." : "No channels yet.";
    container.append(empty);
    return;
  }

  topLevel.forEach((channel) => {
    const children = state.channels.filter((item) => item.parent_id === channel.id);
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
        button.innerHTML = `<span class="sub-line"></span><i class="glyph">${child.channel_type === "files" ? "&#128193;" : "#"}</i>`;
        const name = document.createElement("span");
        name.textContent = child.name;
        button.append(name);
        if (childUnread) button.append(unreadDot());
        button.addEventListener("click", () => selectChannel(child.id));
        const subRow = document.createElement("div");
        subRow.className = "subchannel-row";
        subRow.append(button);
        if (currentProfile?.role === "admin") subRow.append(channelDeleteButton(child));
        group.append(subRow);
      });
    }
    container.append(group);
  });
}

function channelButton(channel, unread = false) {
  const button = document.createElement("button");
  button.className = "channel-button";
  button.type = "button";
  button.innerHTML = `<i class="glyph">${channel.channel_type === "files" ? "&#128193;" : "#"}</i>`;
  const name = document.createElement("span");
  name.textContent = channel.name;
  button.append(name);
  if (unread) button.append(unreadDot());
  button.addEventListener("click", () => selectChannel(channel.id));
  return button;
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
  state.busy = true;
  const { error } = await supabaseClient.rpc("delete_vine_channel", { target_channel_id: channel.id });
  let storageWarning = "";
  const storedPaths = [...attachmentPaths, ...libraryPaths];
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
  if (state.selectedChannelId !== id) state.selectedFileFolderId = null;
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
    const avatar = document.createElement("span");
    avatar.className = `direct-avatar ${avatarClass(member.id)}`;
    avatar.textContent = getInitials(member.display_name || member.email);
    const name = document.createElement("span");
    name.className = "direct-name";
    name.textContent = member.display_name || member.email.split("@")[0];
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
  $("#message-input").disabled = false;
  $("#conversation-symbol").textContent = "#";
  $("#channel-name").textContent = channel.name;
  $("#channel-description").textContent = channel.description || "Vine Solutions company conversation";
  $("#open-pins").hidden = false;
  $("#pin-count").textContent = state.pins.filter((pin) => pin.channel_id === channel.id).length;
  $("#message-input").placeholder = `Message #${channel.name}`;
  const messages = state.messages.filter((message) => message.channel_id === channel.id);
  const pane = $("#message-pane");
  pane.replaceChildren();

  const intro = document.createElement("section");
  intro.className = "channel-intro";
  intro.innerHTML = `<div class="intro-hash">#</div><h2>${escapeHtml(channel.name)}</h2><p>${escapeHtml(channel.description || `This is the start of #${channel.name}.`)}</p>`;
  pane.append(intro);
  markConversationRead("channel", channel.id);
  appendMessages(pane, messages);
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
  description.textContent = "Documents are kept in this channel's dedicated Supabase storage folder.";
  title.append(eyebrow, headingText, description);

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
    .sort((a, b) => Number(b.item_type === "folder") - Number(a.item_type === "folder") || a.name.localeCompare(b.name));

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
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const path = `${currentSession.user.id}/libraries/${channel.id}/${itemId}-${safeName}`;
      const { error: storageError } = await supabaseClient.storage.from(STORAGE_BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (storageError) throw storageError;

      const { error: metadataError } = await supabaseClient.from("file_library_items").insert({
        id: itemId,
        channel_id: channel.id,
        parent_id: context.parentId,
        name: file.name,
        item_type: "file",
        storage_path: path,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        uploaded_by: currentSession.user.id,
      });
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

  const preview = window.open("about:blank", "_blank");
  if (!preview) return showToast("Allow pop-ups for Vine Connect to open files in a new tab.", "error");
  preview.opener = null;
  preview.document.title = `Opening ${item.name}`;
  preview.document.body.textContent = `Opening ${item.name}...`;
  const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET).createSignedUrl(item.storage_path, 600);
  if (error || !data?.signedUrl) {
    preview.close();
    return showToast(error?.message || "The file could not be opened.", "error");
  }
  preview.location.replace(data.signedUrl);
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
  const paths = state.fileItems.filter((candidate) => ids.has(candidate.id)).map((candidate) => candidate.storage_path).filter(Boolean);
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
    };
  }

  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel) return null;
  return {
    roomName: `VineConnectChannel${channel.id.replace(/[^a-z0-9]/gi, "")}`,
    title: `#${channel.name} meeting`,
  };
}

function openMeeting() {
  const context = getMeetingContext();
  if (!context) return showToast("Open a channel or direct message first.", "error");

  closeMeeting();
  const frame = $("#meeting-frame");
  frame.innerHTML = '<div class="meeting-loading"><i class="glyph spin">&#9696;</i> Preparing the meeting...</div>';
  $("#meeting-title").textContent = context.title;
  const meetingUrl = `https://meet.jit.si/${encodeURIComponent(context.roomName)}`;
  $("#meeting-new-tab").href = meetingUrl;
  openModal("meeting-modal");

  if (typeof window.JitsiMeetExternalAPI !== "function") {
    frame.innerHTML = '<div class="meeting-error"><strong>The embedded meeting could not load.</strong><span>Check your internet connection, or use Open in new tab.</span></div>';
    return;
  }

  jitsiApi = new window.JitsiMeetExternalAPI("meet.jit.si", {
    roomName: context.roomName,
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
    },
  });
  window.setTimeout(() => frame.querySelector(".meeting-loading")?.remove(), 4000);
  jitsiApi.addEventListener("readyToClose", closeMeeting);
}

function closeMeeting() {
  if (jitsiApi) {
    try { jitsiApi.dispose(); } catch (_error) { /* The meeting may already be closed. */ }
    jitsiApi = null;
  }
  const frame = $("#meeting-frame");
  if (frame) frame.innerHTML = '<div class="meeting-loading"><i class="glyph spin">&#9696;</i> Preparing the meeting...</div>';
  const modal = $("#meeting-modal");
  if (modal) modal.hidden = true;
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
  actions.append(reactionButton, threadButton);
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
  openPinnedMessages();
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

async function sendMessage() {
  const body = $("#message-input").value.trim();
  const hasConversation = Boolean(state.selectedChannelId || state.selectedDirectUserId);
  if ((!body && !state.pendingFiles.length) || !hasConversation || state.busy) return;
  state.busy = true;
  updateSendState();
  const button = $("#send-message");
  button.innerHTML = '<i class="glyph spin">&#9696;</i>';

  try {
    const attachments = [];
    for (const { file } of state.pendingFiles) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const folder = state.selectedDirectUserId
        ? `${currentSession.user.id}/dm/${state.selectedDirectUserId}`
        : currentSession.user.id;
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

    const { error } = state.selectedDirectUserId
      ? await supabaseClient.from("direct_messages").insert({
        sender_id: currentSession.user.id,
        recipient_id: state.selectedDirectUserId,
        body,
        attachments,
      })
      : await supabaseClient.from("messages").insert({
        channel_id: state.selectedChannelId,
        author_id: currentSession.user.id,
        body,
        attachments,
      });
    if (error) throw error;

    $("#message-input").value = "";
    [...state.pendingPreviews.values()].forEach((url) => URL.revokeObjectURL(url));
    state.pendingFiles = [];
    state.pendingPreviews.clear();
    renderPendingFiles();
    await loadWorkspace(true);
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
  $("#new-channel-type").value = "chat";
  updateChannelTypeTip();
  const parentSelect = $("#new-channel-parent");
  parentSelect.innerHTML = '<option value="">No parent - top-level channel</option>';
  state.channels.filter((channel) => !channel.parent_id).forEach((channel) => {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = `Under #${channel.name}`;
    parentSelect.append(option);
  });
  hideError("channel-error");
  openModal("channel-modal");
  $("#new-channel-name").focus();
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
  const { data, error } = await supabaseClient.from("channels").insert({
    name,
    description: $("#new-channel-description").value.trim(),
    channel_type: channelType,
    parent_id: parentId,
    created_by: currentSession.user.id,
  }).select("id").single();

  setButtonBusy(button, false, "Create channel");
  if (error) return showFormError("channel-error", error.code === "23505" ? "That channel name already exists here." : error.message);
  $("#channel-form").reset();
  closeModal("channel-modal");
  state.selectedChannelId = data.id;
  if (parentId) state.expanded.add(parentId);
  await loadWorkspace(true);
  showToast(`${channelType === "files" ? `${name} Files library` : `#${name}`} created.`, "success");
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
      ringButton.addEventListener("click", () => sendMemberRing(member.id));
      const messageButton = document.createElement("button");
      messageButton.type = "button";
      messageButton.className = "message-member-button";
      messageButton.textContent = "Message";
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
  const { data, error } = await supabaseClient.rpc("send_member_ring", { target_member: memberId });
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
    const { data, error } = await supabaseClient.functions.invoke("add-member", {
      body: { action: "create", displayName, email, jobTitle, role },
    });

    if (error) {
      let message = error.message || "The member could not be created.";
      try {
        const details = await error.context?.json();
        message = details?.error || details?.message || message;
      } catch (_ignored) {
        // Use the Supabase error message when the response body is unavailable.
      }
      throw new Error(message);
    }
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
    detail.textContent = [member.job_title, member.email].filter(Boolean).join(" - ");
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
    return;
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
}

function openEmployeeEditor(member) {
  if (currentProfile?.role !== "admin") return;
  $("#employee-id").value = member.id;
  $("#employee-display-name").value = member.display_name || member.email.split("@")[0];
  $("#employee-job-title").value = member.job_title || "";
  $("#employee-role").value = member.role;
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
    const { data, error } = await supabaseClient.functions.invoke("add-member", {
      body: {
        action: "update",
        userId,
        displayName: $("#employee-display-name").value.trim(),
        jobTitle: $("#employee-job-title").value.trim(),
        role: $("#employee-role").value,
      },
    });
    if (error) throw await memberFunctionError(error, "The employee could not be updated.");
    if (data?.error) throw new Error(data.error);
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
    const { data, error } = await supabaseClient.functions.invoke("add-member", {
      body: { action: "reset-password", userId },
    });
    if (error) throw await memberFunctionError(error, "The password could not be reset.");
    if (data?.error) throw new Error(data.error);
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
    const { data, error } = await supabaseClient.functions.invoke("add-member", {
      body: { action: "delete", userId },
    });
    if (error) throw await memberFunctionError(error, "The employee could not be deleted.");
    if (data?.error) throw new Error(data.error);
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
  renderSearchResults();
  $("#search-input").focus();
}

function renderSearchResults() {
  const query = $("#search-input").value.trim().toLowerCase();
  const matches = state.channels.filter((channel) => !query || `${channel.name} ${channel.description || ""}`.toLowerCase().includes(query));
  const container = $("#search-results");
  container.replaceChildren();
  if (!matches.length) {
    container.innerHTML = '<p class="no-results">No matching channels.</p>';
    return;
  }
  const label = document.createElement("span");
  label.className = "search-label";
  label.textContent = "Channels";
  container.append(label);
  matches.forEach((channel) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<span class="search-result-icon">${channel.channel_type === "files" ? "&#128193;" : "#"}</span>`;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const description = document.createElement("small");
    description.textContent = channel.description || (channel.channel_type === "files" ? "Shared files library" : "Vine Solutions channel");
    copy.append(name, description);
    const arrow = document.createElement("span");
    arrow.textContent = ">";
    button.append(copy, arrow);
    button.addEventListener("click", () => {
      selectChannel(channel.id);
      closeModal("search-modal");
    });
    container.append(button);
  });
}

function subscribeRealtime() {
  unsubscribeRealtime();
  let realtime = supabaseClient.channel("vine-connect-live")
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
  state.realtime = realtime
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, () => scheduleReload(false))
    .on("postgres_changes", { event: "*", schema: "public", table: "crm_clients" }, () => scheduleReload(false))
    .subscribe();
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

async function signOut() {
  closeModal("profile-modal");
  if (!supabaseClient) return;
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
