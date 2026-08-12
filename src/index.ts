/**
 * Sowel Plugin: Foscam Camera
 *
 * Binds a single Foscam CGI-API camera (FI9805E) into Sowel's `camera`
 * equipment type (spec 133). No cloud API — direct LAN HTTP CGI calls
 * (CGIProxy.fcgi query-string auth), unlike Netatmo's OAuth cloud bridge.
 *
 * v1 live view is MJPEG (CGIStream.cgi?cmd=GetMJStream), not RTSP — see
 * specs/001-foscam-camera-plugin/spec.md "Feasibility risk" for why RTSP
 * is out of scope for now.
 *
 * v1 has no orders: camera_monitoring/camera_light_mode/trigger_camera_siren
 * are all intentionally not emitted — see spec 001 Acceptance Criteria.
 */

import { parseDevState } from "./dev-state.js";
import { isMotionRisingEdge } from "./motion-edge.js";

// ============================================================
// Local type definitions (mirrors src/shared/plugin-api.ts + related,
// same pattern as sowel-plugin-netatmo-camera)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

interface EventBus {
  emit(event: unknown): void;
}

interface SettingsManager {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

interface DiscoveredDevice {
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data: { key: string; type: string; category: string; unit?: string; enumValues?: string[] }[];
  orders: {
    key: string;
    type: string;
    category?: string;
    dispatchConfig?: Record<string, unknown>;
    min?: number;
    max?: number;
    enumValues?: string[];
    unit?: string;
  }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
    sourceTimestamp?: number,
  ): void;
  removeStaleDevices(integrationId: string, activeIds: Set<string>): void;
}

interface Device {
  id: string;
  integrationId: string;
  sourceDeviceId: string;
  name: string;
}

interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
}

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(device: Device, orderKey: string, value: unknown): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ============================================================
// Constants
// ============================================================

const INTEGRATION_ID = "foscam_camera";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;
// v1 is a single-camera plugin (no cloud discovery, unlike Netatmo) — one
// fixed friendlyName is enough. deviceManager.upsertFromDiscovery keys the
// device by `friendlyName` (becomes its sourceDeviceId), so this constant
// must be the single source of truth for both registerDevice() and every
// updateDeviceData() call — a mismatch here silently orphans poll updates
// from the registered device (confirmed live 2026-08-13: a bug here left
// snapshot_url/stream_url/detection stuck at null despite polling fine).
const DEVICE_NAME = "Foscam Camera";
const DEFAULT_PORT = 88;
const DEFAULT_POLL_INTERVAL_S = 15;
const MIN_POLL_INTERVAL_S = 5;
const REQUEST_TIMEOUT_MS = 8_000;

// ============================================================
// Plugin implementation
// ============================================================

class FoscamCameraPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Foscam Camera";
  readonly description = "Foscam CGI-API cameras — snapshot, MJPEG live view, motion detection";
  readonly icon = "Camera";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private status: IntegrationStatus = "disconnected";

  private baseUrl = "";
  private username = "";
  private password = "";
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_S * 1000;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastPollAt: string | null = null;
  private polling = false;
  private pollFailed = false;
  private lastMotionAlarm: boolean | undefined;

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.pollFailed) return "error";
    return this.status;
  }

  isConfigured(): boolean {
    return (
      this.getSetting("ip") !== undefined &&
      this.getSetting("username") !== undefined &&
      this.getSetting("password") !== undefined
    );
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      { key: "ip", label: "Camera IP", type: "text", required: true, placeholder: "192.168.1.x" },
      {
        key: "port",
        label: "HTTP port",
        type: "number",
        required: false,
        defaultValue: String(DEFAULT_PORT),
      },
      { key: "username", label: "Username", type: "text", required: true },
      { key: "password", label: "Password", type: "password", required: true },
      {
        key: "polling_interval",
        label: "Polling interval (seconds)",
        type: "number",
        required: false,
        defaultValue: String(DEFAULT_POLL_INTERVAL_S),
        placeholder: `Min ${MIN_POLL_INTERVAL_S}, default ${DEFAULT_POLL_INTERVAL_S}`,
      },
    ];
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    this.stopPolling();

    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }

    const ip = this.getSetting("ip")!;
    const port = parseInt(this.getSetting("port") ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT;
    this.username = this.getSetting("username")!;
    this.password = this.getSetting("password")!;
    this.baseUrl = `http://${ip}:${port}`;

    const pollingIntervalSec = parseInt(this.getSetting("polling_interval") ?? String(DEFAULT_POLL_INTERVAL_S), 10);
    this.pollIntervalMs =
      (isNaN(pollingIntervalSec) ? DEFAULT_POLL_INTERVAL_S : Math.max(pollingIntervalSec, MIN_POLL_INTERVAL_S)) *
      1000;
    this.lastMotionAlarm = undefined;

    this.registerDevice();
    await this.poll();

    const offset = options?.pollOffset ?? 0;
    const startInterval = () => {
      this.pollInterval = setInterval(() => this.safePoll(), this.pollIntervalMs);
    };
    if (offset > 0) {
      setTimeout(startInterval, offset);
    } else {
      startInterval();
    }

    this.status = "connected";
    this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
    this.logger.info({ pollIntervalMs: this.pollIntervalMs }, "Foscam Camera started");
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.status = "disconnected";
    this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    this.logger.info("Foscam Camera stopped");
  }

  async executeOrder(_device: Device, orderKey: string): Promise<void> {
    // v1 emits no orders (camera_monitoring/camera_light_mode/
    // trigger_camera_siren) — see spec 001 Acceptance Criteria.
    throw new Error(`Unknown order: ${orderKey}`);
  }

  async refresh(): Promise<void> {
    if (this.status !== "connected") throw new Error("Not connected");
    await this.poll();
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.lastPollAt) return null;
    return { lastPollAt: this.lastPollAt, intervalMs: this.pollIntervalMs };
  }

  // ============================================================
  // Device registration
  // ============================================================

  private registerDevice(): void {
    // unit: "mjpeg" is the signal spec 133 itself flagged for exactly this
    // case ("Open questions" — hls vs mjpeg once a plugin needs it): it's
    // what tells Sowel's media-proxy and CameraPanel.tsx to skip the
    // HLS-manifest path for this stream.
    const discovered: DiscoveredDevice = {
      friendlyName: DEVICE_NAME,
      manufacturer: "Foscam",
      model: "FI9805E",
      data: [
        { key: "snapshot_url", type: "text", category: "camera_snapshot_url" },
        { key: "stream_url", type: "text", category: "camera_stream_url", unit: "mjpeg" },
        { key: "detection", type: "text", category: "camera_detection" },
      ],
      orders: [],
    };
    this.deviceManager.upsertFromDiscovery(INTEGRATION_ID, INTEGRATION_ID, discovered);
  }

  // ============================================================
  // Polling
  // ============================================================

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      this.lastPollAt = new Date().toISOString();
      const state = await this.getDevState();

      const payload: Record<string, unknown> = {
        snapshot_url: this.snapshotUrl(),
        stream_url: this.streamUrl(),
      };
      if (isMotionRisingEdge(this.lastMotionAlarm, state.motionDetectAlarm)) {
        payload.detection = "motion";
      }
      this.lastMotionAlarm = state.motionDetectAlarm;

      this.deviceManager.updateDeviceData(INTEGRATION_ID, DEVICE_NAME, payload);

      if (this.pollFailed) {
        this.pollFailed = false;
        this.eventBus.emit({
          type: "system.alarm.resolved",
          alarmId: `poll-fail:${INTEGRATION_ID}`,
          source: "Foscam Camera",
          message: "Communication rétablie",
        });
      }
    } catch (err) {
      this.logger.error({ err } as Record<string, unknown>, "Camera poll cycle failed");
      if (!this.pollFailed) {
        this.pollFailed = true;
        this.eventBus.emit({
          type: "system.alarm.raised",
          alarmId: `poll-fail:${INTEGRATION_ID}`,
          level: "error",
          source: "Foscam Camera",
          message: `Poll en échec : ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private safePoll(): void {
    this.poll().catch((err) => this.logger.error({ err } as Record<string, unknown>, "Poll failed"));
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ============================================================
  // Foscam CGI bridge
  // ============================================================

  private cgiUrl(path: string, cmd: string): string {
    return `${this.baseUrl}${path}?cmd=${cmd}&usr=${encodeURIComponent(this.username)}&pwd=${encodeURIComponent(this.password)}`;
  }

  /** Confirmed live (2026-08-12): default snapPicture2 output on this unit
   * is 640×480, not the sensor's spec-sheet 720p. */
  private snapshotUrl(): string {
    return this.cgiUrl("/cgi-bin/CGIProxy.fcgi", "snapPicture2");
  }

  /** Confirmed live (2026-08-12): the community-documented
   * videostream.asf/.cgi endpoints 404 on this firmware
   * (2.14.1.119) — CGIStream.cgi is what actually serves MJPEG. */
  private streamUrl(): string {
    return this.cgiUrl("/cgi-bin/CGIStream.cgi", "GetMJStream");
  }

  private async getDevState(): Promise<{ motionDetectAlarm: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.cgiUrl("/cgi-bin/CGIProxy.fcgi", "getDevState"), {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`getDevState failed (${res.status})`);
      const text = await res.text();
      const parsed = parseDevState(text);
      if (parsed.result !== 0) throw new Error(`getDevState CGI error (result=${parsed.result})`);
      return { motionDetectAlarm: parsed.motionDetectAlarm };
    } finally {
      clearTimeout(timeout);
    }
  }

  private getSetting(key: string): string | undefined {
    return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`);
  }
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new FoscamCameraPlugin(deps);
}
