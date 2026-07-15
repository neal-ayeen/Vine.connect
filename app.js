"use strict";

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 120;
const STORAGE_BUCKET = "chat-files";

const state = {
  channels: [],
  messages: [],
  members: [],
  selectedChannelId: null,
  expanded: new Set(),
  pendingFiles: [],
  pendingPreviews: new Map(),
  attachmentUrls: new Map(),
  realtime: null,
  reloadTimer: null,
  busy: false,
};

let supabaseClient = null;
let currentSession = null;
let currentProfile = null;
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  applySavedTheme();

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
  $("#profile-form").addEventListener("submit", updateProfile);
  $("#message-input").addEventListener("input", updateSendState);
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#send-message").addEventListener("click", sendMessage);
  $("#attach-files").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (event) => queueFiles(event.target.files));
  $("#focus-composer").addEventListener("click", () => $("#message-input").focus());
  $("#open-channel-modal").addEventListener("click", openChannelModal);
  $("#open-profile").addEventListener("click", openProfileModal);
  $("#open-members").addEventListener("click", () => openModal("members-modal"));
  $("#open-search").addEventListener("click", openSearch);
  $("#search-input").addEventListener("input", renderSearchResults);
  $("#mobile-menu").addEventListener("click", openSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $("#sign-out").addEventListener("click", signOut);
  $("#sign-out-quick").addEventListener("click", signOut);
  $$(".theme-toggle").forEach((button) => button.addEventListener("click", toggleTheme));
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
  $$(".modal-layer, .search-layer").forEach((layer) => layer.addEventListener("click", (event) => {
    if (event.target === layer) closeModal(layer.id);
  }));

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
    unsubscribeRealtime();
    currentProfile = null;
    state.channels = [];
    state.messages = [];
    state.members = [];
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
    .select("id,email,display_name,role")
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

  const [channelsResult, messagesResult, membersResult] = await Promise.all([
    supabaseClient.from("channels").select("id,name,description,parent_id,created_at").order("created_at", { ascending: true }),
    supabaseClient.from("messages").select("id,channel_id,author_id,body,attachments,created_at,author:profiles!messages_author_id_fkey(display_name,email)").order("created_at", { ascending: true }).limit(1000),
    supabaseClient.from("profiles").select("id,email,display_name,role").order("display_name", { ascending: true }),
  ]);

  const firstError = channelsResult.error || messagesResult.error || membersResult.error;
  if (firstError) {
    messagePane.innerHTML = `<div class="empty-channel"><span class="empty-icon">!</span><h2>Workspace could not load</h2><p>${escapeHtml(firstError.message)}</p></div>`;
    showToast(firstError.message, "error");
    return;
  }

  state.channels = channelsResult.data || [];
  state.messages = messagesResult.data || [];
  state.members = membersResult.data || [];

  const savedChannel = localStorage.getItem("vine-connect-channel");
  const selectionExists = state.channels.some((channel) => channel.id === state.selectedChannelId);
  if (!selectionExists) {
    state.selectedChannelId = state.channels.some((channel) => channel.id === savedChannel)
      ? savedChannel
      : (state.channels.find((channel) => channel.name === "general") || state.channels[0])?.id || null;
  }

  renderChannels();
  renderMembers();
  renderConversation(scrollToBottom);
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
    const group = document.createElement("div");
    const row = document.createElement("div");
    row.className = `channel-row${channel.id === state.selectedChannelId ? " active" : ""}`;

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

    row.append(channelButton(channel));
    group.append(row);

    if (children.length && state.expanded.has(channel.id)) {
      children.forEach((child) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `subchannel${child.id === state.selectedChannelId ? " active" : ""}`;
        button.innerHTML = '<span class="sub-line"></span><i class="glyph">#</i>';
        const name = document.createElement("span");
        name.textContent = child.name;
        button.append(name);
        button.addEventListener("click", () => selectChannel(child.id));
        group.append(button);
      });
    }
    container.append(group);
  });
}

function channelButton(channel) {
  const button = document.createElement("button");
  button.className = "channel-button";
  button.type = "button";
  button.innerHTML = '<i class="glyph">#</i>';
  const name = document.createElement("span");
  name.textContent = channel.name;
  button.append(name);
  button.addEventListener("click", () => selectChannel(channel.id));
  return button;
}

