import { AppShell, boot } from "./ui/app";

export function main(): boolean {
  return boot(new AppShell());
}
