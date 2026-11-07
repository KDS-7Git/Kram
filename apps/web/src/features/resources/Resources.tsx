import { useEffect, useState, type KeyboardEvent } from "react";
import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import { listSpring, useMotionPreference } from "../../shared/motion";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderKanban,
  GraduationCap,
  GripVertical,
  ListPlus,
  Pencil,
  Plus,
} from "lucide-react";
import {
  resourceSchema,
  resourceItemSchema,
  resourceTypes,
  resourceItemKinds,
  type Resource,
  type ResourceItem,
} from "@kram/shared";
import type { z } from "zod";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Sheet,
  DelayedSkeleton as Skeleton,
  StatusPill as Status,
  Truncate,
} from "../../components/ui/kit";
import { api, apiList, errorMessage } from "../../shared/api";
import { useData, useOnline, useRefresh } from "../../shared/data";
import { duration } from "../../shared/format";
import { useUI } from "../../shared/ui";

const resourceLabels = {
  course: "Course",
  book: "Book",
  lab: "Lab",
  project: "Project",
};
const resourceIcons = { course: GraduationCap, book: BookOpen, lab: FlaskConical, project: FolderKanban };
const siblingsOf = (items: ResourceItem[], parentId: string | null) =>
  items
    .filter((item) => item.parentItemId === parentId)
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
function descendants(items: ResourceItem[], itemId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    for (const child of items.filter((item) => item.parentItemId === id)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        visit(child.id);
      }
    }
  };
  visit(itemId);
  return ids;
}
function treeRows(items: ResourceItem[], collapsed: Set<string>) {
  const rows: { item: ResourceItem; depth: number }[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const item of siblingsOf(items, parentId)) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      rows.push({ item, depth });
      if (!collapsed.has(item.id)) visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}
function placements(
  items: ResourceItem[],
  id: string,
  parentItemId: string | null,
  index: number,
) {
  const moving = items.find((item) => item.id === id)!;
  const peers = siblingsOf(items, parentItemId).filter(
    (item) => item.id !== id,
  );
  peers.splice(Math.max(0, Math.min(index, peers.length)), 0, {
    ...moving,
    parentItemId,
  });
  const ordinals = new Map(peers.map((item, ordinal) => [item.id, ordinal]));
  const oldPeers = siblingsOf(items, moving.parentItemId).filter(
    (item) => item.id !== id,
  );
  if (moving.parentItemId !== parentItemId)
    oldPeers.forEach((item, ordinal) => ordinals.set(item.id, ordinal));
  return items.map((item) => ({
    id: item.id,
    parentItemId: item.id === id ? parentItemId : item.parentItemId,
    ordinal: ordinals.get(item.id) ?? item.ordinal,
  }));
}

