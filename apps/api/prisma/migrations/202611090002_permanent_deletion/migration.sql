-- Normal edits retain append-only history. A confirmed erasure opens only the
-- exact owner/table/row scope for the lifetime of its transaction.
CREATE FUNCTION confirmed_erasure_allowed(owner_id uuid, row_id uuid, table_name text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT table_name IN ('goal_rule_version', 'progress_event', 'notification_attempt',
    'template_application', 'streak_rule_version', 'streak_record', 'plan_item', 'plan_version')
    AND current_setting('kram.erase_owner', true) = owner_id::text
    AND EXISTS (SELECT 1 FROM app_user WHERE id = owner_id AND "isOwner" = true)
    AND COALESCE(NULLIF(current_setting('kram.erase_scope', true), ''), '{}')::jsonb -> table_name ? row_id::text;
$$;

CREATE OR REPLACE FUNCTION protect_append_only_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND confirmed_erasure_allowed(OLD."userId", OLD.id, TG_TABLE_NAME) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Append-only history cannot be changed.' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION protect_plan_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF confirmed_erasure_allowed(OLD."userId", OLD.id, TG_TABLE_NAME) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Plan history is immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'Plan version contents are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
