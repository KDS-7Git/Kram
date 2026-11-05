import { Field } from "../../components/ui/kit";
import { weekdays } from "../../shared/format";

const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
function ruleParts(rule: string | null): Record<string, string> {
  return Object.fromEntries(
    (rule || "")
      .replace(/^RRULE:/, "")
      .split(";")
      .filter(Boolean)
      .map((part) => part.split("=")),
  );
}
export function recurrenceWords(rule: string | null) {
  const parts = ruleParts(rule);
  const unit =
    parts.FREQ === "DAILY"
      ? "day"
      : parts.FREQ === "WEEKLY"
        ? "week"
        : parts.FREQ === "MONTHLY"
          ? "month"
          : null;
  if (
    !unit ||
    Object.keys(parts).some(
      (key) => !["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY"].includes(key),
    )
  )
    return "on its repeating calendar rule";
  const interval = Number(parts.INTERVAL || 1);
  const days = (parts.BYDAY || "")
    .split(",")
    .map((code) => weekdays[dayCodes.indexOf(code)]?.label)
    .filter(Boolean)
    .join(", ");
  return `every ${interval === 1 ? unit : `${interval} ${unit}s`}${days ? ` on ${days}` : parts.BYMONTHDAY ? ` on day ${parts.BYMONTHDAY}` : ""}`;
}
export function RecurrenceFields({
  rule,
  onChange,
}: {
  rule: string | null;
  onChange: (rule: string) => void;
}) {
  const parts = ruleParts(rule);
  const frequency = ["DAILY", "WEEKLY", "MONTHLY"].includes(parts.FREQ || "")
    ? parts.FREQ
    : "custom";
  const interval = Number(parts.INTERVAL || 1);
  const selectedDays = (parts.BYDAY || "MO,TU,WE,TH,FR").split(",");
  const monthDay = Number(parts.BYMONTHDAY || 1);
  const update = (next: {
    frequency?: string;
    interval?: number;
    days?: string[];
    monthDay?: number;
  }) => {
    const freq = next.frequency || frequency;
    const by =
      freq === "WEEKLY"
        ? `;BYDAY=${(next.days || selectedDays).join(",")}`
        : freq === "MONTHLY"
          ? `;BYMONTHDAY=${next.monthDay ?? monthDay}`
          : "";
    onChange(`FREQ=${freq};INTERVAL=${next.interval ?? interval}${by}`);
  };
  return (
    <div className="stack">
      <div className="grid-2 form-grid">
        <Field id="recurrence-frequency" label="Repeat frequency">
          <select
            className="input"
            id="recurrence-frequency"
            value={frequency}
            onChange={(event) => update({ frequency: event.target.value })}
          >
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            {frequency === "custom" && (
              <option value="custom">Custom rule</option>
            )}
          </select>
        </Field>
        {frequency !== "custom" && (
          <Field
            id="recurrence-interval"
            label="Repeat every"
            hint={
              frequency === "DAILY"
                ? "days"
                : frequency === "WEEKLY"
                  ? "weeks"
                  : "months"
            }
          >
            <input
              className="input"
              id="recurrence-interval"
              type="number"
              min="1"
              max="365"
              value={interval}
              onChange={(event) =>
                update({ interval: Number(event.target.value) })
              }
            />
          </Field>
        )}
      </div>
      {frequency === "WEEKLY" && (
        <fieldset className="weekday-field">
          <legend>Repeat on</legend>
          <div className="weekday-options">
            {weekdays.map((day, index) => (
              <label key={day.value}>
                <input
                  type="checkbox"
                  checked={selectedDays.includes(dayCodes[index]!)}
                  disabled={
                    selectedDays.length === 1 &&
                    selectedDays.includes(dayCodes[index]!)
                  }
                  onChange={(event) =>
                    update({
                      days: dayCodes.filter((code) =>
                        code === dayCodes[index]
                          ? event.target.checked
                          : selectedDays.includes(code),
                      ),
                    })
                  }
                />
                <span>{day.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {frequency === "MONTHLY" && (
        <Field
          id="recurrence-monthday"
          label="Day of month"
          hint="Months without this date are skipped. Choose 1–28 for every month."
        >
          <input
            className="input"
            id="recurrence-monthday"
            type="number"
            min="1"
            max="31"
            value={monthDay}
            onChange={(event) =>
              update({ monthDay: Number(event.target.value) })
            }
          />
        </Field>
      )}
    </div>
  );
}