export function ResourceLibrary() {
  const reduced = useMotionPreference();
  const data = useData();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const goal = data.goals.find((item) => item.id === params.get("goalId"));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (params.get("add") === "resource") {
      setEditing(true);
      const next = new URLSearchParams(params);
      next.delete("add");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const [showArchived, setShowArchived] = useState(false);
  const resources = useQuery({
    queryKey: ["resources", "list", showArchived],
    queryFn: ({ signal }) =>
      apiList<Resource>(`/resources?archived=${showArchived}`, signal),
  });
  const visible = (resources.data || []).filter(
    (resource) => !goal || resource.goalIds.includes(goal.id),
  );
  return (
    <div className="workspace-page resources-workspace">
      <Link className="button button-text back-link" to="/goals">
        <ArrowLeft size={18} strokeWidth={1.5} />
        Profiles and goals
      </Link>
      <PageHeader
        title="Material for the next step"
        eyebrow="Resource library"
        description="Keep your courses, books, labs and projects close to the goals they support."
        action={
          <Button
            variant="primary"
            disabled={!online || !data.skills.length}
            onClick={() => setEditing(true)}
          >
            <Plus size={18} strokeWidth={1.5} />
            New resource
          </Button>
        }
      />
      {goal && (
        <Banner
          tone="info"
          action={
            <Link className="button button-text" to="/resources">
              Show all resources
            </Link>
          }
        >
          Showing resources linked to {goal.title}. Your library is unchanged.
        </Banner>
      )}
      <div className="row between" style={{ marginBlock: "1rem" }}>
        <p className="muted">
          {visible.length} {visible.length === 1 ? "resource" : "resources"}
        </p>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived resources
        </label>
      </div>
      {resources.isError && (
        <Banner tone="error">
          {errorMessage(resources.error)}{" "}
          <Button variant="text" onClick={() => void resources.refetch()}>
            Retry
          </Button>
        </Banner>
      )}
      {resources.isPending ? (
        <div className="grid-2">
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      ) : visible.length ? (
        <LayoutGroup id="resources"><div className="grid-2 resource-grid">
          <AnimatePresence initial={false}>{visible.map((resource) => {
            const ResourceIcon = resourceIcons[resource.type];
            return (
            <m.div key={resource.id} layout={reduced ? false : "position"}
              initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              exit={reduced ? undefined : { opacity: 0, scale: .98 }} transition={reduced ? { duration: 0 } : listSpring}>
            <Card
              className={`resource-card${resource.archivedAt ? " archived-card" : ""}`}
            >
              <p className="eyebrow">{resourceLabels[resource.type]}</p>
              <Link
                to={`/resources/${resource.id}`}
                className="resource-card-title"
              >
                <ResourceIcon size={24} strokeWidth={1.5} />
                <h2><Truncate>{resource.title}</Truncate></h2>
              </Link>
              <p className="caption">
                {data.skills.find((skill) => skill.id === resource.skillId)
                  ?.name || "Archived skill"}{" "}
                · {resource.goalIds.length} linked{" "}
                {resource.goalIds.length === 1 ? "goal" : "goals"}
              </p>
              {resource.archivedAt && <Status status="archived" />}
            </Card></m.div>
          ); })}</AnimatePresence>
        </div></LayoutGroup>
      ) : (
        <Card>
          <EmptyState
            title={
              data.skills.length
                ? "Your material belongs here"
                : "Start with a skill"
            }
            icon={<BookOpen strokeWidth={1} />}
            action={
              data.skills.length ? (
                <Button disabled={!online} onClick={() => setEditing(true)}>
                  Add a resource
                </Button>
              ) : (
                <Link className="button button-primary" to="/goals">
                  Add a skill
                </Link>
              )
            }
          >
            A course outline, reading list or project can become a tree of
            manageable steps.
          </EmptyState>
        </Card>
      )}
      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title="A new resource"
        description="Link material to one skill and any goals it supports."
      >
        {editing && (
          <ResourceEditor goalId={goal?.id} onDone={() => setEditing(false)} />
        )}
      </Sheet>
    </div>
  );
}

function ResourceEditor({
  resource,
  goalId,
  onDone,
}: {
  resource?: Resource;
  goalId?: string;
  onDone: () => void;
}) {
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const goal = data.goals.find((item) => item.id === goalId);
  const form = useForm<
    z.input<typeof resourceSchema>,
    unknown,
    z.output<typeof resourceSchema>
  >({
    resolver: zodResolver(resourceSchema),
    defaultValues: resource || {
      skillId: goal?.skillId || data.skills[0]?.id || "",
      goalId: null,
      goalIds: goal ? [goal.id] : [],
      type: "course",
      title: "",
      url: null,
      notesRef: null,
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (input: z.output<typeof resourceSchema>) =>
      api(resource ? `/resources/${resource.id}` : "/resources", {
        method: resource ? "PATCH" : "POST",
        body: { ...input, goalId: null },
      }),
    onSuccess: async () => {
      await refresh();
      toast(resource ? "Resource updated." : "Resource added.");
      onDone();
    },
  });
  return (
    <form
      className="stack-lg"
      noValidate
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
    >
      <Field
        id="resource-title"
        label="Resource title"
        error={errors.title?.message}
      >
        <input
          className="input"
          id="resource-title"
          autoFocus
          {...form.register("title")}
        />
      </Field>
      <div className="grid-2 form-grid">
        <Field
          id="resource-type"
          label="Resource type"
          error={errors.type?.message}
        >
          <select
            className="input"
            id="resource-type"
            {...form.register("type")}
          >
            {resourceTypes.map((type) => (
              <option value={type} key={type}>
                {resourceLabels[type]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="resource-skill"
          label="Skill"
          error={errors.skillId?.message}
        >
          <select
            className="input"
            id="resource-skill"
            {...form.register("skillId", {
              onChange: () => {
                form.setValue("goalIds", []);
                form.setValue("goalId", null);
              },
            })}
          >
            <option value="">Choose a skill</option>
            {data.skills.map((skill) => (
              <option value={skill.id} key={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        id="resource-url"
        label="Resource URL (optional)"
        hint="An http or https link to the source material."
        error={errors.url?.message}
      >
        <input
          className="input"
          id="resource-url"
          type="url"
          {...form.register("url", { setValueAs: (value) => value || null })}
        />
      </Field>
      <Field
        id="resource-notes"
        label="Notes reference (optional)"
        hint="A link or identifier from your notes app."
        error={errors.notesRef?.message}
      >
        <input
          className="input"
          id="resource-notes"
          {...form.register("notesRef", {
            setValueAs: (value) => value || null,
          })}
        />
      </Field>
      <fieldset className="link-goals">
        <legend>Linked goals</legend>
        <p className="field-hint">
          This material can support several goals in the same skill.
        </p>
        {data.goals
          .filter(
            (goal) =>
              goal.skillId === values.skillId && goal.status !== "archived",
          )
          .map((goal) => (
            <label className="toggle-label" key={goal.id}>
              <input
                type="checkbox"
                checked={(values.goalIds || []).includes(goal.id)}
                onChange={(event) =>
                  form.setValue(
                    "goalIds",
                    event.target.checked
                      ? [...(values.goalIds || []), goal.id]
                      : (values.goalIds || []).filter((id) => id !== goal.id),
                    { shouldDirty: true },
                  )
                }
              />
              {goal.title}
            </label>
          ))}
        {!data.goals.some((goal) => goal.skillId === values.skillId) && (
          <p className="muted">You can link goals after creating them.</p>
        )}
      </fieldset>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save this resource. Your changes stay in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {resource ? "Save resource" : "Add resource"}
      </Button>
    </form>
  );
}

export function ResourceDetail() {
  const { resourceId } = useParams();
  const data = useData();
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [editing, setEditing] = useState(false);
  const [itemEditor, setItemEditor] = useState<{
    item?: ResourceItem;
    parentId: string | null;
  } | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<{
    kind: "resource" | "item";
    id: string;
    title: string;
  } | null>(null);
  const resourceQuery = useQuery({
    queryKey: ["resources", resourceId],
    queryFn: () => api<Resource>(`/resources/${resourceId}`),
  });
  const itemQuery = useQuery({
    queryKey: ["resources", resourceId, "items", showArchived],
    queryFn: ({ signal }) =>
      apiList<ResourceItem>(
        `/resources/${resourceId}/items?archived=${showArchived}`,
        signal,
      ),
  });
  const items = itemQuery.data || [];
  const rows = treeRows(items, collapsed);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
  );
  const reorder = useMutation({
    mutationFn: (layout: ReturnType<typeof placements>) =>
      api(`/resources/${resourceId}/reorder`, {
        method: "POST",
        body: { items: layout },
      }),
    onSuccess: async () => {
      await refresh();
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const saveEstimate = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) =>
      api(`/resource-items/${id}`, {
        method: "PATCH",
        body: { estMinutes: minutes },
      }),
    onSuccess: async () => {
      await refresh();
      toast("Time estimate saved.");
    },
    onError: (error) => toast(errorMessage(error), undefined, "error"),
  });
  const archiveMutation = useMutation({
    mutationFn: () =>
      api(
        archive?.kind === "resource"
          ? `/resources/${archive.id}/archive`
          : `/resource-items/${archive?.id}/archive`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await refresh();
      setArchive(null);
      toast("Archived. Progress history remains available.");
    },
  });
  const move = (item: ResourceItem, direction: -1 | 1) => {
    const peers = siblingsOf(items, item.parentItemId);
    const index = peers.findIndex((peer) => peer.id === item.id) + direction;
    if (index < 0 || index >= peers.length) return;
    reorder.mutate(placements(items, item.id, item.parentItemId, index), {
      onSuccess: () =>
        toast(`${item.title} moved ${direction < 0 ? "earlier" : "later"}.`),
    });
  };
  const indent = (item: ResourceItem, outdent: boolean) => {
    const peers = siblingsOf(items, item.parentItemId);
    const index = peers.findIndex((peer) => peer.id === item.id);
    if (outdent) {
      const parent = items.find((peer) => peer.id === item.parentItemId);
      if (!parent) return;
      const outer = siblingsOf(items, parent.parentItemId);
      reorder.mutate(
        placements(
          items,
          item.id,
          parent.parentItemId,
          outer.findIndex((peer) => peer.id === parent.id) + 1,
        ),
        { onSuccess: () => toast(`${item.title} moved out one level.`) },
      );
    } else {
      const parent = peers[index - 1];
      if (!parent) return;
      setCollapsed((previous) => {
        const next = new Set(previous);
        next.delete(parent.id);
        return next;
      });
      reorder.mutate(
        placements(
          items,
          item.id,
          parent.id,
          siblingsOf(items, parent.id).length,
        ),
        {
          onSuccess: () => toast(`${item.title} nested under ${parent.title}.`),
        },
      );
    }
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const item = items.find((item) => item.id === event.active.id);
    const target = items.find((item) => item.id === event.over?.id);
    if (!item || !target) return;
    if (
      target.parentItemId &&
      (target.parentItemId === item.id ||
        descendants(items, item.id).has(target.parentItemId))
    ) {
      toast("An item cannot be moved inside its own branch.");
      return;
    }
    const peers = siblingsOf(items, target.parentItemId).filter(
      (peer) => peer.id !== item.id,
    );
    reorder.mutate(
      placements(
        items,
        item.id,
        target.parentItemId,
        peers.findIndex((peer) => peer.id === target.id),
      ),
      { onSuccess: () => toast(`${item.title} moved before ${target.title}.`) },
    );
  };
  if (!resourceQuery.data)
    return resourceQuery.isPending ? (
      <div className="stack">
        <Skeleton height={80} />
        <Skeleton height={240} />
      </div>
    ) : (
      <Card>
        <PageHeader
          title="Could not load this resource"
          description={errorMessage(resourceQuery.error)}
        />
        <Button onClick={() => void resourceQuery.refetch()}>Retry</Button>
        <Link className="button button-text" to="/resources">
          Back to library
        </Link>
      </Card>
    );
  const resource = resourceQuery.data;
  const editable = online && !resource.archivedAt && !showArchived;
  const linkedGoals = data.goals.filter((goal) =>
    resource.goalIds.includes(goal.id),
  );
  return (
    <div className="workspace-page resource-detail-workspace">
      <Link className="button button-text back-link" to="/resources">
        <ArrowLeft size={18} strokeWidth={1.5} />
        Resource library
      </Link>
      <PageHeader
        title={resource.title}
        eyebrow={`${resourceLabels[resource.type]} · ${data.skills.find((skill) => skill.id === resource.skillId)?.name || "Archived skill"}`}
        description={`${items.filter((item) => !item.archivedAt).length} ${items.filter((item) => !item.archivedAt).length === 1 ? "item" : "items"} · ${duration(items.filter((item) => !item.archivedAt).reduce((total, item) => total + item.estMinutes, 0))} estimated`}
        action={
          <Button
            disabled={!online || !!resource.archivedAt}
            onClick={() => setEditing(true)}
          >
            <Pencil size={18} strokeWidth={1.5} />
            Edit resource
          </Button>
        }
      />
      {resource.archivedAt && (
        <Banner>
          This resource is archived. Its items and history remain available.
        </Banner>
      )}
      <div className="row resource-metadata">
        {resource.url && (
          <a
            className="button button-text"
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={18} strokeWidth={1.5} />
            Open source
          </a>
        )}
        {linkedGoals.map((goal) => (
          <Link
            className="button button-text"
            to={`/goals/${goal.id}`}
            key={goal.id}
          >
            {goal.title}
          </Link>
        ))}
        {resource.notesRef && (
          <p className="caption">Notes: {resource.notesRef}</p>
        )}
      </div>
      <Card>
        <div className="card-header">
          <h2>Steps and material</h2>
          <div className="row">
            <Button
              variant="text"
              disabled={!editable}
              onClick={() => setOutlineOpen(true)}
            >
              <ListPlus size={18} strokeWidth={1.5} />
              Paste outline
            </Button>
            <Button
              variant="primary"
              disabled={!editable}
              onClick={() => setItemEditor({ parentId: null })}
            >
              <Plus size={18} strokeWidth={1.5} />
              Add item
            </Button>
          </div>
        </div>
        <div className="row between tree-toolbar">
          <Button
            variant="text"
            disabled={!editable || items.length < 2}
            aria-pressed={arranging}
            onClick={() => setArranging((value) => !value)}
          >
            <GripVertical size={18} strokeWidth={1.5} />
            {arranging ? "Finish arranging" : "Arrange items"}
          </Button>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => {
                setShowArchived(event.target.checked);
                setArranging(false);
              }}
            />
            Show archived items
          </label>
        </div>
        {arranging && (
          <Banner tone="info">
            Drag a handle or use the move buttons. With a handle focused, Tab
            nests under the previous item, Shift+Tab moves out a level, and
            Escape finishes arranging.
          </Banner>
        )}
        {itemQuery.isError && (
          <Banner tone="error">
            {errorMessage(itemQuery.error)}{" "}
            <Button variant="text" onClick={() => void itemQuery.refetch()}>
              Retry
            </Button>
          </Banner>
        )}
        {itemQuery.isPending ? (
          <Skeleton height={240} />
        ) : !items.length ? (
          <EmptyState
            title="One small step is enough"
            icon={<FileText strokeWidth={1} />}
            action={
              <Button
                disabled={!editable}
                onClick={() => setItemEditor({ parentId: null })}
              >
                Add the first item
              </Button>
            }
          >
            Add a chapter, video, reading range or task. Paste an outline when
            you already have a list.
          </EmptyState>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  "Drag this handle, or use the move buttons. Tab nests the item under its previous sibling, Shift plus Tab moves it out a level, and Escape finishes arranging.",
              },
              announcements: {
                onDragStart: ({ active }) =>
                  `Moving ${items.find((item) => item.id === active.id)?.title || "this item"}.`,
                onDragOver: ({ over }) =>
                  over
                    ? `Before ${items.find((item) => item.id === over.id)?.title || "this item"}.`
                    : undefined,
                onDragEnd: () => "Saving the new item order.",
                onDragCancel: () => "Move cancelled.",
              },
            }}
          >
            <SortableContext
              items={rows.map((row) => row.item.id)}
              strategy={verticalListSortingStrategy}
            >
              <LayoutGroup id="resource-tree"><div
                className="resource-tree"
                aria-label="Resource items"
                role="list"
              >
                <AnimatePresence initial={false}>{rows.map(({ item, depth }) => (
                  <TreeItem
                    key={item.id}
                    item={item}
                    depth={depth}
                    items={items}
                    arranging={arranging}
                    busy={reorder.isPending}
                    editable={editable && !item.archivedAt}
                    collapsed={collapsed.has(item.id)}
                    onToggle={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                    onEdit={() =>
                      setItemEditor({ item, parentId: item.parentItemId })
                    }
                    onAdd={() => setItemEditor({ parentId: item.id })}
                    onArchive={() =>
                      setArchive({
                        kind: "item",
                        id: item.id,
                        title: item.title,
                      })
                    }
                    onMove={(direction) => move(item, direction)}
                    onKeyboard={(event) => {
                      if (event.key === "Escape") {
                        setArranging(false);
                        event.preventDefault();
                      }
                      if (event.key === "Tab" && arranging) {
                        event.preventDefault();
                        indent(item, event.shiftKey);
                      }
                    }}
                    onEstimate={(minutes) =>
                      saveEstimate.mutate({ id: item.id, minutes })
                    }
                  />
                ))}</AnimatePresence>
              </div></LayoutGroup>
            </SortableContext>
          </DndContext>
        )}
      </Card>
      {!resource.archivedAt && (
        <Button
          variant="text"
          disabled={!online}
          onClick={() =>
            setArchive({
              kind: "resource",
              id: resource.id,
              title: resource.title,
            })
          }
          style={{ marginTop: "1rem" }}
        >
          <Archive size={18} strokeWidth={1.5} />
          Archive resource
        </Button>
      )}
      <Sheet
        open={editing}
        onOpenChange={setEditing}
        title="Edit resource"
        description="Keep the source material and its goal links together."
      >
        {editing && (
          <ResourceEditor
            resource={resource}
            onDone={() => setEditing(false)}
          />
        )}
      </Sheet>
      <Sheet
        open={!!itemEditor}
        onOpenChange={(open) => {
          if (!open) setItemEditor(null);
        }}
        title={itemEditor?.item ? "Edit resource item" : "A new resource item"}
        description="Estimate the time and connect any steps that must come first."
      >
        {itemEditor && (
          <ItemEditor
            item={itemEditor.item}
            resourceId={resource.id}
            parentId={itemEditor.parentId}
            items={items}
            onDone={() => setItemEditor(null)}
          />
        )}
      </Sheet>
      <Sheet
        open={outlineOpen}
        onOpenChange={setOutlineOpen}
        title="Paste an outline"
        description="Indent by two spaces or one tab for each level. Add [35m] after a title to set its estimate."
      >
        {outlineOpen && (
          <OutlineEditor
            resourceId={resource.id}
            onDone={() => setOutlineOpen(false)}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={!!archive}
        onOpenChange={(open) => {
          if (!open) setArchive(null);
        }}
        title={`Archive ${archive?.title || "this item"}?`}
        description={
          archive?.kind === "item"
            ? "This hides this item and all its children from active lists. Their history remains available."
            : "This hides the resource from active lists. Its items, goal links and history remain available."
        }
      >
        <div className="row between">
          <Button onClick={() => setArchive(null)}>Keep active</Button>
          <Button
            variant="destructive"
            loading={archiveMutation.isPending}
            disabled={!online}
            onClick={() => archiveMutation.mutate()}
          >
            Archive
          </Button>
        </div>
        {archiveMutation.isError && (
          <Banner tone="error">{errorMessage(archiveMutation.error)}</Banner>
        )}
      </ConfirmDialog>
    </div>
  );
}

function TreeItem({
  item,
  depth,
  items,
  arranging,
  busy,
  editable,
  collapsed,
  onToggle,
  onEdit,
  onAdd,
  onArchive,
  onMove,
  onKeyboard,
  onEstimate,
}: {
  item: ResourceItem;
  depth: number;
  items: ResourceItem[];
  arranging: boolean;
  busy: boolean;
  editable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAdd: () => void;
  onArchive: () => void;
  onMove: (direction: -1 | 1) => void;
  onKeyboard: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onEstimate: (minutes: number) => void;
}) {
  const reduced = useMotionPreference();
  const [estimate, setEstimate] = useState(item.estMinutes);
  useEffect(() => setEstimate(item.estMinutes), [item.estMinutes]);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: !arranging || !editable || busy, transition: { duration: reduced ? 0 : 260, easing: "cubic-bezier(.16, 1, .3, 1)" } });
  const children = items.some((peer) => peer.parentItemId === item.id);
  const peers = siblingsOf(items, item.parentItemId);
  const index = peers.findIndex((peer) => peer.id === item.id);
  return (
    <m.div role="listitem" layout={reduced || isDragging ? false : "position"} transition={reduced ? { duration: 0 } : listSpring}
      initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reduced ? undefined : { opacity: 0, height: 0 }}>
    <div
      ref={setNodeRef}
      className={`tree-item${isDragging ? " tree-item-dragging" : ""}${item.archivedAt ? " archived-card" : ""}`}
      style={
        {
          transform: CSS.Transform.toString(transform),
          transition,
          "--tree-depth": Math.min(depth, 6),
        } as React.CSSProperties
      }
    >
      <div className="tree-item-main">
        <div className="tree-item-title">
          {arranging && (
            <button
              type="button"
              className="button button-icon button-text tree-handle"
              {...attributes}
              {...listeners}
              aria-label={`Arrange ${item.title}`}
              onKeyDown={onKeyboard}
              disabled={!editable}
              aria-disabled={busy || undefined}
            >
              <GripVertical size={18} strokeWidth={1.5} />
            </button>
          )}
          {children ? (
            <IconButton
              label={`${collapsed ? "Expand" : "Collapse"} ${item.title}`}
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              {collapsed ? (
                <ChevronRight size={18} strokeWidth={1.5} />
              ) : (
                <ChevronDown size={18} strokeWidth={1.5} />
              )}
            </IconButton>
          ) : (
            <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
          )}
          <span>
            <span className="sr-only">Level {depth + 1}. </span>
            <strong><Truncate>{item.title}</Truncate></strong>
            <span className="caption">
              {item.kind}
              {item.pagesFrom ? ` · pp. ${item.pagesFrom}–${item.pagesTo}` : ""}
              {item.dependsOn.length
                ? ` · ${item.dependsOn.length} prerequisites`
                : ""}
              {item.archivedAt ? " · Archived" : ""}
            </span>
          </span>
        </div>
        <label className="tree-estimate">
          <span className="sr-only">{`Time estimate for ${item.title}`}</span>
          <input
            type="number"
            min={item.kind === "chapter" || item.kind === "section" ? 0 : 1}
            max="100000"
            value={estimate}
            onChange={(event) => setEstimate(Number(event.target.value))}
            onBlur={() => {
              if (estimate !== item.estMinutes) onEstimate(estimate);
            }}
            disabled={!editable}
          />
          <span className="caption">min</span>
        </label>
      </div>
      <div className="row tree-item-actions">
        {arranging && (
          <>
            <IconButton
              label={`Move ${item.title} earlier`}
              onClick={() => onMove(-1)}
              disabled={!editable || busy || index === 0}
            >
              <ArrowUp size={17} strokeWidth={1.5} />
            </IconButton>
            <IconButton
              label={`Move ${item.title} later`}
              onClick={() => onMove(1)}
              disabled={!editable || busy || index === peers.length - 1}
            >
              <ArrowDown size={17} strokeWidth={1.5} />
            </IconButton>
          </>
        )}
        <IconButton
          label={`Edit ${item.title}`}
          onClick={onEdit}
          disabled={!editable}
        >
          <Pencil size={17} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label={`Add child to ${item.title}`}
          onClick={onAdd}
          disabled={!editable}
        >
          <Plus size={17} strokeWidth={1.5} />
        </IconButton>
        <IconButton
          label={`Archive ${item.title}`}
          onClick={onArchive}
          disabled={!editable}
        >
          <Archive size={17} strokeWidth={1.5} />
        </IconButton>
        {item.url && (
          <a
            className="button button-text button-icon"
            aria-label={`Open ${item.title}`}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={17} strokeWidth={1.5} />
          </a>
        )}
      </div>
    </div></m.div>
  );
}

function ItemEditor({
  item,
  resourceId,
  parentId,
  items,
  onDone,
}: {
  item?: ResourceItem;
  resourceId: string;
  parentId: string | null;
  items: ResourceItem[];
  onDone: () => void;
}) {
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const blocked = item ? descendants(items, item.id) : new Set<string>();
  if (item) blocked.add(item.id);
  const form = useForm<
    z.input<typeof resourceItemSchema>,
    unknown,
    z.output<typeof resourceItemSchema>
  >({
    resolver: zodResolver(resourceItemSchema),
    defaultValues: item || {
      title: "",
      kind: "task",
      parentItemId: parentId,
      ordinal: siblingsOf(items, parentId).length,
      estMinutes: 30,
      durationMin: null,
      qty: 1,
      url: null,
      pagesFrom: null,
      pagesTo: null,
      dependsOn: [],
    },
  });
  const values = form.watch();
  const errors = form.formState.errors;
  const save = useMutation({
    mutationFn: (input: z.output<typeof resourceItemSchema>) =>
      api(
        item ? `/resource-items/${item.id}` : `/resources/${resourceId}/items`,
        { method: item ? "PATCH" : "POST", body: input },
      ),
    onSuccess: async () => {
      await refresh();
      toast(item ? "Item updated." : "Item added.");
      onDone();
    },
  });
  const nullableNumber = (value: string) => (value ? Number(value) : null);
  return (
    <form
      className="stack-lg"
      noValidate
      onSubmit={form.handleSubmit((input) => save.mutate(input))}
    >
      <Field id="item-title" label="Item title" error={errors.title?.message}>
        <input
          className="input"
          id="item-title"
          autoFocus
          {...form.register("title")}
        />
      </Field>
      <div className="grid-2 form-grid">
        <Field id="item-kind" label="Item kind" error={errors.kind?.message}>
          <select className="input" id="item-kind" {...form.register("kind")}>
            {resourceItemKinds.map((kind) => (
              <option value={kind} key={kind}>
                {kind.charAt(0).toUpperCase() + kind.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="item-parent"
          label="Parent item"
          error={errors.parentItemId?.message}
        >
          <select
            className="input"
            id="item-parent"
            {...form.register("parentItemId", {
              setValueAs: (value) => value || null,
              onChange: (event) =>
                form.setValue(
                  "ordinal",
                  siblingsOf(items, event.target.value || null).filter(
                    (peer) => peer.id !== item?.id,
                  ).length,
                ),
            })}
          >
            <option value="">Top level</option>
            {items
              .filter((peer) => !blocked.has(peer.id) && !peer.archivedAt)
              .map((peer) => (
                <option value={peer.id} key={peer.id}>
                  {peer.title}
                </option>
              ))}
          </select>
        </Field>
        <Field
          id="item-estimate"
          label="Estimated time (min)"
          hint="Chapters and sections can be containers with zero time."
          error={errors.estMinutes?.message}
        >
          <input
            className="input"
            id="item-estimate"
            type="number"
            min="0"
            {...form.register("estMinutes", { valueAsNumber: true })}
          />
        </Field>
        <Field id="item-quantity" label="Quantity" error={errors.qty?.message}>
          <input
            className="input"
            id="item-quantity"
            type="number"
            min="0.01"
            step="any"
            {...form.register("qty", { valueAsNumber: true })}
          />
        </Field>
      </div>
      <Field
        id="item-url"
        label="Item URL (optional)"
        error={errors.url?.message}
      >
        <input
          className="input"
          id="item-url"
          type="url"
          {...form.register("url", { setValueAs: (value) => value || null })}
        />
      </Field>
      <details className="disclosure">
        <summary>Pages and media duration</summary>
        <div className="grid-2 form-grid" style={{ marginTop: "1rem" }}>
          <Field
            id="item-first-page"
            label="First page"
            error={errors.pagesFrom?.message}
          >
            <input
              className="input"
              id="item-first-page"
              type="number"
              min="1"
              {...form.register("pagesFrom", { setValueAs: nullableNumber })}
            />
          </Field>
          <Field
            id="item-last-page"
            label="Last page"
            error={errors.pagesTo?.message}
          >
            <input
              className="input"
              id="item-last-page"
              type="number"
              min={values.pagesFrom || 1}
              {...form.register("pagesTo", { setValueAs: nullableNumber })}
            />
          </Field>
          <Field
            id="item-duration"
            label="Media duration (min)"
            error={errors.durationMin?.message}
          >
            <input
              className="input"
              id="item-duration"
              type="number"
              min="1"
              {...form.register("durationMin", { setValueAs: nullableNumber })}
            />
          </Field>
        </div>
      </details>
      <fieldset className="link-goals">
        <legend>Prerequisites</legend>
        <p className="field-hint">
          Select steps that must be completed before this item. Circular
          dependencies are rejected.
        </p>
        {items
          .filter((peer) => peer.id !== item?.id && !peer.archivedAt)
          .map((peer) => (
            <label className="toggle-label" key={peer.id}>
              <input
                type="checkbox"
                checked={(values.dependsOn || []).includes(peer.id)}
                onChange={(event) =>
                  form.setValue(
                    "dependsOn",
                    event.target.checked
                      ? [...(values.dependsOn || []), peer.id]
                      : (values.dependsOn || []).filter((id) => id !== peer.id),
                    { shouldDirty: true },
                  )
                }
              />
              {peer.title}
            </label>
          ))}
      </fieldset>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && (
        <Banner>
          Reconnect to save this item. Your changes stay in this form.
        </Banner>
      )}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online}
      >
        {item ? "Save item" : "Add item"}
      </Button>
    </form>
  );
}

function OutlineEditor({
  resourceId,
  onDone,
}: {
  resourceId: string;
  onDone: () => void;
}) {
  const online = useOnline();
  const refresh = useRefresh();
  const { toast } = useUI();
  const [outline, setOutline] = useState("");
  const [minutes, setMinutes] = useState(30);
  const save = useMutation({
    mutationFn: () =>
      api<{ items: ResourceItem[]; imported: number }>(
        `/resources/${resourceId}/import-outline`,
        { method: "POST", body: { outline, defaultMinutes: minutes } },
      ),
    onSuccess: async (result) => {
      await refresh();
      toast(`${result.imported} ${result.imported === 1 ? "item" : "items"} imported.`);
      onDone();
    },
  });
  const lines = outline.split("\n").filter((line) => line.trim()).length;
  return (
    <form
      className="stack-lg"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field
        id="outline-text"
        label="Outline"
        hint="Import adds new items. Existing items stay in place."
      >
        <textarea
          className="input code-input outline-input"
          id="outline-text"
          rows={12}
          value={outline}
          onChange={(event) => setOutline(event.target.value)}
          placeholder={
            "Introduction\n  First lesson [20m]\n  Practice exercise [40m]\nNext chapter"
          }
          required
          maxLength={100000}
        />
      </Field>
      <Field id="outline-minutes" label="Default item time (min)">
        <input
          className="input"
          id="outline-minutes"
          type="number"
          min="1"
          max="960"
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
          required
        />
      </Field>
      <p className="caption">
        {lines} nonempty {lines === 1 ? "line" : "lines"} to import. Each line
        becomes an item; indented lines become children.
      </p>
      {save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}
      {!online && <Banner>Reconnect to import this outline.</Banner>}
      <Button
        variant="primary"
        type="submit"
        loading={save.isPending}
        disabled={!online || !outline.trim()}
      >
        Import outline
      </Button>
    </form>
  );
}
