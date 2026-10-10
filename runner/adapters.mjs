/**
 * Agent adapters — Relay is agent-agnostic: any CLI coding agent with a
 * headless mode can be plugged in. Each adapter maps (prompt, workdir) to a
 * spawned process. The runner never trusts the agent to push; the runner owns
 * commit, notes and push.
 */
export const adapters = {
  zcode: {
    label: "ZCode (GLM)",
    cmd: "node",
    args: (prompt) => [
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      "-p",
      prompt,
    ],
    timeoutMs: 30 * 60 * 1000,
  },
  claude: {
    label: "Claude Code",
    cmd: "claude",
    args: (prompt) => [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
    ],
    timeoutMs: 30 * 60 * 1000,
  },
  codebuddy: {
    label: "CodeBuddy (Tencent)",
    cmd: "codebuddy",
    args: (prompt) => ["-p", prompt, "--dangerously-skip-permissions"],
    timeoutMs: 30 * 60 * 1000,
  },
  dsh: {
    label: "DeepSeek CLI",
    cmd: "dsh",
    args: (prompt) => ["-p", prompt],
    timeoutMs: 30 * 60 * 1000,
  },
};
