import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as automationApi from "../../api/automation";
import type { AutomationTask } from "../../api/automation";
import * as clientsApi from "../../api/clients";
import { appCache } from "../../store/appCache";
import AutomationPage, { describeSchedule, describeWaves, parseWaves } from "../Automation";

const TASK: AutomationTask = {
  id: 1,
  kind: "agent_update",
  name: "Weekly agent update",
  enabled: true,
  scope: "default",
  scope_value: null,
  device_ids: [],
  excluded_client_ids: [8],
  excluded_device_ids: [],
  skip_maintenance: true,
  schedule: "weekly",
  run_at: null,
  time_of_day: "02:00",
  weekday: 6,
  day_of_month: null,
  window_minutes: 240,
  wave_sizes: [10, 50, 0],
  wave_wait_minutes: 30,
  max_failure_percent: 5,
  next_run_at: "2026-11-01T01:00:00",
  last_run_at: null,
  created_by: "denis",
  created_at: "2026-10-24T20:00:00",
  last_run: {
    id: 3,
    task_id: 1,
    status: "halted",
    trigger: "schedule",
    started_at: "2026-10-25T01:00:00",
    finished_at: "2026-10-25T01:40:00",
    waves: [
      {
        wave: 1,
        batch_id: "b1",
        device_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        started_at: "2026-10-25T01:00:00",
        settled_at: "2026-10-25T01:20:00",
        completed: 8,
        failed: 2,
        unfinished: 0,
      },
    ],
    reason: "Wave 1: 2 of 10 did not update (limit 5%)",
  },
};

describe("Automation", () => {
  beforeEach(() => {
    appCache.invalidate();
    vi.spyOn(clientsApi, "getClients").mockResolvedValue([{ id: 8, name: "Adpascucci" }] as never);
    vi.spyOn(clientsApi, "getGroups").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads waves and schedules the way an operator writes them", () => {
    expect(parseWaves("10, 50, 200, the rest")).toEqual([10, 50, 200, 0]);
    expect(parseWaves("5 → 20 → all")).toEqual([5, 20, 0]);
    expect(parseWaves("10, the rest, 50")).toBeNull();
    expect(parseWaves("ten")).toBeNull();
    expect(describeWaves([10, 50, 0])).toBe("10 → 50 → the rest");
    expect(describeSchedule(TASK)).toBe("Every Sunday at 02:00");
  });

  it("lists a task with its schedule, exclusions and the last run's outcome", async () => {
    vi.spyOn(automationApi, "getAutomationTasks").mockResolvedValue([TASK]);
    const runs = vi.spyOn(automationApi, "getAutomationRuns").mockResolvedValue([TASK.last_run!]);
    render(<AutomationPage />);
    expect(await screen.findByText("Weekly agent update")).toBeInTheDocument();
    expect(screen.getByText(/Every Sunday at 02:00 · Every device · except Adpascucci/)).toBeInTheDocument();
    expect(screen.getByText("Halted")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(await screen.findByText(/2 of 10 did not update/)).toBeInTheDocument();
    expect(screen.getByText(/8 updated/)).toBeInTheDocument();
    expect(runs).toHaveBeenCalledWith(1);
  });

  it("creates a task from the editor", async () => {
    vi.spyOn(automationApi, "getAutomationTasks").mockResolvedValue([]);
    const create = vi.spyOn(automationApi, "createAutomationTask").mockResolvedValue(TASK);
    render(<AutomationPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: /New task/ }))[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Fleet update" } });
    fireEvent.change(within(dialog).getByLabelText("Waves"), { target: { value: "5, 20, the rest" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fleet update",
        scope: "default",
        schedule: "weekly",
        weekday: 6,
        time_of_day: "02:00",
        wave_sizes: [5, 20, 0],
        wave_wait_minutes: 30,
        max_failure_percent: 5,
        window_minutes: 240,
      }),
    );
  });

  it("refuses waves it cannot read, before sending anything", async () => {
    vi.spyOn(automationApi, "getAutomationTasks").mockResolvedValue([]);
    const create = vi.spyOn(automationApi, "createAutomationTask");
    render(<AutomationPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: /New task/ }))[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Waves"), { target: { value: "the rest, 10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/only the last can be/);
    expect(create).not.toHaveBeenCalled();
  });
});
