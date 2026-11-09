ALTER TABLE recurrence_series ADD COLUMN "classDetails" jsonb;
ALTER TABLE recurrence_series ADD CONSTRAINT series_class_details CHECK (
  "classDetails" IS NULL OR (
    kind = 'fixed' AND jsonb_typeof("classDetails") = 'object'
    AND "classDetails" ? 'type' AND "classDetails"->>'type' IN ('lecture', 'lab')
    AND "classDetails" ? 'slot' AND jsonb_typeof("classDetails"->'slot') = 'string'
    AND length("classDetails"->>'slot') <= 40
  )
);
