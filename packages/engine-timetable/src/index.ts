import { addDays, parseLocalDate, weekday } from '@kram/time';
import type { FreeSlot, FreeSlotsInput, Interval, Layer, ScheduleTemplate, SlotConflict, TimeSlot } from './types';
export const engineVersion = '0.2.0';
export type { Layer, Interval, TimeSlot, FreeSlot, ReservedWindow, FreeSlotsInput, SlotConflict, TemplateEntry, ScheduleTemplate } from './types';

const names = ['unavailable', 'fixed', 'pinned', 'reserved', 'flexible'] as const;
export function layerName(layer: Layer) { return typeof layer === 'number' ? names[layer]! : layer; }
function validInterval(interval: Interval) {
  if (!Number.isInteger(interval.startMin) || !Number.isInteger(interval.endMin) || interval.startMin < 0 || interval.endMin > 1440 || interval.endMin <= interval.startMin) throw new RangeError('Use an increasing interval within one calendar day.');
}
export function overlapAllowed(a: TimeSlot, b: TimeSlot) {
  const first = layerName(a.layer), second = layerName(b.layer);
  if (first !== 'reserved' && second !== 'reserved' || !a.skillId || a.skillId !== b.skillId) return false;
  if (first === 'reserved' && second === 'reserved') return true;
  const reserved = first === 'reserved' ? a : b, work = first === 'reserved' ? b : a;
  return layerName(work.layer) === 'flexible' && !work.pinned && work.startMin >= reserved.startMin && work.endMin <= reserved.endMin;
}
/** Sweep occupied intervals; adjacent intervals never overlap. */
export function conflicts(slots: TimeSlot[]): SlotConflict[] {
  const sorted = [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || (a.id ?? '').localeCompare(b.id ?? ''));
  let active: TimeSlot[] = []; const result: SlotConflict[] = [];
  for (const slot of sorted) {
    parseLocalDate(slot.date); validInterval(slot);
    if (!names.includes(layerName(slot.layer))) throw new RangeError('Unknown timetable layer.');
    active = active.filter(previous => previous.date === slot.date && previous.endMin > slot.startMin);
    for (const previous of active) if (!overlapAllowed(previous, slot)) result.push({ first: previous, second: slot, message: `${previous.title ?? 'Time block'} overlaps ${slot.title ?? 'time block'}.` });
    active.push(slot);
  }
  return result;
}
/** Free intervals are disjoint and labelled with the skill that reserves them. */
export function freeSlots(input: FreeSlotsInput): FreeSlot[] {
  parseLocalDate(input.date); validInterval(input.wakingWindow);
  for (const value of [input.maxDailyMin, input.minFreeTime, input.minBreak, input.breakAfter]) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 1440)) throw new RangeError('Capacity and break minutes must be from 0 to 1440.');
  if (input.restDay || input.maxDailyMin === 0) return [];
  const slots = input.slots.filter(slot => slot.date === input.date);
  if (conflicts(slots).length) throw new RangeError('Resolve timetable conflicts before computing free time.');
  const reserved = [...slots.filter(slot => layerName(slot.layer) === 'reserved').map(slot => ({ startMin: slot.startMin, endMin: slot.endMin, skillId: slot.skillId! })),
    ...(input.reservedWindows ?? []).filter(window => !window.days || window.days.includes(weekday(input.date)))];
  for (const window of reserved) { validInterval(window); if (!window.skillId) throw new RangeError('Reserved time needs a skill.'); }
  const busy = slots.filter(slot => layerName(slot.layer) !== 'reserved').map(slot => ({ startMin: slot.startMin, endMin: Math.min(1440, slot.endMin + (slot.endMin - slot.startMin > (input.breakAfter ?? 60) ? input.minBreak ?? 0 : 0)) }));
  const start = input.wakingWindow.startMin, end = input.wakingWindow.endMin;
  const cuts = [...new Set([start, end, ...busy.flatMap(slot => [Math.max(start, Math.min(end, slot.startMin)), Math.max(start, Math.min(end, slot.endMin))]), ...reserved.flatMap(window => [Math.max(start, Math.min(end, window.startMin)), Math.max(start, Math.min(end, window.endMin))])])].sort((a, b) => a - b);
  const result: FreeSlot[] = [];
  for (let index = 0; index < cuts.length - 1; index++) {
    const startMin = cuts[index]!, endMin = cuts[index + 1]!;
    if (busy.some(slot => slot.startMin < endMin && slot.endMin > startMin)) continue;
    const owners = [...new Set(reserved.filter(window => window.startMin < endMin && window.endMin > startMin).map(window => window.skillId))];
    if (owners.length > 1) throw new RangeError('Different skills cannot reserve the same free time.');
    const previous = result.at(-1), skillId = owners[0];
    if (previous && previous.endMin === startMin && previous.skillId === skillId) previous.endMin = endMin;
    else result.push({ date: input.date, startMin, endMin, ...(skillId ? { skillId } : {}) });
  }
  let reserve = input.minFreeTime ?? 0;
  for (let index = result.length - 1; index >= 0 && reserve > 0; index--) {
    const slot = result[index]!;
    if (slot.skillId) continue;
    const amount = Math.min(reserve, slot.endMin - slot.startMin); slot.endMin -= amount; reserve -= amount;
  }
  const allocated = slots.filter(slot => !['unavailable', 'reserved'].includes(layerName(slot.layer))).reduce((sum, slot) => sum + slot.endMin - slot.startMin, 0);
  if (reserve > 0) for (let index = result.length - 1; index >= 0 && reserve > 0; index--) {
    const slot = result[index]!; if (!slot.skillId) continue;
    const amount = Math.min(reserve, slot.endMin - slot.startMin); slot.endMin -= amount; reserve -= amount;
  }
  let cap = Math.max(0, (input.maxDailyMin ?? 1440) - allocated);
  const priority = [...result.filter(slot => slot.skillId), ...result.filter(slot => !slot.skillId)];
  return priority.flatMap(slot => { const length = Math.min(cap, slot.endMin - slot.startMin); cap -= length; return length > 0 ? [{ ...slot, endMin: slot.startMin + length }] : []; }).sort((a, b) => a.startMin - b.startMin);
}
export function applyTemplate(template: ScheduleTemplate, anchor: string): TimeSlot[] {
  parseLocalDate(anchor);
  const slots = template.entries.map(entry => {
    if (!Number.isInteger(entry.weekday) || entry.weekday < 1 || entry.weekday > 7) throw new RangeError('Template weekday must be from 1 to 7.');
    const { weekday: day, ...value } = entry;
    validInterval(value);
    return { ...value, date: template.kind === 'day' ? anchor : addDays(anchor, (day - weekday(anchor) + 7) % 7), templateId: template.id };
  });
  if (conflicts(slots).length) throw new RangeError('Template entries overlap.');
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}
