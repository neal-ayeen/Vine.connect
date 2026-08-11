import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type ConnectionState = "online" | "offline" | "checking";

function ModernTools() {
  const [connection, setConnection] = useState<ConnectionState>(navigator.onLine ? "checking" : "offline");
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const online = () => setConnection("checking");
    const offline = () => setConnection("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);

    let cancelled = false;
    const check = async () => {
      if (!navigator.onLine) return setConnection("offline");
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) setConnection(response.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setConnection("offline");
      }
    };
    check();
    const timer = window.setInterval(check, 60_000);

    navigator.serviceWorker?.getRegistration().then((registration) => {
      if (!registration) return;
      if (registration.waiting) setUpdateReady(true);
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", () => {
          if (registration.waiting) setUpdateReady(true);
        });
      });
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  const applyUpdate = async () => {
    const registration = await navigator.serviceWorker?.getRegistration();
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    window.location.reload();
  };

  return (
    <div className={`modern-status modern-status-${connection}`} role="status" aria-live="polite">
      <span className="modern-status-dot" aria-hidden="true" />
      <span>{connection === "online" ? "Connected" : connection === "offline" ? "Offline" : "Checking"}</span>
      {updateReady && <button type="button" onClick={applyUpdate}>Update app</button>}
    </div>
  );
}

const root = document.getElementById("modern-tools-root");
if (root) createRoot(root).render(<ModernTools />);
