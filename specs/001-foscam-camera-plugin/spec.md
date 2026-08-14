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
| Live stream (RTSP, native) | `rtsp://<usr>:<pwd>@<ip>:88/videoMain` (full res) or `/videoSub` (lower-res substream) | **Not HTTP, not HLS** — needs a Sowel-side transcode/relay, see "Feasibility risk" below. **Confirmed fully functional 2026-08-14**: Digest auth (not query-string), full `DESCRIBE`/`SETUP`/`PLAY` handshake verified with `ffmpeg`, real H.264 (640×480) + PCM μ-law audio, a decoded frame visually confirmed. Now the more promising path than MJPEG (confirmed broken) — see "Live API test results (2026-08-14)". |
| Live stream (MJPEG, HTTP fallback) | `GET http://<ip>:88/cgi-bin/CGIStream.cgi?cmd=GetMJStream&usr=...&pwd=...` (multipart MJPEG) | **Non-functional on Romain's unit (confirmed 2026-08-14)** — returns HTTP 200 with the right Content-Type, but the body is always a fixed "No MJ stream" error, never image data, even after applying the documented fix (`setSubStreamFormat&format=1`). Likely a hardware/firmware limitation of this specific unit. See "Live API test results (2026-08-14)". |
| Device/motion state | `GET .../CGIProxy.fcgi?cmd=getDevState&usr=...&pwd=...` | Returns `motionDetectAlarm`, `soundAlarm`, `record`, `sdState`, `sdFreeSpace`, `ntpState`, etc. Polling target for `camera_detection`, analogous to Netatmo's `homestatus` polling. |
| Motion detect config | `getMotionDetectConfig` / `setMotionDetectConfig` (`isEnable`, `snapInterval`, `sensitivity`, per-zone linkage) | Controls whether/how sensitively `motionDetectAlarm` fires. Whether this plugin exposes sensitivity as a setting or just enables detection with the camera's existing config is a spec decision, not yet made. |
| Alarm HTTP push (firmware-dependent) | `GET .../set_alarm.cgi?http=1&http_url=<callback>` (legacy command set, separate from `CGIProxy.fcgi`) | Community reports (Domoticz/HomeSeer forums) say **newer Foscam firmware generations dropped this**. Unconfirmed whether the FI9805E's actual firmware on Romain's unit still has it. If present, this would give near-real-time `camera_detection` updates via a LAN-only push instead of polling `getDevState` — **first thing to check live**, since it changes the plugin's core polling architecture. |
| IR / night vision | `setInfraLedConfig` (`mode`: auto/manual) | The FI9805E's 36 IR-LEDs + IR-cut filter are normally automatic. Whether manual override is exposed and whether it makes sense to map to spec 133's `camera_light_mode` is unclear — semantically this is *infrared* (invisible) illumination, not a visible spotlight like Netatmo's Presence floodlight. Flagging as a possible UI copy mismatch to resolve in the spec, not to silently reuse Presence's wording. |
| ONVIF (alternative path, not planned for v1) | ONVIF 2.2.1 confirmed on the official spec sheet | Foscam's own CGI API already covers snapshot/stream/motion/state; adding an ONVIF SOAP client would be extra dependency weight for no functional gain on this model. Noted as a fallback if the CGI API proves too fragile across firmware versions in practice. |
| Siren / visible spotlight | **Not applicable** | Fixed bullet camera, no built-in siren or visible floodlight, unlike Netatmo's Presence. `trigger_camera_siren` and a visible-light `camera_light_mode` simply aren't emitted for this device — same per-device polymorphism pattern as Netatmo's Welcome not emitting Presence-only keys. |

## Feasibility risk — read before approving this spec

> **Decision (2026-08-15, Romain): RTSP-to-HLS relay for v1, superseding
> MJPEG.** MJPEG is confirmed dead on Romain's actual hardware (see "Live
> API test results (2026-08-14)") — not a matter of implementation effort,
> a real firmware/hardware limitation. RTSP is confirmed fully functional.
> Rather than shipping v1 without a live view, Romain chose to invest in
> the RTSP-to-HLS path now: prototype a lightweight relay (`go2rtc` —
> remuxes RTSP into HLS without re-encoding when the codec allows it,
> which it does here: H.264 baseline) locally against `sowel`, validate it
> actually works end-to-end, **then** propose the underlying capability
> (Sowel supervising a sidecar process) to Marc. This is a bigger,
> cross-repo lift than the MJPEG path would have been — accepted
> knowingly, not a "cheap path" decision this time. See "RTSP-to-HLS relay
> prototype" below for the plan and progress.

