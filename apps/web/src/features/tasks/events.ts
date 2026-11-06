import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  progressInputSchema,
  type ProgressEvent,
  type ProgressInput,
  type Task,
} from "@kram/shared";
import { api, ApiIssue, errorMessage } from "../../shared/api";
import { useRefresh } from "../../shared/data";
import { useUI } from "../../shared/ui";

export type TaskEventResult = {
  task: Task;
  event: ProgressEvent;
  replayed: boolean;
};
export function useTaskEvents(taskId: string) {
  const pending = useRef<ProgressInput | null>(null);
  const refresh = useRefresh();
  const client = useQueryClient();
  const { toast } = useUI();
  const mutation = useMutation({
    mutationFn: (input: ProgressInput) =>
      api<TaskEventResult>(`/tasks/${taskId}/events`, {
        method: "POST",
        body: input,
      }),
    onSuccess: async (result, input) => {
      pending.current = null;
      client.setQueryData(["tasks", taskId], result.task);
      await refresh();
      if (input.kind === "completed" || input.kind === "progress")
        toast(input.kind === "completed" ? "Task completed." : "Progress saved.", async () => {
          await post("correction", {
            referenceEventId: result.event.id,
            note: input.kind === "completed" ? "Undo completion" : "Undo progress",
          });
        });
      else
        toast(
          input.kind === "paused"
              ? "Timer paused."
              : input.kind === "started" || input.kind === "resumed"
                ? "Timer running."
                : input.kind === "deferred"
                  ? "Task deferred."
                  : input.kind === "skipped"
                    ? "Occurrence skipped."
                    : input.kind === "cancelled"
                      ? "Task cancelled."
                      : "Correction saved.",
        );
    },
    onError: (error) => {
      if (
        !(error instanceof ApiIssue) ||
        !["NETWORK_ERROR", "BAD_RESPONSE", "REQUEST_FAILED"].includes(
          error.code,
        )
      )
        pending.current = null;
      toast(errorMessage(error), undefined, "error");
    },
  });
  async function post(
    kind: ProgressInput["kind"],
    values: Partial<
      Omit<ProgressInput, "kind" | "clientEventId" | "occurredAt">
    > = {},
  ) {
    if (pending.current)
      throw new ApiIssue(
        "Retry the pending event before adding another one.",
        "PENDING_EVENT",
      );
    const input = progressInputSchema.parse({
      clientEventId: crypto.randomUUID(),
      kind,
      occurredAt: new Date().toISOString(),
      ...values,
    });
    pending.current = input;
    return mutation.mutateAsync(input);
  }
  const retry = async () => {
    if (pending.current) return mutation.mutateAsync(pending.current);
  };
  return {
    post,
    retry,
    mutation,
    uncertain: !!pending.current && mutation.isError,
  };
}
