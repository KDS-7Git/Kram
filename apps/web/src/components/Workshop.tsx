import { useState } from "react";
import { BookOpen, Check, SlidersHorizontal, Plus } from "lucide-react";
import {
  Banner,
  Button,
  IconButton,
  ConfirmDialog,
  DurationStepper,
  Toggle,
  ProfileChip,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Segments,
  Sheet,
  Skeleton,
  StatusPill,
} from "./ui/kit";

import { useUI } from "../shared/ui";

export function Workshop() {
  const [view, setView] = useState<"day" | "week">("day");
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [profile, setProfile] = useState('academic');
  const [minutes, setMinutes] = useState(30);
  const { toast } = useUI();
  return (
    <>
      <PageHeader
        title="Paper and Ink"
        eyebrow="Component workshop"
        description="One quiet visual language, in light and dark. Controls keep their meaning with colour, shape and words."
      />
      <div className="stack-lg">
        <Card>
          <div className="card-header">
            <h2>Actions</h2>
            <SlidersHorizontal size={20} strokeWidth={1.5} aria-hidden="true" />
          </div>
          <div className="row">
            <Button variant="primary" onClick={() => setOpen(true)}>
              <BookOpen size={18} strokeWidth={1.5} />
              Open details
            </Button>
            <Button onClick={() => setView("week")}>View week</Button>
            <Button variant="text" onClick={() => setView("day")}>
              Back to day
            </Button>
            <Button disabled aria-describedby="disabled-reason">
              Unavailable
            </Button>
          </div>
          <p
            id="disabled-reason"
            className="caption"
            style={{ marginTop: ".75rem" }}
          >
            Unavailable controls explain what is needed before continuing.
          </p>
        </Card>
        <Card>
          <h2>Buttons · five types, six states</h2>
          <p className="caption" id="matrix-help">Preview controls. Disabled needs a connection; loading keeps its original width and label. Hover, pressed and focus samples display those states for inspection.</p>
          <div className="button-state-matrix">
            {(['primary', 'secondary', 'text', 'destructive', 'icon'] as const).map(variant => <section key={variant} aria-label={`${variant} button states`}><h3>{variant}</h3><div className="button-state-row">{(['default', 'hover', 'pressed', 'focus', 'disabled', 'loading'] as const).map(state => <div key={state} className="button-state-example"><span className="caption">{state}</span><Button variant={variant === 'icon' ? 'text' : variant} className={variant === 'icon' ? 'button-icon' : undefined} data-demo-state={state} disabled={state === 'disabled'} loading={state === 'loading'} aria-label={variant === 'icon' ? `Add item · ${state}` : undefined} aria-describedby="matrix-help" onClick={() => variant === 'destructive' ? setConfirm(true) : toast('Example action acknowledged.')}>{variant === 'icon' ? <Plus size={18} strokeWidth={1.5} /> : variant === 'destructive' ? 'Delete' : variant === 'text' ? 'Defer' : variant === 'secondary' ? 'Done' : 'Start'}</Button></div>)}</div></section>)}
          </div>
        </Card>
        <Card>
          <h2>Controls · shape, state and touch</h2>
          <div className="stack" style={{ marginBlockStart: '1rem' }}>
            <Toggle label="Example setting" checked={enabled} onChange={setEnabled} />
            <div className="row wrap"><ProfileChip label="Academic" color="slate" selected={profile === 'academic'} onClick={() => setProfile('academic')} /><ProfileChip label="Development" color="sky" selected={profile === 'development'} onClick={() => setProfile('development')} /></div>
            <Field id="kit-minutes" label="Minutes" hint="Type minutes or 1h20; hold plus or minus to repeat."><DurationStepper id="kit-minutes" label="Minutes" value={minutes} onChange={setMinutes} describedBy="kit-minutes-hint" /></Field>
            <Field id="kit-time" label="Local time"><input className="input" id="kit-time" type="time" step="300" defaultValue="18:00" /></Field>
            <div className="row wrap" role="group" aria-label="Task check shapes">{['pending', 'completed', 'partial'].map(status => <button type="button" key={status} className="button button-text" onClick={() => toast(`Example ${status === 'pending' ? 'to do' : status === 'completed' ? 'done' : 'partial'} state.`)}><StatusPill status={status} /></button>)}</div>
          </div>
        </Card>
        <Card>
          <h2>Feedback</h2>
          <p className="muted">Undo stays available for 5 seconds and pauses while hovered or focused.</p>
          <div className="row wrap"><Button onClick={() => toast('Marked done · example.', () => { toast('Example undone.'); })}>Preview Undo toast</Button><IconButton label="Preview feedback" onClick={() => toast('Example feedback.') }><Check size={18} strokeWidth={1.5} /></IconButton></div>
          <Banner>Offline example · reconnect to save progress and planning.</Banner>
        </Card>
        <div className="grid-2">
          <Card>
            <h2>Status in words</h2>
            <div className="stack" style={{ marginTop: "1rem" }}>
              {[
                "pending",
                "in_progress",
                "partial",
                "completed",
                "skipped",
                "deferred",
                "cancelled",
                "overdue",
                "unverified",
                "proposed",
              ].map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </Card>
          <Card>
            <h2>Form controls</h2>
            <div className="stack" style={{ marginTop: "1rem" }}>
              <Field
                id="workshop-title"
                label="Goal title"
                hint="Use a short, specific name."
              >
                <input
                  className="input"
                  id="workshop-title"
                  placeholder="Read for 20 minutes"
                  aria-describedby="workshop-title-hint"
                />
              </Field>
              <Field
                id="workshop-duration"
                label="Duration"
                error="Enter at least 1 minute."
              >
                <input
                  className="input"
                  id="workshop-duration"
                  inputMode="numeric"
                  aria-invalid="true"
                  aria-describedby="workshop-duration-error"
                  defaultValue="0"
                />
              </Field>
              <Segments
                options={[
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                ]}
                value={view}
                onChange={setView}
                label="Example calendar view"
              />
              <p className="caption">Selected: {view}</p>
            </div>
          </Card>
        </div>
        <Banner tone="info">
          Changes to today and tomorrow are proposals. You choose when to apply
          them.
        </Banner>
        <Banner tone="warning">
          This is an example warning. It names the issue and gives the next
          step.
        </Banner>
        <div className="grid-2">
          <Card>
            <EmptyState
              icon={<BookOpen strokeWidth={1} />}
              title="Start with one goal"
              action={
                <Button onClick={() => setOpen(true)}>
                  Explore the controls
                </Button>
              }
            >
              A goal can be as small as 15 minutes a day.
            </EmptyState>
          </Card>
          <Card>
            <h2>Loading state</h2>
            <div className="stack" style={{ marginTop: "1rem" }}>
              <Skeleton height={70} />
              <Skeleton height={24} />
              <Skeleton height={24} />
            </div>
          </Card>
        </div>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this example?" description="This is a component preview. No planner data is affected."><div className="row between"><Button onClick={() => setConfirm(false)}>Keep example</Button><Button variant="destructive" onClick={() => { setConfirm(false); toast('Example deletion confirmed.'); }}>Delete example</Button></div></ConfirmDialog>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="A little more detail"
        description="On a phone this becomes a bottom sheet. Keyboard focus stays inside and Escape closes it."
      >
        <div className="stack">
          <p className="muted">
            Every control has a visible label, a clear focus ring and a touch
            target of at least 44 pixels.
          </p>
          <Button variant="primary" onClick={() => setOpen(false)}>
            <Check size={18} strokeWidth={1.5} />
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