> **Decision (2026-08-12, Romain, SUPERSEDED 2026-08-15 — see above): MJPEG fallback for v1.** Option 1 below
> is the chosen path. Rationale: it stays within a single plugin's scope
> (only a small, additive `spec 133` UI follow-up needed, not a new core
> infrastructure dependency), whereas option 2 (RTSP-to-HLS transcoding)
> would require Sowel to gain a capability it has never had (supervising a
> server-side child process/sidecar) for a quality gain that isn't
> confirmed on this specific unit — live testing hadn't yet measured
> either stream's real-world quality when the call was made. RTSP-to-HLS
> remains a possible future initiative if the need generalizes across
> camera plugins (e.g. a future Eufy plugin with the same constraint), but
> is out of scope for this plugin's v1. This unblocks moving past the spec
> stage, but the spec 133 UI follow-up PR to `mchacher/sowel` (see option
> 1 below) still needs to be proposed and merged before this plugin's live
> view can actually ship — see "Next steps" implications in
> `CONTEXT_ROMAIN.md`.

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

*(Superseded 2026-08-15 — see the decision note at the top of this
section and "RTSP-to-HLS relay prototype" below.)*

## RTSP-to-HLS relay prototype (2026-08-15) — validated end-to-end

Prototype executed on the dev VM the same day the plan was agreed. All
steps below confirmed working through curl-based testing (not yet tried
in an actual browser, but the HTTP-level chain a browser/hls.js would
walk is fully verified):

1. `go2rtc` run as a Docker sidecar on the dev VM's `sowel_default`
   network (so it's reachable from the `sowel` container by container
   name — `127.0.0.1` does **not** work between sibling containers, each
   has its own network namespace; this cost some early debugging time),
   pointed at the camera's confirmed-working RTSP URL. Its
   `/api/stream.m3u8?src=<name>` endpoint returns a genuine two-level HLS
   structure: a master playlist referencing a variant playlist, itself
   listing `.ts` segment URIs — remuxed from the camera's native H.264
   **without re-encoding** (confirmed: `CODECS="avc1.42001E"` in the
   master, matching the RTSP SDP's `profile-level-id=42001E` from the
   2026-08-14 test).
2. The plugin's `camera_stream_url` was pointed at `go2rtc`'s master
   playlist URL (throwaway local change, not committed — the real
   integration needs a proper sidecar-lifecycle design, not a hardcoded
   URL) — with **no** `unit: "mjpeg"` tag, so Sowel's stock HLS-rewrite
   path runs.
3. **Master playlist**: Sowel's *existing, unmodified*
   `src/api/routes/camera.ts` proxied and rewrote it correctly — confirms
   the "key simplification" hypothesis from the plan: no `unit: "mjpeg"`
   signal, no auth-middleware query-token exception, no
   `CameraPanel.tsx` `<img>` branch needed for this path. Those
   MJPEG-specific local patches are irrelevant to the RTSP-to-HLS
   approach and can be dropped.
4. **Variant/child playlist — found and fixed a real gap.** The route
   comment "a master playlist referencing variant playlists that
   themselves need rewriting is only rewritten one level deep" turned out
   to be exactly go2rtc's structure, and it broke exactly as documented:
   the child playlist's relative `segment.ts?id=...` URIs, unrewritten,
   would resolve in a browser against the *segment route's own URL*
   (`.../camera/stream/segment?u=...` → `.../camera/stream/segment.ts?...`),
   a route that doesn't exist → confirmed 404 by directly requesting that
   resolved URL. **Fix applied to `src/api/routes/camera.ts`** (local,
   not yet pushed, on `test/mjpeg-camera-live-view`): the
   `/camera/stream/segment` route now also passes `rewriteHls: true`,
   so a child playlist proxied through it gets the same `#EXTM3U`
   sniff-and-rewrite treatment recursively. Real `.ts`/binary segments
   never start with `#EXTM3U`, so this is a no-op for them — existing
   `camera.test.ts` suite still passes (12/12) after the change. This is
   a generically useful fix, not Foscam-specific — any HLS source with a
   two-level master/variant structure (fairly common) would have hit the
   same bug.
