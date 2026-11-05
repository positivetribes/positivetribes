// One entry per client. Slug = page path. Checks are probed from Cloudflare every minute.
// Only https URLs, set here by Positive Tribes; the public page never shows the URL.
export const CLIENTS = {
  uep: {
    name: "Up ENDing Parkinson's",
    checks: [
      {
        id: "scheduler",
        name: "Climb Scheduler",
        url: "https://uep-scheduler.traveleric.workers.dev/api/health",
        keyword: '"database":"ready"',
      },
    ],
  },
};
