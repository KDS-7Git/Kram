import { useRef, type ReactNode } from "react";
import { AnimatePresence, Reorder, useDragControls } from "framer-motion";
import { GripVertical } from "lucide-react";
import { IconButton } from "../../components/ui/kit";
import { listSpring, useMotionPreference } from "../../shared/motion";

interface Props {
  tasks: { id: string; title: string }[];
  disabled: boolean;
  onReorder: (ids: string[]) => void;
  onCommit: (ids: string[]) => void;
  renderRow: (id: string) => ReactNode;
}

/** The handle owns dragging; scrolling, completion and row shortcuts remain independent. */
export function TaskOrderList({ tasks, disabled, onReorder, onCommit, renderRow }: Props) {
  const ids = tasks.map(task => task.id);
  const latest = useRef(ids);
  latest.current = ids;
  return <Reorder.Group as="ul" axis="y" values={ids} onReorder={onReorder} className="today-task-list task-order-list" aria-label="Tasks in your order">
    <AnimatePresence initial={false}>{tasks.map(task => <OrderRow key={task.id} task={task} disabled={disabled}
      onCommit={() => onCommit(latest.current)} onMove={direction => {
        const index = latest.current.indexOf(task.id), next = index + direction;
        if (next < 0 || next >= latest.current.length) return;
        const order = [...latest.current];
        [order[index], order[next]] = [order[next]!, order[index]!];
        onReorder(order);
        onCommit(order);
      }}>{renderRow(task.id)}</OrderRow>)}</AnimatePresence>
  </Reorder.Group>;
}

function OrderRow({ task, disabled, onMove, onCommit, children }: {
  task: { id: string; title: string }; disabled: boolean; onMove: (direction: -1 | 1) => void; onCommit: () => void; children: ReactNode;
}) {
  const controls = useDragControls();
  const reduced = useMotionPreference();
  return <Reorder.Item as="li" value={task.id} className="task-order-row" layout="position" dragListener={false}
    dragControls={controls} dragElastic={.04} dragMomentum={false} onDragEnd={onCommit}
    transition={reduced ? { duration: 0 } : listSpring}
    whileDrag={{ zIndex: 5, ...(reduced ? {} : { scale: 1.015, boxShadow: "var(--shadow-popover)" }) }}
    exit={reduced ? undefined : { opacity: 0, height: 0 }}>
    <IconButton label={`Reorder ${task.title}`} className="task-drag-handle" aria-disabled={disabled}
      aria-describedby="task-order-help" onPointerDown={event => { if (!disabled) controls.start(event); }}
      onKeyDown={event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          if (!disabled) onMove(event.key === "ArrowUp" ? -1 : 1);
        }
      }}><GripVertical size={16} strokeWidth={1.6} /></IconButton>
    {children}
  </Reorder.Item>;
}