5. **Real segment fetch confirmed**: after the fix, a `.ts` segment
   fetched through the fully rewritten chain (master → child → segment,
   all via Sowel's authenticated proxy) returned HTTP 200,
   `Content-Type: video/mp2t`, ~12.7 KB of real binary MPEG-TS data.

**Remaining for a real implementation** (not done): a proper
sidecar-lifecycle design for `go2rtc` itself (Sowel starting/stopping/
health-checking the process, not a manually-started test container) —
this is the actual new capability that needs Marc's buy-in. The HLS
serving/proxying side is now proven to need only the small, generic
`camera.ts` recursive-rewrite fix above, not a Foscam-specific hack.

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

## Live API test results (2026-08-12)

Tested against Romain's real FI9805E unit — a test camera on `192.168.20.x`
(LAN-only, camera name withheld per anonymization rule), reached via the
Sowel dev VM on `192.168.10.x` (the machine running this session has no
direct route to the camera's subnet, so tests were run over SSH from the
dev VM). All requests used `CGIProxy.fcgi` query-string auth
(`usr=<user>&pwd=<pass>`) with a dedicated, non-admin plugin account.

- **Auth**: confirmed working — `getDevState`, `getDevInfo`,
  `snapPicture2`, and `getInfraLedConfig` all returned `result=0` / HTTP
  200 with the dedicated account.
- **Firmware confirmed**: `2.14.1.119` (hardware `1.4.1.10`). This
  generation does **not** have the legacy `set_alarm.cgi` HTTP push
  endpoint (`404 Not Found`) — resolves open question #3: `getDevState`
  polling is the only detection path available on this unit, no push
  option.
- **Snapshot** (`snapPicture2`): valid JPEG, **640×480**, ~27.6 KB, ~110ms
  response time — lower than the FI9805E's spec-sheet-quoted 720p sensor
  resolution. Partially resolves open question #5: default `snapPicture2`
  output is 640×480 on this unit; whether a resolution query param can
  raise this is still to check.
- **Live stream, RTSP**: confirmed live and speaking RTSP on **port 88**
  (not a separate port) — a raw `OPTIONS` request returns `RTSP/1.0 200
  OK` advertising `DESCRIBE, SETUP, TEARDOWN, PLAY, PAUSE, GET_PARAMETER,
  SET_PARAMETER`. Resolves open question #4 for the RTSP port. Note:
  `curl`'s built-in RTSP client failed ("Empty reply from server") against
  this camera — a known `curl` RTSP-client limitation, not a camera issue;
  a raw-socket `OPTIONS` request succeeded. Full `DESCRIBE`/`SETUP`/`PLAY`
  handshake not yet exercised — needs `ffprobe`/`ffmpeg` or an equivalent
  RTSP-capable client, not currently installed on the dev VM.
- **Live stream, MJPEG fallback**: the legacy endpoints from the original
  research (`videostream.asf`, `videostream.cgi`) both return **404** on
  this firmware. The `CGIProxy`-family endpoint
  **`CGIStream.cgi?cmd=GetMJStream`** returns **HTTP 200** — this is the
  real MJPEG fallback candidate on this firmware generation (table above
  corrected accordingly).
- **Motion detect config**: `getMotionDetectConfig1` returned `result=-3`
  (access denied) with the dedicated plugin account — this account does
  **not** have privilege to read/write motion detection config, unlike
  `getDevState`/`snapPicture2`/`getInfraLedConfig` which all succeed.
  Partially resolves open question #2: the restricted account is
  sufficient for state/snapshot/IR reads but not for motion config —
  still open whether polling `getDevState`'s `motionDetectAlarm` field
  (which doesn't require this privilege) is enough for `camera_detection`,
  or whether admin credentials are needed for full motion feature support.
- **IR/night vision** (`getInfraLedConfig`): works with the dedicated
  account, returned `mode=0` (auto).

**Still open / not yet tested**: full RTSP `DESCRIBE`/`SETUP`/`PLAY`
handshake, actual MJPEG framerate/quality via `CGIStream.cgi`, and the
RTSP feed's actual resolution compared to the 640×480 snapshot.

## Live API test results (2026-08-14) — MJPEG failure & RTSP confirmation

Follow-up testing after the plugin (v1.0.1) and a local, not-yet-pushed
core `sowel` patch (MJPEG support in the media-proxy/`CameraPanel.tsx`)
were deployed to the dev VM and exercised end-to-end through Sowel's real
media-proxy routes, not just direct camera CGI calls as in the 2026-08-12
section above.

- **Snapshot end-to-end**: confirmed working through
  `GET /api/v1/equipments/:id/camera/snapshot` — valid JPEG, 640×480, HTTP
  200. No issues.
- **MJPEG stream — corrects the 2026-08-12 finding.** That earlier test
  only checked HTTP status (200) and `Content-Type`
  (`multipart/x-mixed-replace`) for `CGIStream.cgi?cmd=GetMJStream`, never
  the actual response body. Testing the real stream end-to-end (through
  Sowel's media-proxy, and independently via a raw-socket byte inspection
  directly against the camera) shows the body is **always** a fixed
  128-byte message, not image data:
  ```
  --ThisString
  Content-type:text/plain;

  No MJ stream
  ```
  This is stable and reproducible across repeated attempts.
  - The documented fix (Foscam CGI guide: set the sub-stream format to
    MJPEG via `CGIProxy.fcgi?cmd=setSubStreamFormat&format=1`, officially
    requiring admin privilege) was tried — the dedicated plugin account
    unexpectedly succeeded (`result=0`), including forcing an explicit
    0→1 transition with waits up to 8s between attempts. **No observable
    effect** on `GetMJStream` — still "No MJ stream" every time.
  - A reboot attempt (`cmd=reboot`, sometimes needed for a codec/encoder
    setting to take effect) was blocked: `reboot` requires admin
    privilege, the dedicated plugin account gets `result=-3` (access
    denied). Romain confirmed (2026-08-14) no admin credentials are
    available for this camera beyond the dedicated plugin account.
  - Most likely explanation: a genuine hardware/firmware limitation of
    this specific FI9805E unit. Foscam's CGI guide is shared across many
    camera SKUs/generations — not every documented command is necessarily
    backed by real hardware capability on every model.
- **RTSP — fully confirmed working**. Romain pointed out that his Synology
  NAS's Surveillance Station successfully streams this same camera — that
  lead (very likely RTSP, the standard protocol for this class of NVR/VMS
  software) is what prompted re-testing RTSP properly instead of treating
  it as a dead end. Full protocol validation, not just the `OPTIONS` probe from
  2026-08-12:
  - RTSP `DESCRIBE` requires **Digest** authentication (realm `"Foscam
    IPCam Living Video"`), distinct from the CGI endpoints' query-string
    `usr`/`pwd` auth. A hand-computed digest response (MD5, no `qop`)
    succeeded on the first authenticated attempt, returning a valid SDP:
    H.264 video track (`Baseline` profile, 640×480) + a PCM μ-law audio
    track, served by an embedded `LIVE555` server.
  - Full `ffmpeg`-based handshake (`DESCRIBE`/`SETUP`/`PLAY` over TCP
    transport, run via an ephemeral Docker container on the dev VM — no
    system package installs) succeeded end-to-end: real H.264 stream,
    `640x480, 3.33 tbr` (a low but real framerate — a genuine
    characteristic of this camera's encoder config, not a test artifact),
    plus the audio track. One frame was decoded and saved as JPEG, then
    visually verified: a clear, correctly-exposed IR night-vision image
    with the camera's own on-screen timestamp overlay — unambiguous proof
    of a working, real live feed. (The captured frame itself was deleted
    after verification — it had the camera's device name burned into the
    OSD overlay, treated as sensitive per the anonymization rule.)
  - **Separate, secondary finding**: Node's native `fetch` (the same
    client Sowel's `src/api/routes/camera.ts` uses for HTTP media
    proxying) rejected this camera's plain-HTTP MJPEG response with
    `TypeError: fetch failed... Invalid header value char` even when
    testing on a firmware/config state where data was expected — `curl`
    and a raw socket accepted the identical response without issue. Not
    yet root-caused. Moot for now given MJPEG doesn't produce real data
    regardless, but would matter again if MJPEG is ever revisited (e.g. on
    a different Foscam unit where it actually works), and is unrelated to
    the RTSP path (RTSP wouldn't go through Sowel's `fetch`-based
    media-proxy in its current form at all — it has no RTSP client, see
    "Feasibility risk").

**Net effect on the Feasibility risk decision**: the MJPEG path is
confirmed non-functional on Romain's actual hardware, independent of
implementation effort — no plugin-side or Sowel-core code change can fix
a camera-side firmware limitation. RTSP is confirmed fully functional.
This reopens the MJPEG-vs-RTSP→HLS choice — see the decision note at the
top of "Feasibility risk" above. Decision **pending** as of 2026-08-14.

## Acceptance Criteria

> **⚠️ Written under the 2026-08-12 MJPEG decision, now reopened (see
> "Feasibility risk" and "Live API test results (2026-08-14)" above).**
> Criterion #2 below assumes the MJPEG path and needs to be rewritten once
> Romain decides how to proceed — left as-is here for the historical
> record, not to be treated as current until that decision is made.

Finalized 2026-08-12 following the MJPEG-for-v1 decision (see "Feasibility
risk"):

1. `camera_snapshot_url` fetchable end-to-end through Sowel's media-proxy
   (`GET /api/v1/equipments/:id/camera/snapshot`), backed by `snapPicture2`.
2. `camera_stream_url` live view works through the MJPEG path
   (`CGIStream.cgi?cmd=GetMJStream`) — **contingent on the spec 133 UI
   follow-up PR to `mchacher/sowel` being proposed, reviewed, and merged
   first**, since `CameraPanel.tsx` cannot currently render MJPEG. This
   plugin cannot ship a working live view before that PR lands upstream.
3. `camera_detection` surfaced via `getDevState` polling of
   `motionDetectAlarm`, with edge/level de-duplication (no repeat emission
   while the flag stays `true` across polls) — confirmed feasible with the
   dedicated plugin account's privilege level (no `getMotionDetectConfig1`
   access needed for this).
4. `camera_light_mode`/`trigger_camera_siren`: **not emitted** for this
   device — no visible light or siren hardware exists (see "Non-Goals").
   Whether `setInfraLedConfig` is worth mapping to `camera_light_mode`
   despite the infrared/visible-light semantic mismatch remains an open
   design call, not a blocker for v1 (`camera_light_mode` binding is
   optional per spec 133's binding-gated principle).
5. Registry entry with `sha256` + `owner: "alpitux"` present once a
   GitHub release exists, computed via
   `scripts/backfill-registry-sha256.mjs` in the `sowel` repo.

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

1. **MJPEG vs RTSP-to-HLS** — ~~resolved 2026-08-12 (MJPEG)~~ ~~reopened
   2026-08-14~~ **resolved 2026-08-15: RTSP-to-HLS via a `go2rtc` relay**,
   MJPEG ruled out for good (confirmed non-functional on Romain's actual
   hardware). Still blocks the live-view feature specifically until the
   prototype in "RTSP-to-HLS relay prototype" above is validated and the
   sidecar-process capability is proposed to Marc — `camera_snapshot_url`
   and `camera_detection` are unaffected and can ship independently.
2. ~~Exact CGI auth requirement per command~~ — **partially resolved**:
   the dedicated non-admin account is sufficient for `getDevState`,
   `snapPicture2`, `getInfraLedConfig`, but **not** for
   `getMotionDetectConfig1` (access denied). Whether admin is needed for
   full motion feature support is still open — see "Live API test
   results".
3. ~~Whether `set_alarm.cgi` HTTP push is present~~ — **resolved**: no,
   404 on this firmware (`2.14.1.119`). `getDevState` polling is the only
   detection path.
4. ~~Actual HTTP/RTSP ports~~ — **resolved**: both HTTP CGI and RTSP are
   on port 88 (no separate RTSP port on this unit).
5. Snapshot resolution/quality vs the RTSP feed's resolution — **partially
   resolved**: `snapPicture2` defaults to 640×480 on this unit (below the
   sensor's spec-sheet 720p). Whether a resolution query param raises
   this, and how it compares to the RTSP feed's actual resolution, is
   still open (RTSP handshake not yet tested).
6. Whether `setInfraLedConfig` exists and is meaningful to expose as
   `camera_light_mode`, given the semantic mismatch flagged above
   (infrared vs visible light). **Still open** — only `getInfraLedConfig`
   was read-tested so far (`mode=0`/auto), `setInfraLedConfig` not yet
   exercised.
