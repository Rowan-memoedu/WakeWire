import { describe, expect, it } from "vitest";
import type { GithubMaintenanceClient } from "./github-maintenance.js";
import type { MaintenanceConfig } from "./maintenance-types.js";
import { verifyRepositories } from "./remnote-maintenance-cli.js";

describe("maintenance repository validation", () => {
  const config = {
    execution: "native",
    hub: "owner/hub",
    bindings: [{ repository: "owner/source" }],
  } as MaintenanceConfig;
  function github(overrides: Record<string, unknown> = {}) {
    return {
      async request(endpoint: string) {
        if (endpoint === "user") return { login: "owner" };
        const repository = endpoint.slice("repos/".length);
        return {
          full_name: repository,
          private: repository === config.hub,
          archived: false,
          default_branch: "main",
          ...(repository === "owner/source" ? overrides : {}),
        };
      },
    } as unknown as GithubMaintenanceClient;
  }
  it("accepts an owned public source for native execution", async () => {
    expect((await verifyRepositories(config, github(), true)).get("owner/source")).toBe("main");
  });
  it("retains the private-source boundary for legacy Actions execution", async () => {
    await expect(
      verifyRepositories({ ...config, execution: "actions" }, github(), true),
    ).rejects.toThrow("authorized source");
  });
  it.each([{ archived: true }, { full_name: "other/source" }])(
    "rejects an archived or transferred source",
    async (overrides) => {
      await expect(verifyRepositories(config, github(overrides), true)).rejects.toThrow(
        "authorized source",
      );
    },
  );
});
