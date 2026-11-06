/** Hours wrap as a group on narrow/large-text screens; the parent owns the name. */
export function TimerDigits({ value }: { value: string }) {
  const parts = value.split(':');
  return parts.length === 3 ? <><span className="timer-hours">{parts[0]}<small>h</small></span><span className="timer-seconds">{parts[1]}:{parts[2]}</span></> : <span className="timer-seconds">{value}</span>;
}
