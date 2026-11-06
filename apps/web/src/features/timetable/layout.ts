import type { TimeSlot } from '@kram/shared';
export const layerLabels = { unavailable: 'Unavailable', fixed: 'Fixed', pinned: 'Pinned', reserved: 'Reserved', flexible: 'Flexible' };
// Render overlapping reservations and their work side by side, keeping half-open
// endpoints adjacent. Layout is only a projection; it never edits placements.
export function blockLanes(slots: TimeSlot[], minimumMinutes = 0) {
  const result = new Map<string, { lane: number; count: number }>();
  let group: TimeSlot[] = [], groupEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const slot of group) {
      let lane = ends.findIndex(end => end <= slot.startMin);
      if (lane < 0) lane = ends.length;
      ends[lane] = Math.max(slot.endMin, slot.startMin + minimumMinutes);
      result.set(slot.id, { lane, count: 0 });
    }
    for (const slot of group) result.get(slot.id)!.count = ends.length;
  };
  for (const slot of [...slots].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin || a.id.localeCompare(b.id))) {
    if (slot.startMin >= groupEnd) { flush(); group = []; groupEnd = -1; }
    group.push(slot); groupEnd = Math.max(groupEnd, slot.endMin, slot.startMin + minimumMinutes);
  }
  flush(); return result;
}