function selectChannel(id) {
  state.selectedChannelId = id;
  localStorage.setItem("vine-connect-channel", id);
  const channel = state.channels.find((item) => item.id === id);
  if (channel?.parent_id) state.expanded.add(channel.parent_id);
  renderChannels();
  renderConversation(true);
  closeSidebar();
}

function renderConversation(scrollToBottom = false) {
  const channel = state.channels.find((item) => item.id === state.selectedChannelId);
  if (!channel) {
    $("#channel-name").textContent = "Vine Connect";
    $("#channel-description").textContent = "Your workspace has no channels yet.";
    $("#message-input").placeholder = "No channel selected";
    $("#message-input").disabled = true;
    $("#message-pane").innerHTML = '<div class="empty-channel"><span class="empty-icon">#</span><h2>No channels yet</h2><p>An administrator can create the first channel.</p></div>';
    updateSendState();
    return;
  }

  $("#message-input").disabled = false;
  $("#channel-name").textContent = channel.name;
  $("#channel-description").textContent = channel.description || "Vine Solutions company conversation";
  $("#message-input").placeholder = `Message #${channel.name}`;
  const messages = state.messages.filter((message) => message.channel_id === channel.id);
  const pane = $("#message-pane");
  pane.replaceChildren();

  const intro = document.createElement("section");
  intro.className = "channel-intro";
  intro.innerHTML = `<div class="intro-hash">#</div><h2>${escapeHtml(channel.name)}</h2><p>${escapeHtml(channel.description || `This is the start of #${channel.name}.`)}</p>`;
  pane.append(intro);

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

  if (scrollToBottom) requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
  updateSendState();
}

function renderMessage(message) {
  const author = message.author || state.members.find((member) => member.id === message.author_id) || {};
  const name = author.display_name || author.email?.split("@")[0] || "Vine member";
  const row = document.createElement("article");
  row.className = "message-row";

  const avatar = document.createElement("span");
  avatar.className = `avatar ${avatarClass(message.author_id)}`;
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
  content.append(meta);

  if (message.body) {
    const body = document.createElement("p");
    body.textContent = message.body;
    content.append(body);
  }

  (Array.isArray(message.attachments) ? message.attachments : []).forEach((attachment) => {
    const holder = document.createElement("div");
    holder.className = "attachment-holder";
    holder.innerHTML = '<span class="attachment-preview-fallback spin">&#9696;</span>';
    content.append(holder);
    hydrateAttachment(holder, attachment);
  });

  row.append(content);
  return row;
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
  if ((!body && !state.pendingFiles.length) || !state.selectedChannelId || state.busy) return;
  state.busy = true;
  updateSendState();
  const button = $("#send-message");
  button.innerHTML = '<i class="glyph spin">&#9696;</i>';

  try {
    const attachments = [];
    for (const { file } of state.pendingFiles) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
      const path = `${currentSession.user.id}/${makeId()}-${safeName}`;
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

    const { error } = await supabaseClient.from("messages").insert({
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
  const { data, error } = await supabaseClient.from("channels").insert({
    name,
    description: $("#new-channel-description").value.trim(),
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
  showToast(`#${name} created.`, "success");
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
    .select("id,email,display_name,role")
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
    container.append(row);
  });
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
    button.innerHTML = '<span class="search-result-icon">#</span>';
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = channel.name;
    const description = document.createElement("small");
    description.textContent = channel.description || "Vine Solutions channel";
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
  state.realtime = supabaseClient.channel("vine-connect-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "channels" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, scheduleReload)
    .subscribe();
}

function unsubscribeRealtime() {
  if (state.realtime && supabaseClient) supabaseClient.removeChannel(state.realtime);
  state.realtime = null;
}

function scheduleReload() {
  window.clearTimeout(state.reloadTimer);
  state.reloadTimer = window.setTimeout(() => loadWorkspace(true), 250);
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
  $("#send-message").disabled = !hasContent || !state.selectedChannelId || state.busy;
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
