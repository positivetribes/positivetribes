-- A client's own Salesforce address (https, on salesforce.com or force.com); empty = the client has no Salesforce, so no button.
ALTER TABLE clients ADD COLUMN salesforce_url TEXT NOT NULL DEFAULT '';
