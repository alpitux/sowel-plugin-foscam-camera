# Spec 001 — sowel-plugin-foscam-camera

## Context

Romain owns a Foscam **FI9805E** (outdoor, PoE, fixed-lens bullet camera,
1.3MP/720p, 36 IR-LEDs for night vision up to 30m, IP66, ONVIF 2.2.1) — one
of the three camera brands he wants surfaced in Sowel (alongside Netatmo,
already shipped as `sowel-plugin-netatmo-camera`, and Eufy, not yet
started). This plugin binds it into the `camera` equipment type introduced
by `mchacher/sowel` spec 133, **now merged**
([mchacher/sowel#339](https://github.com/mchacher/sowel/pull/339), ships in
Sowel v1.31.0) — unlike the Netatmo plugin, which was built against an
unmerged branch, this one can rely on the equipment type being stable
upstream from day one.

Architecturally this is a **very different plugin from Netatmo**: the
FI9805E has **no cloud API at all**. Everything is direct HTTP(S)/RTSP to
the camera's own LAN IP, using Foscam's proprietary CGI command set
(`CGIProxy.fcgi?cmd=...`). No OAuth, no refresh tokens, no per-app rate
limits, no webhook-reachability problem (a push callback, if supported by
this unit's firmware, would itself be LAN-only — camera POSTs to the Sowel
dev VM, not the other way around, no public exposure needed either way).

## API research (plugin-integration skill Phase 1.3 — done ahead of live testing)

Romain hasn't been asked yet for this camera's LAN IP/credentials, so
nothing below has been verified against his real unit. Sourced from
Foscam's official CGI User Guide (mirrored by
[iltucci.com](https://www.iltucci.com/blog/wp-content/uploads/2018/12/Foscam-IPCamera-CGI-User-Guide-V1.0.4.pdf)
and [ManualsLib](https://www.manualslib.com/manual/1466496/Foscam-Cgi.html)),
Foscam's own product/FAQ pages, and community integrations (openHAB,
Domoticz, ispyconnect/Agent DVR's camera URL database) — not guessed, but
**every row below is a first live-test target, not an assumption to code
against blindly**, same discipline as the Netatmo spec.

| Concern | Endpoint | Notes |
|---|---|---|
| Auth | Query-string: `usr=<user>&pwd=<pass>` (newer `CGIProxy.fcgi` commands) or `user=<user>&pwd=<pass>` (legacy `.cgi` commands) | No OAuth, no cloud. Credentials travel in the URL over plain HTTP by default — a real handling concern (see "Non-Goals" and the security note below), unlike Netatmo's bearer-token OAuth flow. |
| Snapshot | `GET http://<ip>:<port>/cgi-bin/CGIProxy.fcgi?cmd=snapPicture2&usr=...&pwd=...` | Returns a JPEG (reported up to 1920×1080 in some sources, but the FI9805E's sensor tops out at 1280×720 per its spec sheet — resolution to confirm live). Feeds `camera_snapshot_url` directly; a plain HTTP JPEG GET, no local/remote URL resolution dance needed (unlike Netatmo's `vpn_url`/`local_url`/ping flow). |
| Live stream (RTSP, native) | `rtsp://<usr>:<pwd>@<ip>:88/videoMain` (full res) or `/videoSub` (lower-res substream) | **Not HTTP, not HLS.** See "Feasibility risk" below — this is the central open question for this plugin. |
| Live stream (MJPEG, HTTP fallback) | `GET http://<ip>/videostream.asf?user=...&pwd=...&resolution=WxH` (multipart MJPEG) | Directly HTTP-fetchable, no RTSP client needed. Candidate v1 fallback for `camera_stream_url` — see "Feasibility risk". |
| Device/motion state | `GET .../CGIProxy.fcgi?cmd=getDevState&usr=...&pwd=...` | Returns `motionDetectAlarm`, `soundAlarm`, `record`, `sdState`, `sdFreeSpace`, `ntpState`, etc. Polling target for `camera_detection`, analogous to Netatmo's `homestatus` polling. |
| Motion detect config | `getMotionDetectConfig` / `setMotionDetectConfig` (`isEnable`, `snapInterval`, `sensitivity`, per-zone linkage) | Controls whether/how sensitively `motionDetectAlarm` fires. Whether this plugin exposes sensitivity as a setting or just enables detection with the camera's existing config is a spec decision, not yet made. |
| Alarm HTTP push (firmware-dependent) | `GET .../set_alarm.cgi?http=1&http_url=<callback>` (legacy command set, separate from `CGIProxy.fcgi`) | Community reports (Domoticz/HomeSeer forums) say **newer Foscam firmware generations dropped this**. Unconfirmed whether the FI9805E's actual firmware on Romain's unit still has it. If present, this would give near-real-time `camera_detection` updates via a LAN-only push instead of polling `getDevState` — **first thing to check live**, since it changes the plugin's core polling architecture. |
| IR / night vision | `setInfraLedConfig` (`mode`: auto/manual) | The FI9805E's 36 IR-LEDs + IR-cut filter are normally automatic. Whether manual override is exposed and whether it makes sense to map to spec 133's `camera_light_mode` is unclear — semantically this is *infrared* (invisible) illumination, not a visible spotlight like Netatmo's Presence floodlight. Flagging as a possible UI copy mismatch to resolve in the spec, not to silently reuse Presence's wording. |
| ONVIF (alternative path, not planned for v1) | ONVIF 2.2.1 confirmed on the official spec sheet | Foscam's own CGI API already covers snapshot/stream/motion/state; adding an ONVIF SOAP client would be extra dependency weight for no functional gain on this model. Noted as a fallback if the CGI API proves too fragile across firmware versions in practice. |
| Siren / visible spotlight | **Not applicable** | Fixed bullet camera, no built-in siren or visible floodlight, unlike Netatmo's Presence. `trigger_camera_siren` and a visible-light `camera_light_mode` simply aren't emitted for this device — same per-device polymorphism pattern as Netatmo's Welcome not emitting Presence-only keys. |

## Feasibility risk — read before approving this spec

The FI9805E's native live video is **RTSP** (H.264 over RTSP, port 88 by
default). It does **not** serve HLS the way Netatmo's cameras do. Spec
133's media-proxy (`src/api/routes/camera.ts`, `GET
/api/v1/equipments/:id/camera/stream`) currently only knows how to fetch
and rewrite an **HLS manifest** (`#EXTM3U` body-sniff + segment URI
rewriting through `/camera/stream/segment`) — it has no RTSP client and no
transcoding step. This is a real, unresolved architectural gap, not a
detail to sort out during implementation:

1. **MJPEG fallback for v1** — Foscam also serves a plain HTTP
   multipart-MJPEG stream (`videostream.asf`/`.cgi`), directly fetchable
   with no RTSP client or transcoding. Cheapest path by far, but (a)
   visual quality/framerate is generally lower than the RTSP H.264 feed,
   and (b) it's unconfirmed whether spec 133's `CameraPanel.tsx` (built
   around `hls.js` + a `<video>` element) can display an MJPEG stream at
   all without changes. Realistically this needs a small, additive
   `<img>`-based "live-refreshing snapshot" fallback mode in the UI —
   which would be a **spec 133 follow-up PR to `mchacher/sowel`**, not
   something this plugin can do unilaterally by itself.
2. **RTSP-to-HLS transcoding** — run `ffmpeg` (or a lightweight relay like
   `go2rtc`/`MediaMTX`) server-side to re-mux the RTSP stream into HLS
   segments Sowel's existing media-proxy already knows how to serve.
   Better quality/compatibility, but introduces a real process/resource
   dependency that no Sowel plugin currently has (no plugin today spawns
   or supervises a child process/sidecar). Almost certainly too large a
   change to fit inside a single plugin repo — would need a core Sowel
   discussion first, not an improvised workaround here.

**This spec should not move to implementation until this is resolved** —
either Romain accepts an MJPEG-only v1 pending a small spec 133 UI
follow-up, or the RTSP path gets scoped separately as its own initiative
(likely too big for "just a plugin"). `camera_snapshot_url` has no such
blocker — it's a plain JPEG GET, same shape as Netatmo's.

## Non-Goals

- PTZ — the FI9805E is a fixed-lens bullet camera, no pan/tilt/zoom
  hardware exists to control.
- ONVIF client — the vendor CGI API already covers what spec 133 needs;
  see table above.
- Cloud/OAuth anything — this device has no cloud API surface. Fully LAN,
  direct HTTP(S)/RTSP to the camera's own IP, unlike Netatmo.
- True HLS sourced from the camera — it doesn't exist on this hardware.
  See "Feasibility risk" above.
- Modifying spec 133's core contract unilaterally from this repo — if
  MJPEG support needs a UI change, that is a proposal back to
  `mchacher/sowel`, reviewed and merged there, not a private workaround
  shipped only inside this plugin.
- Eufy support — separate plugin, separate repo, not started yet.

## Manual prerequisite (blocks Phase 1.3 live testing)

Needed from Romain before any live API testing can start:

1. The FI9805E's LAN IP, HTTP port (default 88 per community sources, but
   confirm against the camera's own web UI — it's configurable), and RTSP
   port (may differ from the HTTP port).
