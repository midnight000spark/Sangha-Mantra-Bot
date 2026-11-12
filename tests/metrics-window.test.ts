import { expect, test } from "bun:test";
import { deploymentWindow } from "../scripts/metrics-window";

test("CPU comparison selects latest 100% version and excludes the deployment's partial second", () => {
  const old={id:"old",created_on:"2026-11-12T00:00:00Z",versions:[{version_id:"old-version",percentage:100}]};
  const current={id:"new",created_on:"2026-11-12T00:10:01.123456Z",versions:[{version_id:"new-version",percentage:100}]};
  const now=new Date("2026-11-12T00:15:00Z");
  expect(deploymentWindow([current,old],"new-version",now)).toEqual({deploymentId:"new",versionId:"new-version",from:"2026-11-12T00:10:02.000Z",to:now.toISOString()});
  expect(()=>deploymentWindow([old,current],"old-version",now)).toThrow();
  expect(()=>deploymentWindow([{...current,versions:[{version_id:"new-version",percentage:90},{version_id:"old-version",percentage:10}]}],"new-version",now)).toThrow();
  expect(()=>deploymentWindow([{...current,created_on:"invalid"}],"new-version",now)).toThrow();
  expect(()=>deploymentWindow([current],"new-version",new Date("2026-11-12T00:10:01.900Z"))).toThrow();
  expect(()=>deploymentWindow([],"new-version",now)).toThrow();
});
