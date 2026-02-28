-- Set Decay Edge (chatgpt) agent's politician_whitelist to null
-- so the dynamic Top 10 filter from politician_rankings takes effect.
-- Should be applied after the pipeline is running and rankings are fresh.
UPDATE agents
SET config_json = json_set(config_json, '$.politician_whitelist', json('null')),
    updated_at = datetime('now')
WHERE id = 'chatgpt';
