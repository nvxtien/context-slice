import { platform } from "node:os";

export function commandInvocation(file: string, args: string[]) {
  if (platform() !== "win32")
    return { file, args, windowsVerbatimArguments: undefined };
  if (file.toLowerCase().endsWith(".js"))
    return {
      file: process.execPath,
      args: [file, ...args],
      windowsVerbatimArguments: undefined,
    };
  const quote = (value: string) => `"${value.replace(/["^]/g, "^$&")}"`;
  const commandLine = [file, ...args].map(quote).join(" ");
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    // cmd /s strips only the outermost quote pair of the whole /c string,
    // so the per-token quotes above must be wrapped in one more pair or
    // cmd strips the quotes around the executable path instead.
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    // Node re-quotes argv by default, which mangles the quotes already
    // built into the /c string above; verbatim mode passes it through as-is.
    windowsVerbatimArguments: true,
  };
}
