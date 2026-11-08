// One entry per D1 database to back up. `binding` must match a d1_databases binding in wrangler.jsonc.
export const DATABASES = {
  hub: { binding: "HUB_DB" },
  admin: { binding: "ADMIN_DB" },
  "uep-scheduler": { binding: "UEP_SCHEDULER_DB" },
};

// Client slug (same as status/src/config.js) -> the databases that hold that client's data. The client's public
// "Nightly backup" status row is up only while every one of these has a fresh backup.
export const CLIENT_CHECKS = {
  uep: ["hub", "uep-scheduler"],
};

export const KEEP_DAYS = 30;
// A backup older than this is "stale": the daily run is 24h, with two hours of slack.
export const STALE_HOURS = 26;
