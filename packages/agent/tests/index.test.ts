import { describe, expect, it } from "vitest";
import * as agent from "../src/index.js";

describe("@hermests/agent barrel", () => {
  it("exports the documented public surface from stream-diag", () => {
    expect(agent).toBeDefined();

    expect(Array.isArray(agent.STREAM_DIAG_HEADERS)).toBe(true);
    expect(agent.STREAM_DIAG_HEADERS).toContain("cf-ray");

    expect(typeof agent.stream_diag_init).toBe("function");
    expect(typeof agent.stream_diag_capture_response).toBe("function");
    expect(typeof agent.flatten_exception_chain).toBe("function");
    expect(typeof agent.log_stream_retry).toBe("function");
    expect(typeof agent.emit_stream_drop).toBe("function");

    expect(typeof agent.setStreamDiagLogger).toBe("function");
    expect(typeof agent._resetStreamDiagLogger).toBe("function");
    expect(typeof agent.setStreamDiagClock).toBe("function");
    expect(typeof agent._resetStreamDiagClock).toBe("function");

    expect(typeof agent._consoleWarning).toBe("function");
    expect(typeof agent._consoleDebug).toBe("function");
    expect(typeof agent._renderPrintf).toBe("function");
  });
});
