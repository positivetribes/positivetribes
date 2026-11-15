-- A phase's acceptance makes one Salesforce Task (a reminder to send the acceptance invoice, listing the approved
-- changes that ship in it): when the client signs off, or when an auto-accept testing window ends with no problems.
-- sf_task_id is the claim, so a phase never gets two Tasks; sf_task_reason says which of the two made it. Additive only.
ALTER TABLE releases ADD COLUMN sf_task_id TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN sf_task_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE releases ADD COLUMN sf_error TEXT NOT NULL DEFAULT '';
