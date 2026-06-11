import assert from "node:assert/strict";
import test from "node:test";
import { resolveProfilePromptPayload } from "../../lib/profile-setup-prompt";

test("profile prompt save paths resolve activate, customise, disable, and untouched", () => {
  const recommended: Record<string, string> = {
    LOCATION: "not_linked",
    CONTACTS: "not_collected",
  };
  const customised: Record<string, string> = { LOCATION: "linked" };

  assert.deepEqual(
    resolveProfilePromptPayload("activate", customised, recommended),
    recommended
  );
  assert.deepEqual(
    resolveProfilePromptPayload("customise", customised, recommended),
    customised
  );
  assert.equal(resolveProfilePromptPayload("customise", {}, recommended), null);
  assert.equal(
    resolveProfilePromptPayload("disable", customised, recommended),
    null
  );
  assert.equal(
    resolveProfilePromptPayload(null, customised, recommended),
    undefined
  );
});
