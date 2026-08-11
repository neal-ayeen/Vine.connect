/*
  Safe for the public website: use the Project URL and publishable key from
  Supabase Dashboard > Project Settings > API.

  NEVER put the service_role key in this file.
*/
window.VINE_SUPABASE_CONFIG = Object.freeze({
  url: "https://YOUR_PROJECT_REF.supabase.co",
  publishableKey: "YOUR_SUPABASE_PUBLISHABLE_KEY",
  // Leave empty when the Hostinger Node app serves this website and its /api routes.
  // If the API is on a subdomain, use its full URL, for example https://api.example.com.
  meetingApiUrl: "",
});
