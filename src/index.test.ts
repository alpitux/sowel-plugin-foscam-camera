import { describe, it, expect, vi, afterEach } from "vitest";
import { createPlugin } from "./index.js";

const SETTINGS_PREFIX = "integration.foscam_camera.";

function fullSettings(): Record<string, string> {
  return {
    [`${SETTINGS_PREFIX}ip`]: "192.0.2.1", // TEST-NET-1 (RFC 5737), not a real camera
    [`${SETTINGS_PREFIX}username`]: "test-user",
    [`${SETTINGS_PREFIX}password`]: "test-pass",
  };
}

function makeDeps(settings: Record<string, string>) {
  const upsertCalls: unknown[][] = [];
  const updateCalls: [string, string, Record<string, unknown>][] = [];
  const settingsManager = {
    get: (key: string) => settings[key],
    set: (key: string, value: string) => {
      settings[key] = value;
    },
  };
  const deviceManager = {
    upsertFromDiscovery: (...args: unknown[]) => upsertCalls.push(args),
    updateDeviceData: (...args: unknown[]) =>
      updateCalls.push(args as [string, string, Record<string, unknown>]),
    removeStaleDevices: () => {},
  };
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
      return logger;
    },
  };
  const eventBus = { emit: vi.fn() };
  return {
    deps: { logger, eventBus, settingsManager, deviceManager, pluginDir: "/tmp" },
    upsertCalls,
    updateCalls,
    eventBus,
  };
}

function devStateResponse(motionDetectAlarm: 0 | 1): Response {
  return {
    ok: true,
    status: 200,
    text: async () =>
      `<CGI_Result><result>0</result><motionDetectAlarm>${motionDetectAlarm}</motionDetectAlarm></CGI_Result>`,
  } as Response;
}

describe("FoscamCameraPlugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays not_configured when required settings are missing", async () => {
    const { deps } = makeDeps({});
    const plugin = createPlugin(deps);
    await plugin.start();
    expect(plugin.getStatus()).toBe("not_configured");
  });

  it("registers exactly the v1 data categories and no orders (spec 001: what NOT to emit)", async () => {
    const { deps, upsertCalls } = makeDeps(fullSettings());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => devStateResponse(0)),
    );

    const plugin = createPlugin(deps);
    await plugin.start();

    expect(upsertCalls).toHaveLength(1);
    const discovered = upsertCalls[0][2] as {
      data: { category: string; unit?: string }[];
      orders: unknown[];
    };
    // No siren/light-mode/monitoring order — FI9805E has no matching
    // hardware, and camera_monitoring has no tested/reliable toggle with
    // this account's privilege level (see spec 001 live test results).
    expect(discovered.orders).toEqual([]);
    expect(discovered.data.map((d) => d.category)).toEqual([
      "camera_snapshot_url",
      "camera_stream_url",
      "camera_detection",
    ]);
    // The signal spec 133 itself flagged for exactly this case (hls vs
    // mjpeg) — required for camera.ts and CameraPanel.tsx to route this
    // stream correctly.
    const streamData = discovered.data.find((d) => d.category === "camera_stream_url");
    expect(streamData?.unit).toBe("mjpeg");

    await plugin.stop();
  });

  it("updateDeviceData's sourceDeviceId matches the registered friendlyName (regression, live 2026-08-13)", async () => {
    // upsertFromDiscovery keys the device by `friendlyName` — a mismatch
    // with the sourceDeviceId used in updateDeviceData silently orphans
    // every poll update from the registered device (found live: data stayed
    // null forever despite polling successfully).
    const { deps, upsertCalls, updateCalls } = makeDeps(fullSettings());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => devStateResponse(0)),
    );

    const plugin = createPlugin(deps);
    await plugin.start();

    const friendlyName = (upsertCalls[0][2] as { friendlyName: string }).friendlyName;
    expect(updateCalls.length).toBeGreaterThan(0);
    for (const [, sourceDeviceId] of updateCalls) {
      expect(sourceDeviceId).toBe(friendlyName);
    }

    await plugin.stop();
  });

  it("emits camera_detection once on a motion rising edge, not on repeated polls", async () => {
    const { deps, updateCalls } = makeDeps(fullSettings());
    let alarm: 0 | 1 = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => devStateResponse(alarm)),
    );

    const plugin = createPlugin(deps);
    await plugin.start(); // poll #1: no alarm yet
    alarm = 1;
    await plugin.refresh!(); // poll #2: rising edge -> should emit
    await plugin.refresh!(); // poll #3: still active -> must NOT re-emit

    const detections = updateCalls.filter(([, , payload]) => "detection" in payload);
    expect(detections).toHaveLength(1);
    expect(detections[0][2].detection).toBe("motion");

    await plugin.stop();
  });

  it("surfaces poll failures via getStatus() without crashing", async () => {
    const { deps } = makeDeps(fullSettings());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 }) as Response),
    );

    const plugin = createPlugin(deps);
    await plugin.start();

    expect(plugin.getStatus()).toBe("error");

    await plugin.stop();
  });
});
