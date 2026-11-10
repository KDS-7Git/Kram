CREATE TABLE college_slot_template (
  id uuid PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  name text NOT NULL,
  periods jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL,
  CONSTRAINT college_slot_template_name CHECK (length(trim(name)) BETWEEN 1 AND 100),
  CONSTRAINT college_slot_template_periods CHECK (jsonb_typeof(periods) = 'array' AND jsonb_array_length(periods) BETWEEN 1 AND 200),
  CONSTRAINT college_slot_template_version CHECK (version > 0)
);
CREATE INDEX college_slot_template_user_idx ON college_slot_template ("userId");
