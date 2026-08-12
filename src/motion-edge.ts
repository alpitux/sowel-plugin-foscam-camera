/**
 * Motion alarm edge detection (spec 001) — getDevState exposes
 * motionDetectAlarm as a polled boolean snapshot, not a discrete event
 * feed like Netatmo's getevents. camera_detection must fire once per
 * rising edge (unset/false -> true), not on every poll while the alarm
 * stays active, and not on the falling edge.
 */
export function isMotionRisingEdge(previous: boolean | undefined, current: boolean): boolean {
  return current === true && previous !== true;
}