2. Camera-local credentials for the plugin. Foscam cameras of this
   generation typically support a restricted "visitor" account in
   addition to admin — to confirm whether a visitor account is sufficient
   for `snapPicture2` / `getDevState`, or whether admin is required (more
   privilege than the plugin should ideally need, similar in spirit to
   scoping Netatmo's dev-app permissions narrowly).
3. Firmware version (visible in the camera's web UI) — determines whether
   the legacy `set_alarm.cgi` HTTP push command set is still present
   (community reports say it was dropped on newer firmware generations).

## Acceptance Criteria

*Deliberately left unfinalized until the "Feasibility risk" above is
resolved with Romain — committing to concrete criteria before that
decision would risk locking in a scope built on an untested assumption
about live view.* Once resolved, this section should cover (at minimum,
mirroring the Netatmo spec's structure): snapshot fetchable end-to-end
through Sowel's media-proxy, live view working through whichever path is
chosen, motion detection surfaced as `camera_detection` without duplicate
events, and the registry entry with `sha256` + `owner` once a release
exists.

## Test plan

Same split as the Netatmo plugin:

- **Unit-testable (vitest, this repo)**: `getDevState` response parsing,
  motion-alarm edge/level detection (avoiding duplicate `camera_detection`
  emissions if `motionDetectAlarm` stays `true` across multiple polls —
  same class of problem as Netatmo's event de-duplication, but polling a
  boolean state rather than diffing an event list), device capability
  mapping (this model has no siren/PTZ/visible-light, so most of the
  mapping is "what NOT to emit").
- **Live-only**: everything touching the actual camera — CGI auth,
  snapshot fetch, whichever live-view path gets chosen, motion state
  polling (or push, if the firmware supports it), IR config if mapped.
  Verified directly against Romain's unit on the dev VM, documented in
  this spec's follow-up once testing happens (same convention as
  `sowel-plugin-netatmo-camera/specs/001-netatmo-camera-plugin/spec.md`'s
  "Live API test results" section).

## Open questions (to resolve during Phase 1.3 live testing, not blocking spec approval — except #1)

1. **MJPEG vs RTSP-to-HLS** (see "Feasibility risk") — this one *does*
   block moving past the spec stage; the rest below don't.
2. Exact CGI auth requirement per command — visitor account sufficient, or
   admin required?
3. Whether `set_alarm.cgi` HTTP push is present on this unit's firmware,
   or `getDevState` polling is the only detection path available.
4. Actual HTTP/RTSP ports on Romain's unit — don't assume 88 for both,
   confirm against the camera's own config.
5. Snapshot resolution/quality vs the RTSP feed's resolution — whether
   `snapPicture2` visibly degrades compared to what the live view (once
   decided) will show.
6. Whether `setInfraLedConfig` exists and is meaningful to expose as
   `camera_light_mode`, given the semantic mismatch flagged above
   (infrared vs visible light).
