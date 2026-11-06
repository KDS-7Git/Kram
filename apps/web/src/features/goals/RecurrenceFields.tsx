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
  const savedDays = (parts.BYDAY || "").split(",").filter(day => dayCodes.includes(day));
  const selectedDays = savedDays.length ? savedDays : dayCodes.slice(0, 5);
  const monthDay = Number(parts.BYMONTHDAY || 1);
  const monthPattern = parts.BYSETPOS === '-1' ? 'last-weekday' : parts.BYDAY && /^-?[1-5](MO|TU|WE|TH|FR|SA|SU)$/.test(parts.BYDAY) ? 'numbered' : 'date';
  const ordinal = Number(parts.BYDAY?.match(/^-?\d+/)?.[0] || 1), monthWeekday = parts.BYDAY?.slice(-2) || 'SU';
  const update = (next: {
    frequency?: string;
    interval?: number;
    days?: string[];
    monthDay?: number;
    monthPattern?: string;
    ordinal?: number;
    monthWeekday?: string;
  }) => {
    const freq = next.frequency || frequency;
    const by =
      freq === "WEEKLY"
        ? `;BYDAY=${(next.days || selectedDays).join(",")}`
        : freq === "MONTHLY"
          ? (next.monthPattern || monthPattern) === 'last-weekday' ? ';BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1' : (next.monthPattern || monthPattern) === 'numbered' ? `;BYDAY=${next.ordinal ?? ordinal}${next.monthWeekday || monthWeekday}` : `;BYMONTHDAY=${next.monthDay ?? monthDay}`
          : "";
    const ending = ['COUNT', 'UNTIL', 'WKST'].filter(key => parts[key]).map(key => `;${key}=${parts[key]}`).join('');
    onChange(`FREQ=${freq};INTERVAL=${next.interval ?? interval}${by}${ending}`);
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
      {frequency === 'MONTHLY' && <Field id="recurrence-month-pattern" label="Monthly pattern"><select className="input" id="recurrence-month-pattern" value={monthPattern} onChange={event => update({ monthPattern: event.target.value })}><option value="date">A date of the month</option><option value="numbered">A numbered weekday</option><option value="last-weekday">Last working weekday</option></select></Field>}
      {frequency === 'MONTHLY' && monthPattern === 'numbered' && <div className="grid-2"><Field id="recurrence-ordinal" label="Which week"><select className="input" id="recurrence-ordinal" value={ordinal} onChange={event => update({ ordinal: Number(event.target.value) })}>{[[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [5, 'Fifth'], [-1, 'Last']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field id="recurrence-month-weekday" label="Monthly weekday"><select className="input" id="recurrence-month-weekday" value={monthWeekday} onChange={event => update({ monthWeekday: event.target.value })}>{weekdays.map((day, index) => <option key={day.value} value={dayCodes[index]}>{day.label}</option>)}</select></Field></div>}
      {frequency === "MONTHLY" && monthPattern === 'date' && (
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
