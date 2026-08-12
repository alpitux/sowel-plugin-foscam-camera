/**
 * getDevState XML response parsing (spec 001) — Foscam's CGIProxy.fcgi
 * returns plain XML, not JSON. No XML library dependency (mirrors
 * sowel-plugin-netatmo-camera's zero-dep style): the handful of fields we
 * need are extracted with targeted regexes rather than a full parser.
 */

export interface DevState {
  /** CGI result code: 0 = success, negative = error (e.g. -2 = bad
   * credentials, -3 = access denied for this account's privilege level —
   * confirmed live 2026-08-12 for getMotionDetectConfig1 with the
   * dedicated plugin account, though getDevState itself succeeds). */
  result: number;
  /** true for any non-zero motionDetectAlarm value — community docs
   * describe 1 ("detected") and 2 ("detected + notification sent") as
   * both meaning "alarm active", only 0 means clear. */
  motionDetectAlarm: boolean;
}

export function parseDevState(xml: string): DevState {
  const resultMatch = xml.match(/<result>(-?\d+)<\/result>/);
  const alarmMatch = xml.match(/<motionDetectAlarm>(\d+)<\/motionDetectAlarm>/);
  return {
    result: resultMatch ? parseInt(resultMatch[1], 10) : -1,
    motionDetectAlarm: alarmMatch ? alarmMatch[1] !== "0" : false,
  };
}
