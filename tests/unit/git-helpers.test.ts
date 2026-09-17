import { describe, expect, it } from "vitest";
import { getProjectSlug } from "../../extensions/git-helpers";
import { useIntegrationHarness } from "../helpers/integration";

describe("getProjectSlug", () => {
  const harness = useIntegrationHarness();

  it("derives from git remote with sanitization, else basename fallback", () => {
    const gitUrlQueue = harness.state.gitUrlQueue;
    gitUrlQueue.push(
      "git@github.com:misiekhardcore/My_Repo.git\n",
      "https://github.com/owner/repo-name.git\n",
      "git@github.com:owner/repo.git\n",
    );
    expect(getProjectSlug("/tmp/cwd")).toBe("my-repo");
    expect(getProjectSlug("/tmp/cwd")).toBe("repo-name");
    expect(getProjectSlug("/tmp/cwd")).toBe("repo");
    // Queue exhausted → falls back to directory name.
    expect(getProjectSlug("/tmp/My Dir")).toBe("my-dir");
    expect(getProjectSlug("/tmp/My.Dir_1")).toBe("my-dir-1");
    expect(getProjectSlug("/")).toBe("unknown");
  });
});
