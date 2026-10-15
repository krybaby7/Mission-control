// T-MODES-COMPAT: a mission with no feature checked by a second AI renders exactly as it did before work modes (docs/modes-spec.md,
// section 15 item 6 and section 11: "byte for byte as today").
//
// The table holds the SHA-256 of JSON.stringify(snapshot) for every fixture that existed at the end of wave 1 (commit b060d30), made by
// the code of that commit: fixtureSnapshot(name) of test/dashboard-kit.ts, looked at on the fixture's own clock, in UTC. Nothing in
// this step may change one of them. The three modes-* fixtures are new and not listed. When a later change of the dashboard's words
// changes one of these on purpose, rebuild the table from the new output and say why in the commit.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureNames, fixtureSnapshot } from "./dashboard-kit.js";

const WAVE_1: Record<string, string> = {
  "all-event-types": "c0837ba6c57d89d9a59347f3e2dffc775d42b89b37205116a45c796200ba6515",
  "baseline-broken": "03e31e2eb8e4a43a17178818135be3c6a6e4c4061a067a1018e162c11350ad23",
  "checkpoint-answered": "72bea4758bd251d8efe66973812e8f5d8fafc2dc4335ef05948a6f5eeec8f335",
  "checkpoint-feature": "51efc48de23bb93874639e5462614dfe9c0866c96de96056ea038bef27776cdd",
  "checkpoint-final": "edeb8673b46370c16ecaab40e4c20d3f00ae03efc2695f309da9247b1def220e",
  "checkpoint-plan": "e54abfb4c9abddab771e88a931eec3d477171d4ad5c93db1ac754afee6cd703d",
  "dispatch-with-secret": "5355ee36f14576ea624fdda8f66dafb234cd31872881a358db2319eb2cedc96a",
  "done": "de4e0b1dbcc4cbe5b726dbcc6175518b44b124b464664ce64d3ba6634419afd0",
  "duplicate-titles": "2a3166bf5cc0096f4cb736fa0c6df3e5dfd973ab32f8fc6daaac8880b57691de",
  "failed-auth": "9e5b005b0bfd6c1b656bcd78dc4dfb8940862876ae650907377e3f9ac7cd4f94",
  "feature-mission-labels": "6e7636a6202b887b6f729a8de3466d5c1abc25fab1fdc111e0c4d40d878b694d",
  "feature-review-unfinished-note": "b40647c5af97b1b0c1088116841fcc0ae728785eb33a2b2aa369cd178b2b72b7",
  "final-review-blocking": "e32dd9b77c0deeb34f319b8f01eb14ee49d1b1436395a102f705193d1e38a2a2",
  "final-review-unfinished": "d34d95213c8d7c6ead3830e45e3e8c6a2e751af17af494ab2e27b61d3c449c42",
  "final-verify-red": "da27b3f1db74a388e67125e9931dbabc01ac5d8e31d8bf65dceb3c6c0b5361a0",
  "finalize-cut-off": "5f2eb230279263234881a924584897cbf56a2982278a68c32639dc28754ad0e9",
  "hostile-strings": "f4416b8f69a77156329b2c7004aa6279c2c89fa065f0e141b0953573f1e5d8d0",
  "limit-then-done": "73e43a7cc3da33d258c9403de49e9464d760b65ec54243ab991675fae4e14228",
  "limit-waiting": "0e4dfaf23e4af06173f1fa40f9c82a35ab951eb6f237dcb62ea919f2335ee163",
  "login-wait": "7e9f04c3abfb8f9f7f1d0927f180a05e927370407e19a54b74d824e0747ff430",
  "midrun-building": "934dcf7333c35b1026fe977f6f92225639030c85ddfa84f6797491253827f0e4",
  "midrun-reviewing": "c5a908c1557218798766ba76c08a03d3059dbf49efdb9a9811918fefec5871f3",
  "midrun-testing": "387fbe03cca1764f069a146b8b02e83c8fefb9ab015544ee0b5dae5a26852038",
  "multi-mission": "23a768072f368cfe0a868f020de3bc71fe6c71a6755b3a06058a6f8317b78cdc",
  "no-mission-json": "3b7b1df6b9f67a841d6051beb5f6f7415faf48094850afe1b2813a2e5b17073c",
  "old-dispatch-no-reviewed": "97e94e2c374d06f6f60210e066eacb63b4655043a964809ae450377eda8e179e",
  "partial-blocked": "3985de1e7bf564ce406b30dcafb018d366eed9f9b20ed235737afba1353b628b",
  "paused-ai-failing": "142c188b7b6b56999bb29eae2aaf7d79254701226e42beb92cef752a559c910b",
  "paused-deadline": "ef5eb359ad4bceda095836f0570845b3217c56f7da25fa5f66a0267eb52abb2a",
  "paused-disk": "7f77f5591768a3d9a51cd553f922a190261c0c1c34a8939fb45445736632f04b",
  "paused-stop": "b395a436abdb209b6920621341b89c3a701aa607a3feb25a36bcdd3c69a0f749",
  "quota-corrupt": "dbb0ed345681b82e1ef6d463ed6fe450c466dc5c8c8470ae4f826a5063415899",
  "quota-expired": "b715855e00d3055f0cfe122cd9dfd3f747b33eb811530f5087222838b589fe30",
  "quota-limited": "c6eba227162679d637e8cf00d51e462cf274dbaa0fca35249b9da727274d0e0e",
  "quota-nearly-out": "29ac9dab6ee7ac4438bb9aa419d79fac19a9de91eddc4d374a59f52131301ae8",
  "quota-overage": "ed4140bf85b84c98611147c5f440c0269738640616e2333700fac19852a51bff",
  "quota-paced": "f9cc8ec5f8071b5d7b54dd497c718664af1201ac806cf461ca8acd08bea4c3d6",
  "quota-readings": "b81c870345ca820297227050c06d84cb59dc32f6e850aaa3c1f9c5431ea396d3",
  "recovered": "c0dddd694912db4a0b5221c8cf94f639788029714789cd487cc49cbdff85b134",
  "repair-lap": "e0c16422a5a0c6baee1c824a3ba97d3ca252406375418c362622982bd649585b",
  "restart-midnight": "89e00be36f73002a82864bc8b66edadaf043126dbaa1fa700a9eeb58b0d4b599",
  "scope-mix": "e7ad8060083295ebdd0341e76bd20c48b17b4179114a9b54f9eb96cc72a57dee",
  "stale-busy-under-live-run": "f7983f8218b2edf662227e61bddf92cf2e1f09997cf887dd5903ac9d24cc2d5f",
  "trouble-wait": "76fbc2877b83f154feebf00411849ae8f5ec00b73def4f928387863113d89fc3",
  "unknown-status": "f2b19da5e291d6a741a43d6837ea5ddb47fc895ce91597d9d19af439d8acde93",
  "unknown-wait": "272bb9dc4ddba874e8f994c4c4c3cc64287a86b1eaccad47aed325df895e4936",
  "unreadable-mission": "b876bc6431ba342fc1cfd9752202ea8f3c0a0075a1a7489caea33645b81a0d6b",
  "waiting-then-running": "de28bd8b533ee167d8fbc0be504b93d15c35eda0d0ecc76327f6c1c462ec2034",
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("T-MODES-COMPAT: the fixtures that have no mode render as before", () => {
  it("lists only fixtures that exist, and the three modes-* fixtures are not among them", () => {
    const names = fixtureNames();
    for (const name of Object.keys(WAVE_1)) expect(names, name).toContain(name);
    expect(Object.keys(WAVE_1).filter((n) => n.startsWith("modes-"))).toEqual([]);
  });

  it.each(Object.entries(WAVE_1))("%s", (name, hash) => {
    expect(sha(JSON.stringify(fixtureSnapshot(name)))).toBe(hash);
  });

  it("no snapshot of them holds a key or a sentence that only a mission with a mode feature may have", () => {
    for (const name of Object.keys(WAVE_1)) {
      const json = JSON.stringify(fixtureSnapshot(name));
      expect(json, name).not.toContain("checkedBy");
      expect(json, name).not.toMatch(/second AI against your list|approved by you|queued without a stop/);
    }
  });
});
