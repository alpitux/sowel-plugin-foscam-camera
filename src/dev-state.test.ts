import { describe, it, expect } from "vitest";
import { parseDevState } from "./dev-state.js";

describe("parseDevState", () => {
  it("parses a real getDevState response (2026-08-12 live test)", () => {
    const xml = `<CGI_Result>
    <result>0</result>
    <IOAlarm>0</IOAlarm>
    <motionDetectAlarm>0</motionDetectAlarm>
    <soundAlarm>0</soundAlarm>
    <record>0</record>
    <sdState>0</sdState>
    <sdFreeSpace>0k</sdFreeSpace>
    <sdTotalSpace>0k</sdTotalSpace>
    <ntpState>1</ntpState>
    <ddnsState>0</ddnsState>
    <url>http%3A%2F%2Ffo9266.myfoscam.org%3A88</url>
    <upnpState>0</upnpState>
    <isWifiConnected>0</isWifiConnected>
    <wifiConnectedAP></wifiConnectedAP>
    <infraLedState>1</infraLedState>
</CGI_Result>`;
    expect(parseDevState(xml)).toEqual({ result: 0, motionDetectAlarm: false });
  });

  it("treats motionDetectAlarm=1 as active", () => {
    const xml = "<CGI_Result><result>0</result><motionDetectAlarm>1</motionDetectAlarm></CGI_Result>";
    expect(parseDevState(xml).motionDetectAlarm).toBe(true);
  });

  it("treats motionDetectAlarm=2 (alarm + notification sent) as active", () => {
    const xml = "<CGI_Result><result>0</result><motionDetectAlarm>2</motionDetectAlarm></CGI_Result>";
    expect(parseDevState(xml).motionDetectAlarm).toBe(true);
  });

  it("surfaces a non-zero result code (e.g. access denied)", () => {
    const xml = "<CGI_Result><result>-3</result></CGI_Result>";
    expect(parseDevState(xml).result).toBe(-3);
  });

  it("defaults motionDetectAlarm to false when the field is missing", () => {
    const xml = "<CGI_Result><result>0</result></CGI_Result>";
    expect(parseDevState(xml).motionDetectAlarm).toBe(false);
  });
});
