-- How a phase's testing window is counted, from its agreement. UEP Phase 1: 10 business days, then the phase is
-- accepted automatically unless the client has listed problems.
ALTER TABLE releases ADD COLUMN uat_day_type TEXT NOT NULL DEFAULT 'calendar' CHECK (uat_day_type IN ('calendar', 'business'));
ALTER TABLE releases ADD COLUMN auto_accept INTEGER NOT NULL DEFAULT 0 CHECK (auto_accept IN (0, 1));
