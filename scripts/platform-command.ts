import { platform } from "node:os";

export function commandInvocation(file: string, args: string[]) {
  if (platform() !== "win32") return { file, args };
  if (file.toLowerCase().endsWith(".js"))
    return { file: process.execPath, args: [file, ...args] };
  const quote = (value: string) => `"${value.replace(/["^]/g, "^$&")}"`;
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [file, ...args].map(quote).join(" ")],
  };
}
