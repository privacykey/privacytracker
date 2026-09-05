import { spawn } from "node:child_process";
import { createRequire } from "node:module";

// Always give Next an explicit bind and report that SAME bind to the guards.
// The last hostname option wins, including when an operator overrides -H.
const [command, ...args] = process.argv.slice(2);
let bindHost = process.env.PRIVACYTRACKER_BIND_HOST || "127.0.0.1";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "-H" || args[i] === "--hostname") {
    if (!args[i + 1] || args[i + 1].startsWith("-")) {
      throw new Error("Missing hostname argument");
    }
    bindHost = args[++i];
  } else if (args[i].startsWith("--hostname=")) {
    bindHost = args[i].slice("--hostname=".length);
  }
}
if (!bindHost) {
  throw new Error("Hostname must not be empty");
}
const require = createRequire(import.meta.url);
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    command,
    ...args,
    "--hostname",
    bindHost,
  ],
  {
    stdio: "inherit",
    env: { ...process.env, PRIVACYTRACKER_BIND_HOST: bindHost },
  }
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
