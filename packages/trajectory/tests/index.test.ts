import { describe, expect, it } from "vitest";
import * as trajectory from "../src/index.js";

describe("@hermests/trajectory barrel", () => {
  it("exports the documented public surface", () => {
    expect(trajectory).toBeDefined();

    expect(typeof trajectory.OMIT_TEMPERATURE).toBe("symbol");

    expect(typeof trajectory.jitteredBackoff).toBe("function");
    expect(typeof trajectory._resetJitterCounter).toBe("function");
    expect(typeof trajectory.defaultSleep).toBe("function");

    expect(typeof trajectory.CompressionConfig).toBe("function");

    expect(typeof trajectory.TrajectoryMetrics).toBe("function");
    expect(typeof trajectory.AggregateMetrics).toBe("function");

    expect(typeof trajectory.detectProvider).toBe("function");

    expect(typeof trajectory.TrajectoryCompressor).toBe("function");

    expect(typeof trajectory.processDirectory).toBe("function");
    expect(typeof trajectory.runCli).toBe("function");
    expect(typeof trajectory.TimeoutError).toBe("function");
    expect(typeof trajectory.withTimeout).toBe("function");

    expect(trajectory.REPORT_TITLE).toBe("TRAJECTORY COMPRESSION REPORT");
    expect(typeof trajectory.formatCompressionReport).toBe("function");
    expect(typeof trajectory.printCompressionReport).toBe("function");
  });
});
