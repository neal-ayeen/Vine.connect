"use strict";

const CACHE = "vine-connect-shell-20260812-2";
const SHELL = ["/", "/index.html", "/style.css?v=20260812-2", "/app.js?v=20260812-2", "/modern/modern-tools.js?v=20260812-1", "/flag-polyfill.js", "/offline.html", "/offline.js", "/manifest.webmanifest", "/vine-solutions-logo.png", "/notification.mp3?v=20260716-2", "/ringtone.mp3?v=20260717-1"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.hostname.endsWith("supabase.co")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && url.origin === self.location.origin) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});

self.addEventListener("push", (event) => {
  const data = event.data?.json?.() || {};
  event.waitUntil(self.registration.showNotification(data.title || "Vine Connect", {
    body: data.body || "You have a new notification.",
    icon: "/vine-solutions-logo.png",
    badge: "/vine-solutions-logo.png",
    tag: data.tag || "vine-connect",
    renotify: data.kind === "ring",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});
